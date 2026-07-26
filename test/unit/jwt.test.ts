import { env } from "cloudflare:test";
import { SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import { issueSessionToken, verifySessionToken } from "../../src/auth/jwt";
import { AppError } from "../../src/errors";

const claims = {
  sub: "u1",
  account_id: "a1",
  role: "OWNER" as const,
  email_verified: true,
  jti: "j1",
};

describe("session JWT", () => {
  it("round-trips issue → verify", async () => {
    const now = 1_800_000_000_000;
    const { token, expiresAt } = await issueSessionToken(env, "https://smplmark.test", claims, now);
    expect(expiresAt).toBeGreaterThan(now);
    const out = await verifySessionToken(env, token);
    expect(out).toEqual(claims);
  });

  it("rejects a token signed with a different secret", async () => {
    const bad = await new SignJWT({ account_id: "a1", role: "OWNER" })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject("u1")
      .setJti("j1")
      .setIssuer("https://smplmark.test")
      .setAudience("smplmark")
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(new TextEncoder().encode("a-totally-different-secret"));
    await expect(verifySessionToken(env, bad)).rejects.toBeInstanceOf(AppError);
  });

  it("rejects a validly-signed token with missing/invalid claims", async () => {
    const secret = new TextEncoder().encode(env.APP_AUTH_SECRET);
    const noAccount = await new SignJWT({ role: "OWNER" })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject("u1")
      .setJti("j1")
      .setAudience("smplmark")
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(secret);
    await expect(verifySessionToken(env, noAccount)).rejects.toBeInstanceOf(AppError);
  });
});
