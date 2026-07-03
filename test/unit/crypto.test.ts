import { describe, expect, it } from "vitest";
import {
  apiKeyPrefix,
  decryptSecret,
  encryptSecret,
  generateApiKey,
  generateEncryptionKey,
  hashPassword,
  randomToken,
  sha256Hex,
  timingSafeEqual,
  verifyPassword,
} from "../../src/auth/crypto";

describe("sha256Hex", () => {
  it("is a stable 64-char hex digest", async () => {
    const h = await sha256Hex("hello");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(await sha256Hex("hello")).toBe(h);
    expect(await sha256Hex("world")).not.toBe(h);
  });
});

describe("randomToken", () => {
  it("produces url-safe tokens of varying content", () => {
    const a = randomToken();
    const b = randomToken();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(randomToken(8).length).toBeGreaterThan(0);
  });
});

describe("timingSafeEqual", () => {
  it("compares by content and length", () => {
    expect(timingSafeEqual("abc", "abc")).toBe(true);
    expect(timingSafeEqual("abc", "abd")).toBe(false);
    expect(timingSafeEqual("abc", "abcd")).toBe(false);
  });
});

describe("password hashing", () => {
  it("round-trips a correct password and rejects a wrong one", async () => {
    const stored = await hashPassword("correct horse battery");
    expect(stored.startsWith("pbkdf2$sha256$")).toBe(true);
    expect(await verifyPassword("correct horse battery", stored)).toBe(true);
    expect(await verifyPassword("wrong", stored)).toBe(false);
  });

  it("rejects malformed stored hashes", async () => {
    expect(await verifyPassword("x", "not-a-hash")).toBe(false);
    expect(await verifyPassword("x", "bcrypt$sha256$1$a$b")).toBe(false);
    expect(await verifyPassword("x", "pbkdf2$sha512$1$a$b")).toBe(false);
    expect(await verifyPassword("x", "pbkdf2$sha256$0$AAAA$AAAA")).toBe(false);
    expect(await verifyPassword("x", "pbkdf2$sha256$abc$AAAA$AAAA")).toBe(false);
    // invalid base64 in salt/hash → decode throws → false
    expect(await verifyPassword("x", "pbkdf2$sha256$1000$@@@@$@@@@")).toBe(false);
  });
});

describe("API key minting", () => {
  it("generates a prefixed key and masked prefix", () => {
    const key = generateApiKey();
    expect(key.startsWith("sm_api_")).toBe(true);
    const prefix = apiKeyPrefix(key);
    expect(prefix.startsWith("sm_api_")).toBe(true);
    expect(prefix.length).toBe("sm_api_".length + 8);
    // Works even if the input lacks the prefix (defensive branch): first 8 body chars.
    expect(apiKeyPrefix("rawbody12345")).toBe("sm_api_rawbody1");
  });
});

describe("AES-GCM encrypt/decrypt", () => {
  it("round-trips a secret", async () => {
    const key = generateEncryptionKey();
    const ct = await encryptSecret("sm_api_topsecret", key);
    expect(ct).not.toContain("topsecret");
    expect(await decryptSecret(ct, key)).toBe("sm_api_topsecret");
  });

  it("fails to decrypt under the wrong key", async () => {
    const ct = await encryptSecret("secret", generateEncryptionKey());
    await expect(decryptSecret(ct, generateEncryptionKey())).rejects.toBeDefined();
  });
});
