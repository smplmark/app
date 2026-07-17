import { describe, expect, it } from "vitest";
import {
  appUrl,
  auditBaseUrl,
  auditConfigured,
  devLoginEnabled,
  emailConfigured,
  isAllowedCorsOrigin,
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

describe("isAllowedCorsOrigin", () => {
  it("allows the site origins, local dev, and preview hosts; rejects everything else", () => {
    expect(isAllowedCorsOrigin(undefined)).toBe(false);
    expect(isAllowedCorsOrigin("")).toBe(false);
    expect(isAllowedCorsOrigin("https://www.smplmark.org")).toBe(true);
    expect(isAllowedCorsOrigin("https://smplmark.org")).toBe(true);
    expect(isAllowedCorsOrigin("http://localhost:5173")).toBe(true);
    expect(isAllowedCorsOrigin("http://127.0.0.1:8788")).toBe(true);
    expect(isAllowedCorsOrigin("https://smplmark-app.preview.workers.dev")).toBe(true);
    expect(isAllowedCorsOrigin("https://viewer.smplmark.org")).toBe(true);
    expect(isAllowedCorsOrigin("https://evil.test")).toBe(false);
    expect(isAllowedCorsOrigin("not a url")).toBe(false);
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

describe("devLoginEnabled (prod-safety gate)", () => {
  it("is true ONLY for the exact flag DEV_LOGIN='1'", () => {
    expect(devLoginEnabled(env({ DEV_LOGIN: "1" }))).toBe(true);
    // Anything else — unset, blank, "true", "0" — leaves it off, so prod can never activate it.
    expect(devLoginEnabled(env())).toBe(false);
    expect(devLoginEnabled(env({ DEV_LOGIN: "" }))).toBe(false);
    expect(devLoginEnabled(env({ DEV_LOGIN: "true" }))).toBe(false);
    expect(devLoginEnabled(env({ DEV_LOGIN: "0" }))).toBe(false);
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

describe("auditConfigured / auditBaseUrl", () => {
  it("is configured only when the Smpl Audit key is set", () => {
    expect(auditConfigured(env())).toBe(false);
    expect(auditConfigured(env({ SMPL_AUDIT_API_KEY: "" }))).toBe(false);
    expect(auditConfigured(env({ SMPL_AUDIT_API_KEY: "sk_api_x" }))).toBe(true);
  });

  it("defaults the base URL and honors the override with trailing slashes stripped", () => {
    expect(auditBaseUrl(env())).toBe("https://audit.smplkit.com");
    expect(auditBaseUrl(env({ SMPL_AUDIT_BASE_URL: "http://localhost:9999/" }))).toBe("http://localhost:9999");
    expect(auditBaseUrl(env({ SMPL_AUDIT_BASE_URL: "" }))).toBe("https://audit.smplkit.com");
  });
});
