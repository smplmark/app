// Env-derived configuration and feature detection. Secrets are optional (see env.d.ts): the getters
// here distinguish "feature not configured" (a graceful 503 / no-op) from "required secret missing"
// (a server-config bug → 500), never a client 400.

import type { Provider } from "./types";

/** Session-JWT parameters. */
export const JWT_AUDIENCE = "smplmark";
export const JWT_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days

/** API-key plaintext prefix (smplmark-specific; the dispatch discriminator on /api/v1/*). */
export const API_KEY_PREFIX = "sm_api_";

/** Email-verification token lifetime. */
export const EMAIL_VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000; // 24h

/** Invitation token lifetime (mirrors smplkit). */
export const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/** Where Contact Us tickets are delivered, and the From/Reply-To for transactional email. */
export const SUPPORT_EMAIL = "support@smplmark.org";

/** Canonical hosts (production). This Worker (the app: console + auth + API) is served on `app`; the
 *  marketing site and the published-benchmark viewer live in the separate website repo on `www` (apex
 *  redirects to www there). The website reads this API cross-origin — see isAllowedCorsOrigin. */
export const APP_HOST = "app.smplmark.org";
export const WWW_HOST = "www.smplmark.org";
export const APEX_HOST = "smplmark.org";

/**
 * Whether a request Origin may read the public API cross-origin. The marketing site (www + apex) and
 * the published-benchmark viewer live in a separate deployment and fetch published data from here;
 * only their origins (plus local dev / preview) are allowed, and only for GETs (see src/app.ts). An
 * empty/absent Origin (same-origin console requests) is not a cross-origin concern and returns false.
 */
export function isAllowedCorsOrigin(origin: string | undefined | null): boolean {
  if (!origin) return false;
  if (origin === `https://${WWW_HOST}` || origin === `https://${APEX_HOST}`) return true;
  try {
    const { hostname } = new URL(origin);
    // Local dev (the website's dev server talking to a local app) and Cloudflare previews.
    if (hostname === "localhost" || hostname === "127.0.0.1") return true;
    if (hostname.endsWith(".workers.dev")) return true;
    if (hostname.endsWith(".smplmark.org")) return true;
  } catch {
    return false;
  }
  return false;
}

/**
 * The public origin. Prefers the APP_URL secret; otherwise falls back to the request's own origin
 * (fine for same-origin flows). Trailing slash stripped.
 */
export function appUrl(env: Env, requestUrl: string): string {
  const raw = env.APP_URL && env.APP_URL.length > 0 ? env.APP_URL : new URL(requestUrl).origin;
  return raw.replace(/\/+$/, "");
}

/** True when both client id and secret are present for the given OIDC provider. */
export function oidcConfigured(env: Env, provider: Provider): boolean {
  if (provider === "GOOGLE") {
    return !!(env.GOOGLE_OIDC_CLIENT_ID && env.GOOGLE_OIDC_CLIENT_SECRET);
  }
  if (provider === "MICROSOFT") {
    return !!(env.MICROSOFT_OIDC_CLIENT_ID && env.MICROSOFT_OIDC_CLIENT_SECRET);
  }
  return false;
}

export interface OidcClient {
  clientId: string;
  clientSecret: string;
  discoveryUrl: string;
  scope: string;
}

/** OIDC client config, or null when the provider is unconfigured. */
export function oidcClient(env: Env, provider: Provider): OidcClient | null {
  if (provider === "GOOGLE" && oidcConfigured(env, provider)) {
    return {
      clientId: env.GOOGLE_OIDC_CLIENT_ID as string,
      clientSecret: env.GOOGLE_OIDC_CLIENT_SECRET as string,
      discoveryUrl: "https://accounts.google.com/.well-known/openid-configuration",
      scope: "openid email profile",
    };
  }
  if (provider === "MICROSOFT" && oidcConfigured(env, provider)) {
    return {
      clientId: env.MICROSOFT_OIDC_CLIENT_ID as string,
      clientSecret: env.MICROSOFT_OIDC_CLIENT_SECRET as string,
      discoveryUrl:
        "https://login.microsoftonline.com/common/v2.0/.well-known/openid-configuration",
      scope: "openid email profile",
    };
  }
  return null;
}

/** True when the Resend transport is configured. */
export function emailConfigured(env: Env): boolean {
  return !!env.RESEND_API_KEY;
}

/**
 * Local-dev auto-login gate. When DEV_LOGIN is "1" (set ONLY in .dev.vars — never a production
 * secret), the app lazily creates a local dev account and signs you in without any OIDC round-trip,
 * so hitting the app on localhost drops you straight into the console. It MUST stay unset in prod:
 * the dev-login endpoint 404s and the root never auto-signs-in when this is false.
 */
export function devLoginEnabled(env: Env): boolean {
  return env.DEV_LOGIN === "1";
}

/** True when the Smpl Jobs trigger secret is configured (else the system-job endpoints 503). */
export function jobsTriggerConfigured(env: Env): boolean {
  return !!env.JOBS_TRIGGER_SECRET;
}

/** True when the smplkit API key is configured; unset → audit writes no-op, history reads are empty.
 *  The audit host is not overridden here — the SDK derives it (https://audit.smplkit.com) from its
 *  default base domain, or from SMPLKIT_BASE_DOMAIN/SMPLKIT_SCHEME for a non-standard target. */
export function auditConfigured(env: Env): boolean {
  return !!env.SMPLKIT_API_KEY;
}

/**
 * The JWT signing secret. Absent in a properly-deployed service is a server-config bug, not client
 * input, so callers surface a 500 — never a 400.
 */
export function requireAuthSecret(env: Env): string {
  if (!env.APP_AUTH_SECRET) {
    throw new Error("APP_AUTH_SECRET is not configured.");
  }
  return env.APP_AUTH_SECRET;
}

/** The AES-GCM key-encryption secret (base64). Absent is a server-config bug. */
export function requireKeyEncryptionSecret(env: Env): string {
  if (!env.KEY_ENCRYPTION_SECRET) {
    throw new Error("KEY_ENCRYPTION_SECRET is not configured.");
  }
  return env.KEY_ENCRYPTION_SECRET;
}
