import { SELF, env } from "cloudflare:test";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { makeBenchmark, publish, resetDb } from "./helpers";

// The local-dev auto-login (config.devLoginEnabled / routes/auth dev-login). Enabled here by setting
// env.DEV_LOGIN — vitest.config blanks it by default, so the rest of the suite (and prod) is off.
const BASE = "http://smplmark.test";

function tokenFromRedirect(location: string | null): string {
  expect(location).toBeTruthy();
  const hash = new URL(location as string).hash.replace(/^#/, "");
  const token = new URLSearchParams(hash).get("token");
  expect(token).toBeTruthy();
  return token as string;
}

describe("local dev auto-login", () => {
  beforeAll(() => {
    env.DEV_LOGIN = "1";
  });
  afterAll(() => {
    env.DEV_LOGIN = undefined;
  });
  beforeEach(resetDb);

  it("lazily creates one dev account + session and reuses it on repeat, with personal publishing on", async () => {
    const r1 = await SELF.fetch(`${BASE}/api/v1/auth/dev-login`, { redirect: "manual" });
    expect(r1.status).toBe(302);
    // Hand-off is the same /auth/callback#token fragment the OIDC flow uses.
    const loc = r1.headers.get("location");
    expect(loc).toContain("/auth/callback#token=");
    tokenFromRedirect(loc);

    // A second dev-login reuses the same user/account — not one-per-hit.
    const r2 = await SELF.fetch(`${BASE}/api/v1/auth/dev-login`, { redirect: "manual" });
    expect(r2.status).toBe(302);

    const users = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM user WHERE email = 'dev@localhost'",
    ).first<{ n: number }>();
    expect(users?.n).toBe(1);
    const accounts = await env.DB.prepare("SELECT COUNT(*) AS n FROM account").first<{ n: number }>();
    expect(accounts?.n).toBe(1);
    const acct = await env.DB.prepare(
      "SELECT allow_personal_publish AS v FROM account",
    ).first<{ v: number }>();
    expect(acct?.v).toBe(1); // create-then-publish works locally with no domain to verify
  });

  it("the dev session can create AND publish a benchmark", async () => {
    const r = await SELF.fetch(`${BASE}/api/v1/auth/dev-login`, { redirect: "manual" });
    const token = tokenFromRedirect(r.headers.get("location"));
    const devUser = await env.DB.prepare(
      "SELECT id FROM user WHERE email = 'dev@localhost'",
    ).first<{ id: string }>();
    expect(devUser).toBeTruthy();

    const bench = await makeBenchmark(token, { key: "dev-bench" });
    const published = await publish(token, devUser!.id, bench.id);
    expect(published.attributes.status).toBe("PUBLISHED");
  });

  it("the root auto-redirects a signed-out visitor to dev-login in dev mode", async () => {
    const res = await SELF.fetch(`${BASE}/`, { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("/api/v1/auth/dev-login");
  });

  it("404s the dev-login endpoint when DEV_LOGIN is not set (production safety)", async () => {
    env.DEV_LOGIN = undefined;
    try {
      const res = await SELF.fetch(`${BASE}/api/v1/auth/dev-login`, { redirect: "manual" });
      expect(res.status).toBe(404);
    } finally {
      env.DEV_LOGIN = "1";
    }
  });
});
