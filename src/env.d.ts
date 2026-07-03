// Additional Worker bindings beyond the generated DB/ASSETS. Secrets are set with
// `wrangler secret put <NAME>` in prod and `.dev.vars` locally; vitest supplies them via
// vitest.config.ts. All are OPTIONAL: an unset secret disables its feature (OIDC begin → 503,
// email send → best-effort no-op), so config.ts must guard on presence rather than assume it.
//
// We augment BOTH the global `Env` (what src/ code sees) and `Cloudflare.Env` (what
// `cloudflare:test`'s `env` export is typed as) so the same fields are visible in app + tests.

interface SmplmarkSecrets {
  /** HS256 signing secret for session JWTs. */
  APP_AUTH_SECRET?: string;
  /** base64 32-byte AES-GCM key that encrypts API-key plaintext at rest (for reveal). */
  KEY_ENCRYPTION_SECRET?: string;
  /** Public origin of the app (e.g. https://app.smplmark.org). Used for OIDC redirect + email links. */
  APP_URL?: string;
  GOOGLE_OIDC_CLIENT_ID?: string;
  GOOGLE_OIDC_CLIENT_SECRET?: string;
  MICROSOFT_OIDC_CLIENT_ID?: string;
  MICROSOFT_OIDC_CLIENT_SECRET?: string;
  /** Resend API key for transactional email (verification, invitations, Contact Us). */
  RESEND_API_KEY?: string;
  /** From-address override (default "smplmark <support@smplmark.org>"). */
  RESEND_FROM?: string;
  /** Shared secret authorizing the Smpl Jobs system triggers (e.g. the publisher-domain re-check). */
  JOBS_TRIGGER_SECRET?: string;
  /** IP-keyed rate limiter for login / OIDC begin (10 / 60s). */
  RL_AUTH?: RateLimiter;
  /** IP-keyed rate limiter for register / resend-verification / invite / contact (5 / 60s). */
  RL_SENSITIVE?: RateLimiter;
}

declare global {
  /**
   * A Cloudflare Workers rate-limiting binding (the `ratelimit` unsafe binding). `.limit({ key })`
   * returns `{ success }` — false once the per-key window is exhausted. Optional on the env so the
   * middleware no-ops when absent (tests / a request with no client IP).
   */
  interface RateLimiter {
    limit(options: { key: string }): Promise<{ success: boolean }>;
  }
  interface Env extends SmplmarkSecrets {}
  namespace Cloudflare {
    interface Env extends SmplmarkSecrets {}
  }
}

export {};
