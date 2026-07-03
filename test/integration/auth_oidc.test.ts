// Full OIDC coverage. We configure the GOOGLE provider on the test env and drive the begin +
// callback flows, stubbing the provider's discovery/token/JWKS endpoints and signing a real RS256
// id_token so the callback's happy path (verifyIdToken → user upsert → session) actually runs.
import { SELF, env } from "cloudflare:test";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { authPost, resetDb } from "./helpers";

type KeyPair = Awaited<ReturnType<typeof generateKeyPair>>;

const DISCOVERY = {
  authorization_endpoint: "https://accounts.google.com/o/oauth2/v2/auth",
  token_endpoint: "https://oauth2.googleapis.com/token",
  jwks_uri: "https://www.googleapis.com/oauth2/v3/certs",
  issuer: "https://accounts.google.com",
};
const CLIENT_ID = "test-client-id";

let privateKey: KeyPair["privateKey"];
let jwk: Record<string, unknown>;

beforeAll(async () => {
  env.GOOGLE_OIDC_CLIENT_ID = CLIENT_ID;
  env.GOOGLE_OIDC_CLIENT_SECRET = "test-secret";
  const pair = await generateKeyPair("RS256", { extractable: true });
  privateKey = pair.privateKey;
  jwk = { ...(await exportJWK(pair.publicKey)), kid: "test-kid", alg: "RS256", use: "sig" };
});

afterAll(() => {
  env.GOOGLE_OIDC_CLIENT_ID = undefined;
  env.GOOGLE_OIDC_CLIENT_SECRET = undefined;
});

afterEach(() => vi.unstubAllGlobals());

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });

/** Route the provider's three endpoints; `idToken` is returned from the token endpoint. */
function stubProvider(idToken: string, opts: { tokenStatus?: number; idToken?: boolean } = {}) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes("/.well-known/openid-configuration")) return json(DISCOVERY);
      if (url === DISCOVERY.jwks_uri) return json({ keys: [jwk] });
      if (url === DISCOVERY.token_endpoint) {
        if (opts.tokenStatus && opts.tokenStatus !== 200) return new Response("{}", { status: opts.tokenStatus });
        return json({ access_token: "at", ...(opts.idToken === false ? {} : { id_token: idToken }) });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }),
  );
}

async function signIdToken(claims: { sub: string; email: string; email_verified?: boolean; name?: string; nonce: string }) {
  return new SignJWT({
    email: claims.email,
    email_verified: claims.email_verified ?? true,
    name: claims.name,
    nonce: claims.nonce,
  })
    .setProtectedHeader({ alg: "RS256", kid: "test-kid" })
    .setSubject(claims.sub)
    .setAudience(CLIENT_ID)
    .setIssuer(DISCOVERY.issuer)
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(privateKey);
}

/** A signed state cookie matching what the begin step sets. */
async function stateCookie(state: string, nonce: string) {
  const jwt = await new SignJWT({ state, nonce, provider: "GOOGLE" })
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime("10m")
    .sign(new TextEncoder().encode(env.APP_AUTH_SECRET));
  return `sm_oidc=${jwt}`;
}

const callback = (query: string, cookie?: string) =>
  SELF.fetch(`http://smplmark.test/api/v1/auth/callback/google?${query}`, {
    redirect: "manual",
    headers: cookie ? { Cookie: cookie } : {},
  });

describe("OIDC begin", () => {
  it("redirects to the provider and sets a state cookie", async () => {
    stubProvider("unused");
    const res = await SELF.fetch("http://smplmark.test/api/v1/auth/oidc/google", { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toContain("accounts.google.com");
    expect(res.headers.get("Set-Cookie")).toContain("sm_oidc=");
  });
});

describe("OIDC callback — success", () => {
  it("creates a new user + account and redirects with a token in the fragment", async () => {
    await resetDb();
    stubProvider(await signIdToken({ sub: "goog-1", email: "newoidc@example.com", name: "OIDC User", nonce: "n1" }));
    const res = await callback("code=abc&state=s1", await stateCookie("s1", "n1"));
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toContain("/auth/callback#token=");

    const user = await env.DB.prepare("SELECT email_verified FROM user WHERE email = ?")
      .bind("newoidc@example.com")
      .first<{ email_verified: number }>();
    expect(user?.email_verified).toBe(1);
  });

  it("links a new provider identity to an existing (password) user by email", async () => {
    await resetDb();
    await authPost("/api/v1/auth/register", { email: "link@example.com", password: "correct horse battery" });
    stubProvider(await signIdToken({ sub: "goog-2", email: "link@example.com", nonce: "n2" }));
    const res = await callback("code=abc&state=s2", await stateCookie("s2", "n2"));
    expect(res.status).toBe(302);
    const identities = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM user_identity ui JOIN user u ON u.id = ui.user_id WHERE u.email = ?",
    )
      .bind("link@example.com")
      .first<{ n: number }>();
    expect(identities?.n).toBe(2); // PASSWORD + GOOGLE
  });

  it("re-logs an existing (provider, subject) identity", async () => {
    await resetDb();
    const idToken = await signIdToken({ sub: "goog-3", email: "repeat@example.com", nonce: "n3" });
    stubProvider(idToken);
    expect((await callback("code=abc&state=s3", await stateCookie("s3", "n3"))).status).toBe(302);
    stubProvider(await signIdToken({ sub: "goog-3", email: "repeat@example.com", nonce: "n4" }));
    expect((await callback("code=abc&state=s4", await stateCookie("s4", "n4"))).status).toBe(302);
    const users = await env.DB.prepare("SELECT COUNT(*) AS n FROM user WHERE email = ?")
      .bind("repeat@example.com")
      .first<{ n: number }>();
    expect(users?.n).toBe(1);
  });
});

describe("OIDC callback — failures redirect with auth_error", () => {
  it("no cookie / error param / state mismatch / bad exchange / no id_token", async () => {
    await resetDb();
    stubProvider("unused");
    expect((await callback("code=abc&state=s")).headers.get("Location")).toContain("auth_error");
    expect(
      (await callback("error=access_denied&state=s", await stateCookie("s", "n"))).headers.get("Location"),
    ).toContain("auth_error");
    expect(
      (await callback("code=abc&state=WRONG", await stateCookie("s", "n"))).headers.get("Location"),
    ).toContain("auth_error");

    // A garbage cookie fails verification.
    expect((await callback("code=abc&state=s", "sm_oidc=garbage")).headers.get("Location")).toContain("auth_error");

    // Token endpoint failure.
    stubProvider("unused", { tokenStatus: 400 });
    expect(
      (await callback("code=abc&state=s5", await stateCookie("s5", "n5"))).headers.get("Location"),
    ).toContain("auth_error");

    // Token response without an id_token.
    stubProvider("unused", { idToken: false });
    expect(
      (await callback("code=abc&state=s6", await stateCookie("s6", "n6"))).headers.get("Location"),
    ).toContain("auth_error");
  });
});
