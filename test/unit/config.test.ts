import { describe, expect, it } from "vitest";
import {
  appUrl,
  emailConfigured,
  oidcClient,
  oidcConfigured,
  requireAuthSecret,
  requireKeyEncryptionSecret,
} from "../../src/config";

const env = (extra: Record<string, string> = {}) => extra as unknown as Env;

describe("appUrl", () => {
  it("prefers APP_URL (trailing slash stripped) and falls back to the request origin", () => {
    expect(appUrl(env({ APP_URL: "https://x.test/" }), "http://ignored/y")).toBe("https://x.test");
    expect(appUrl(env(), "http://req.test/some/path")).toBe("http://req.test");
  });
});

describe("oidcConfigured / oidcClient", () => {
  it("reports GOOGLE + MICROSOFT config independently", () => {
    expect(oidcConfigured(env(), "GOOGLE")).toBe(false);
    expect(oidcConfigured(env({ GOOGLE_OIDC_CLIENT_ID: "a", GOOGLE_OIDC_CLIENT_SECRET: "b" }), "GOOGLE")).toBe(true);
    expect(oidcConfigured(env({ MICROSOFT_OIDC_CLIENT_ID: "a", MICROSOFT_OIDC_CLIENT_SECRET: "b" }), "MICROSOFT")).toBe(true);
    expect(oidcConfigured(env(), "PASSWORD")).toBe(false);
  });

  it("returns a client only when configured", () => {
    expect(oidcClient(env(), "GOOGLE")).toBeNull();
    const g = oidcClient(env({ GOOGLE_OIDC_CLIENT_ID: "a", GOOGLE_OIDC_CLIENT_SECRET: "b" }), "GOOGLE");
    expect(g?.discoveryUrl).toContain("accounts.google.com");
    const m = oidcClient(env({ MICROSOFT_OIDC_CLIENT_ID: "a", MICROSOFT_OIDC_CLIENT_SECRET: "b" }), "MICROSOFT");
    expect(m?.discoveryUrl).toContain("login.microsoftonline.com");
    expect(oidcClient(env(), "PASSWORD")).toBeNull();
  });
});

describe("emailConfigured", () => {
  it("is true only with an API key", () => {
    expect(emailConfigured(env())).toBe(false);
    expect(emailConfigured(env({ RESEND_API_KEY: "re_x" }))).toBe(true);
  });
});

describe("required secrets", () => {
  it("throw when unset and return when set", () => {
    expect(() => requireAuthSecret(env())).toThrow();
    expect(requireAuthSecret(env({ APP_AUTH_SECRET: "s" }))).toBe("s");
    expect(() => requireKeyEncryptionSecret(env())).toThrow();
    expect(requireKeyEncryptionSecret(env({ KEY_ENCRYPTION_SECRET: "k" }))).toBe("k");
  });
});
