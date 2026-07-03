// Authentication endpoints (non-resource, plain application/json). Password register/login, email
// verification + resend, logout, and Google/Microsoft OIDC. Adapted from smplkit's flow; see
// auth/oidc.ts and auth/jwt.ts. Anti-enumeration: login returns one fixed message for any failure.
import { Hono } from "hono";
import { SignJWT, jwtVerify } from "jose";
import { getCookie, setCookie } from "hono/cookie";
import { hashPassword, randomToken, sha256Hex, verifyPassword } from "../auth/crypto";
import {
  buildAuthorizationUrl,
  discover,
  exchangeCode,
  verifyIdToken,
} from "../auth/oidc";
import {
  EMAIL_VERIFICATION_TTL_MS,
  appUrl,
  oidcClient,
  oidcConfigured,
  requireAuthSecret,
} from "../config";
import { getAccountById } from "../data/accounts";
import { getMembership, getPrimaryMembershipForUser } from "../data/account_users";
import {
  createIdentity,
  getIdentityByProviderSubject,
  getPasswordIdentity,
} from "../data/identities";
import { deleteSession } from "../data/sessions";
import {
  createUser,
  getUserByEmail,
  getUserById,
  setEmailVerified,
} from "../data/users";
import { createVerification, consumeVerification } from "../data/verifications";
import { sendVerificationEmail } from "../email/resend";
import { BadRequestError, NotFoundError, ServiceUnavailableError, UnauthorizedError } from "../errors";
import { getAuth, requireAuth, type AppBindings } from "../http/middleware";
import { rateLimit } from "../http/ratelimit";
import { provisionAccountForUser } from "../services/provision";
import { startSession } from "../services/session";
import type { Provider, UserRow } from "../types";
import { readJsonObject } from "./shared";

export const auth = new Hono<AppBindings>();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const LOGIN_FAILED = "Invalid email or password.";
const OIDC_COOKIE = "sm_oidc";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function requireEmail(obj: Record<string, unknown>): string {
  const v = obj.email;
  if (typeof v !== "string" || !EMAIL_RE.test(v)) {
    throw new BadRequestError("A valid email is required.", {
      pointer: "/email",
    });
  }
  return v;
}

function requirePassword(obj: Record<string, unknown>): string {
  const v = obj.password;
  if (typeof v !== "string" || v.length < 8 || v.length > 128) {
    throw new BadRequestError("password must be between 8 and 128 characters.", {
      pointer: "/password",
    });
  }
  return v;
}

/** Create + email a verification token (best-effort send). */
async function issueVerification(env: Env, db: D1Database, user: UserRow, origin: string): Promise<void> {
  const token = randomToken(32);
  const tokenHash = await sha256Hex(token);
  await createVerification(db, {
    user_id: user.id,
    token_hash: tokenHash,
    expires_at: Date.now() + EMAIL_VERIFICATION_TTL_MS,
  });
  const verifyUrl = `${origin}/verify-email?token=${encodeURIComponent(token)}`;
  await sendVerificationEmail(env, {
    to: user.email,
    verifyUrl,
    displayName: user.display_name,
  });
}

auth.post("/register", rateLimit((e) => e.RL_SENSITIVE), async (c) => {
  const body = await readJsonObject(c);
  const email = requireEmail(body);
  const password = requirePassword(body);
  const displayName =
    typeof body.display_name === "string" && body.display_name.length > 0
      ? body.display_name
      : null;

  if (await getUserByEmail(c.env.DB, email)) {
    // A generic 409 (createUser would also catch the unique violation).
    throw new BadRequestError("An account with this email already exists.", {
      pointer: "/email",
    });
  }

  const user = await createUser(c.env.DB, {
    email,
    display_name: displayName,
    email_verified: false,
  });
  await createIdentity(c.env.DB, {
    user_id: user.id,
    provider: "PASSWORD",
    provider_subject: null,
    password_hash: await hashPassword(password),
  });
  const account = await provisionAccountForUser(c.env.DB, user);
  await issueVerification(c.env, c.env.DB, user, appUrl(c.env, c.req.url));

  const session = await startSession(
    c.env,
    c.env.DB,
    appUrl(c.env, c.req.url),
    user,
    account,
    "OWNER",
    Date.now(),
  );
  return jsonResponse({ ...session, verified: false }, 201);
});

auth.post("/login", rateLimit((e) => e.RL_AUTH), async (c) => {
  const body = await readJsonObject(c);
  const email = requireEmail(body);
  const password =
    typeof body.password === "string" ? body.password : "";

  const user = await getUserByEmail(c.env.DB, email);
  if (!user) throw new UnauthorizedError(LOGIN_FAILED);
  const identity = await getPasswordIdentity(c.env.DB, user.id);
  if (!identity || identity.password_hash === null) {
    throw new UnauthorizedError(LOGIN_FAILED);
  }
  if (!(await verifyPassword(password, identity.password_hash))) {
    throw new UnauthorizedError(LOGIN_FAILED);
  }
  const membership = await getPrimaryMembershipForUser(c.env.DB, user.id);
  const account = membership ? await getAccountById(c.env.DB, membership.account_id) : null;
  if (!account || !membership) {
    // A user should always have an account; treat a missing one as a server issue.
    throw new UnauthorizedError(LOGIN_FAILED);
  }
  const session = await startSession(
    c.env,
    c.env.DB,
    appUrl(c.env, c.req.url),
    user,
    account,
    membership.role,
    Date.now(),
  );
  return jsonResponse({ ...session, verified: user.email_verified === 1 });
});

auth.post("/verify-email", async (c) => {
  const body = await readJsonObject(c);
  const token = typeof body.token === "string" ? body.token : "";
  if (token.length === 0) {
    throw new BadRequestError("token is required.", { pointer: "/token" });
  }
  const userId = await consumeVerification(c.env.DB, await sha256Hex(token), Date.now());
  if (!userId) {
    throw new BadRequestError("The verification link is invalid or has expired.");
  }
  await setEmailVerified(c.env.DB, userId);
  return jsonResponse({ verified: true });
});

auth.post("/resend-verification", rateLimit((e) => e.RL_SENSITIVE), requireAuth, async (c) => {
  const auth_ = getAuth(c);
  if (!auth_.user_id) {
    throw new BadRequestError("This endpoint requires a session credential.");
  }
  const user = await getUserById(c.env.DB, auth_.user_id);
  if (user && user.email_verified === 0) {
    await issueVerification(c.env, c.env.DB, user, appUrl(c.env, c.req.url));
  }
  return jsonResponse({ ok: true });
});

auth.post("/logout", requireAuth, async (c) => {
  const auth_ = getAuth(c);
  if (auth_.session_id) {
    await deleteSession(c.env.DB, auth_.session_id);
  }
  return jsonResponse({ ok: true });
});

/** Switch the active account: re-mint a session for another account the caller is a member of. */
auth.post("/switch", requireAuth, async (c) => {
  const auth_ = getAuth(c);
  if (!auth_.user_id) {
    throw new BadRequestError("Switching accounts requires a session credential.");
  }
  const body = await readJsonObject(c);
  const accountId = typeof body.account_id === "string" ? body.account_id : "";
  if (accountId.length === 0) {
    throw new BadRequestError("account_id is required.", { pointer: "/account_id" });
  }
  const membership = await getMembership(c.env.DB, accountId, auth_.user_id);
  const account = membership ? await getAccountById(c.env.DB, accountId) : null;
  const user = await getUserById(c.env.DB, auth_.user_id);
  if (!membership || !account || !user) throw new NotFoundError();
  const session = await startSession(
    c.env,
    c.env.DB,
    appUrl(c.env, c.req.url),
    user,
    account,
    membership.role,
    Date.now(),
  );
  return jsonResponse({ ...session, verified: user.email_verified === 1 });
});

// ── OIDC ─────────────────────────────────────────────────────────────────────

function parseProvider(raw: string): Provider {
  const up = raw.toUpperCase();
  if (up === "GOOGLE" || up === "MICROSOFT") return up;
  throw new BadRequestError("Unknown OIDC provider.");
}

function callbackUri(origin: string, provider: Provider): string {
  return `${origin}/api/v1/auth/callback/${provider.toLowerCase()}`;
}

auth.get("/oidc/:provider", rateLimit((e) => e.RL_AUTH), async (c) => {
  const provider = parseProvider(c.req.param("provider"));
  const client = oidcClient(c.env, provider);
  if (!client || !oidcConfigured(c.env, provider)) {
    throw new ServiceUnavailableError(`${provider} sign-in is not configured.`);
  }
  const origin = appUrl(c.env, c.req.url);
  const state = randomToken(24);
  const nonce = randomToken(24);
  const discovery = await discover(client.discoveryUrl);
  const authUrl = buildAuthorizationUrl(discovery, client, {
    redirectUri: callbackUri(origin, provider),
    state,
    nonce,
  });

  // Bind state+nonce to the browser in a short-lived signed cookie (no server session store).
  const cookie = await new SignJWT({ state, nonce, provider })
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime("10m")
    .sign(new TextEncoder().encode(requireAuthSecret(c.env)));
  setCookie(c, OIDC_COOKIE, cookie, {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    path: "/api/v1/auth",
    maxAge: 600,
  });
  return c.redirect(authUrl, 302);
});

auth.get("/callback/:provider", async (c) => {
  const provider = parseProvider(c.req.param("provider"));
  const client = oidcClient(c.env, provider);
  const origin = appUrl(c.env, c.req.url);
  if (!client) throw new ServiceUnavailableError(`${provider} sign-in is not configured.`);

  const fail = (msg: string) => c.redirect(`${origin}/login?auth_error=${encodeURIComponent(msg)}`, 302);

  const cookie = getCookie(c, OIDC_COOKIE);
  if (!cookie) return fail("Sign-in session expired. Please try again.");
  let flow: { state: string; nonce: string; provider: string };
  try {
    const { payload } = await jwtVerify(cookie, new TextEncoder().encode(requireAuthSecret(c.env)));
    flow = payload as unknown as { state: string; nonce: string; provider: string };
  } catch {
    return fail("Sign-in session invalid. Please try again.");
  }

  const stateParam = c.req.query("state");
  const code = c.req.query("code");
  if (c.req.query("error") || !code) return fail("Sign-in was cancelled.");
  if (flow.provider !== provider || flow.state !== stateParam) {
    return fail("Sign-in verification failed. Please try again.");
  }

  let profile;
  try {
    const discovery = await discover(client.discoveryUrl);
    const tokens = await exchangeCode(discovery, client, {
      code,
      redirectUri: callbackUri(origin, provider),
    });
    if (!tokens.id_token) return fail("Sign-in failed. Please try again.");
    profile = await verifyIdToken(discovery, client, provider, tokens.id_token, flow.nonce);
  } catch {
    return fail("Sign-in failed. Please try again.");
  }

  // Upsert: match by (provider, subject); else link by email; else create + provision.
  let user: UserRow | null = null;
  const identity = await getIdentityByProviderSubject(c.env.DB, provider, profile.subject);
  if (identity) {
    user = await getUserById(c.env.DB, identity.user_id);
  } else {
    const existing = await getUserByEmail(c.env.DB, profile.email);
    if (existing) {
      await createIdentity(c.env.DB, {
        user_id: existing.id,
        provider,
        provider_subject: profile.subject,
        password_hash: null,
      });
      if (existing.email_verified === 0 && profile.email_verified) {
        await setEmailVerified(c.env.DB, existing.id);
        existing.email_verified = 1;
      }
      user = existing;
    } else {
      const created = await createUser(c.env.DB, {
        email: profile.email,
        display_name: profile.display_name,
        email_verified: profile.email_verified,
      });
      await createIdentity(c.env.DB, {
        user_id: created.id,
        provider,
        provider_subject: profile.subject,
        password_hash: null,
      });
      await provisionAccountForUser(c.env.DB, created);
      user = created;
    }
  }
  if (!user) return fail("Sign-in failed. Please try again.");

  const membership = await getPrimaryMembershipForUser(c.env.DB, user.id);
  const account = membership ? await getAccountById(c.env.DB, membership.account_id) : null;
  if (!account || !membership) return fail("Sign-in failed. Please try again.");

  const session = await startSession(c.env, c.env.DB, origin, user, account, membership.role, Date.now());
  // Frontend reads the token from the URL fragment (never sent to the server / logged).
  return c.redirect(
    `${origin}/auth/callback#token=${encodeURIComponent(session.token)}&expires_in=${session.expires_in}`,
    302,
  );
});
