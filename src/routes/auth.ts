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
  devLoginEnabled,
  oidcClient,
  oidcConfigured,
  requireAuthSecret,
} from "../config";
import { getAccountById } from "../data/accounts";
import { createMembership, getMembership, getPrimaryMembershipForUser } from "../data/account_users";
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
import { sendNewAccountNotification, sendVerificationEmail } from "../email/resend";
import { BadRequestError, NotFoundError, ServiceUnavailableError, UnauthorizedError } from "../errors";
import { getAuth, requireAuth, type AppBindings } from "../http/middleware";
import { rateLimit } from "../http/ratelimit";
import { ensureActiveAccount, provisionAccountForUser } from "../services/provision";
import { startSession, type IssuedSession } from "../services/session";
import { ROLES } from "../types";
import type { AccountRow, Provider, Role, UserRow } from "../types";
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
  await sendNewAccountNotification(c.env, {
    userEmail: user.email,
    userName: user.display_name,
    accountName: account.name,
    accountKey: account.key,
    signupMethod: "Email + password",
  });

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
  // A user should always land in a workspace; if their only account was deleted, hand them a fresh
  // one rather than locking them out (see ensureActiveAccount).
  const { account, role } = await ensureActiveAccount(c.env.DB, user);
  const session = await startSession(
    c.env,
    c.env.DB,
    appUrl(c.env, c.req.url),
    user,
    account,
    role,
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

// ── Local-dev auto-login (no SSO) ────────────────────────────────────────────
// Gated on DEV_LOGIN (a .dev.vars-only flag); the route 404s in production. Mirrors the app repo's
// local bypass: skip the IdP round-trip and lazily bootstrap a canonical dev tenant.

// One seeded user per role, all in the same local dev account, so a developer can test-drive the
// console as each role via the user switcher. The OWNER is the account creator; the rest are members.
const DEV_USERS: { email: string; display_name: string; role: Role }[] = [
  { email: "dev@localhost", display_name: "Local Dev", role: "OWNER" },
  { email: "admin@localhost", display_name: "Ada Admin", role: "ADMIN" },
  { email: "member@localhost", display_name: "Marcus Member", role: "MEMBER" },
  { email: "viewer@localhost", display_name: "Vera Viewer", role: "VIEWER" },
];
const DEV_OWNER = DEV_USERS[0];

/** Parse the optional ?role= param on /dev-login into a seeded role (defaults to OWNER). */
function parseDevRole(raw: string | undefined): Role {
  const up = (raw || "OWNER").toUpperCase();
  return (ROLES as readonly string[]).includes(up) ? (up as Role) : "OWNER";
}

/**
 * Get-or-create the local dev tenant — the OWNER + account and one member per other role — and start a
 * session for the requested role's user. Idempotent: repeated dev-logins reuse the same users/account.
 * Personal publishing is on so a developer can create AND publish locally without domain verification.
 */
async function startDevSession(env: Env, db: D1Database, origin: string, role: Role): Promise<IssuedSession> {
  // The OWNER owns the account; create both on first run.
  let owner = await getUserByEmail(db, DEV_OWNER.email);
  let account: AccountRow | null;
  if (!owner) {
    owner = await createUser(db, { email: DEV_OWNER.email, display_name: DEV_OWNER.display_name, email_verified: true });
    account = await provisionAccountForUser(db, owner);
  } else {
    const membership = await getPrimaryMembershipForUser(db, owner.id);
    account = membership ? await getAccountById(db, membership.account_id) : null;
    // If the dev account was deleted (or never provisioned), start a fresh tenant so first-run flows
    // (like the welcome wizard) can be re-experienced after a Delete-account.
    if (!account) account = await provisionAccountForUser(db, owner);
  }
  // Idempotently seed the other roles as members of the dev account.
  for (const spec of DEV_USERS) {
    if (spec.role === "OWNER") continue;
    let u = await getUserByEmail(db, spec.email);
    if (!u) u = await createUser(db, { email: spec.email, display_name: spec.display_name, email_verified: true });
    if (!(await getMembership(db, account.id, u.id))) {
      await createMembership(db, { account_id: account.id, user_id: u.id, role: spec.role });
    }
  }
  // Idempotently enable personal publishing so create-then-publish works with no domain to verify.
  await db.prepare("UPDATE account SET allow_personal_publish = 1 WHERE id = ?").bind(account.id).run();

  const spec = DEV_USERS.find((d) => d.role === role) ?? DEV_OWNER;
  const sessionUser = await getUserByEmail(db, spec.email);
  if (!sessionUser) throw new Error("The local dev user is missing.");
  return startSession(env, db, origin, sessionUser, account, spec.role, Date.now());
}

// GET (not POST): the developer navigates here in a browser and lands in the console, hand-off via
// the same /auth/callback#token fragment the OIDC flow uses. `?role=` picks which seeded dev user to
// sign in as (the user switcher uses it); default is OWNER.
auth.get("/dev-login", async (c) => {
  if (!devLoginEnabled(c.env)) throw new NotFoundError();
  const origin = appUrl(c.env, c.req.url);
  const session = await startDevSession(c.env, c.env.DB, origin, parseDevRole(c.req.query("role")));
  return c.redirect(
    `${origin}/auth/callback#token=${encodeURIComponent(session.token)}&expires_in=${session.expires_in}`,
    302,
  );
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
    if (!tokens.id_token) {
      console.error(`OIDC ${provider} callback: token response had no id_token`);
      return fail("Sign-in failed. Please try again.");
    }
    profile = await verifyIdToken(discovery, client, provider, tokens.id_token, flow.nonce);
  } catch (err) {
    // Token exchange or id_token verification failed. Log the reason — an exchange-failure body
    // carries no tokens, a verify failure carries only the jose message — so the otherwise-opaque
    // "Sign-in failed" is diagnosable in `wrangler tail`.
    console.error(`OIDC ${provider} callback: token exchange / id_token verification failed:`, err);
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
      const newAccount = await provisionAccountForUser(c.env.DB, created);
      await sendNewAccountNotification(c.env, {
        userEmail: created.email,
        userName: created.display_name,
        accountName: newAccount.name,
        accountKey: newAccount.key,
        signupMethod: provider === "GOOGLE" ? "Google" : "Microsoft",
      });
      user = created;
    }
  }
  if (!user) {
    console.error(`OIDC ${provider} callback: no user resolved after identity upsert`);
    return fail("Sign-in failed. Please try again.");
  }

  // A returning user whose only account was deleted still resolves here; ensureActiveAccount hands
  // them a fresh workspace instead of dead-ending at the membership check.
  const { account, role } = await ensureActiveAccount(c.env.DB, user);
  const session = await startSession(c.env, c.env.DB, origin, user, account, role, Date.now());
  // Frontend reads the token from the URL fragment (never sent to the server / logged).
  return c.redirect(
    `${origin}/auth/callback#token=${encodeURIComponent(session.token)}&expires_in=${session.expires_in}`,
    302,
  );
});
