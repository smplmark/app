// Rate limiting via Cloudflare's Workers rate-limiting binding (`env.RL_*`). Follows the
// per-route limits on abuse-prone endpoints (login, register, resend, invite, contact) and adds
// credential-keyed throttles on the authenticated write paths.
//
// Two keying strategies:
//  - rateLimit: keyed on CF-Connecting-IP, for unauthenticated endpoints. When the client IP is
//    unknown (no CF header — e.g. the test harness) or the binding is absent (unconfigured
//    deployment), the middleware is a no-op: we can't identify the client, so we don't throttle.
//    Production always sets CF-Connecting-IP, so limits apply there.
//  - rateLimitByCredential: keyed on the authenticated credential (API key id, else session user,
//    else account) — automated reporters often share egress IPs and an abuser rotates them, so IP keying is
//    wrong for authenticated writes. Must be mounted AFTER requireAuth (it reads the auth context).
import type { MiddlewareHandler } from "hono";
import { JSONAPI_CONTENT_TYPE } from "./jsonapi";
import { getAuth, type AppBindings } from "./middleware";

function tooManyRequests(): Response {
  return new Response(
    JSON.stringify({
      errors: [
        {
          status: "429",
          title: "Too Many Requests",
          detail: "Rate limit exceeded. Please slow down and try again shortly.",
        },
      ],
    }),
    {
      status: 429,
      headers: { "Content-Type": JSONAPI_CONTENT_TYPE, "Retry-After": "60" },
    },
  );
}

/**
 * Enforce a per-IP rate limit using the named binding, or a 429 JSON:API error with Retry-After.
 * `pick` selects the limiter binding off the env so a route can choose its bucket.
 */
export function rateLimit(
  pick: (env: Env) => RateLimiter | undefined,
): MiddlewareHandler<AppBindings> {
  return async (c, next) => {
    const limiter = pick(c.env);
    const ip = c.req.header("CF-Connecting-IP");
    if (limiter && typeof limiter.limit === "function" && ip) {
      const { success } = await limiter.limit({ key: ip });
      if (!success) return tooManyRequests();
    }
    await next();
  };
}

/**
 * Enforce a per-credential rate limit using the named binding, or a 429 with Retry-After. Mount
 * after requireAuth. The key is the API key id for API_KEY credentials (one stuck client throttles
 * only itself, not its whole account), else the session's user within the account.
 */
export function rateLimitByCredential(
  pick: (env: Env) => RateLimiter | undefined,
): MiddlewareHandler<AppBindings> {
  return async (c, next) => {
    const limiter = pick(c.env);
    if (limiter && typeof limiter.limit === "function") {
      const auth = getAuth(c);
      const key =
        auth.api_key_id !== null
          ? `k:${auth.api_key_id}`
          : `u:${auth.account_id}:${auth.user_id ?? ""}`;
      const { success } = await limiter.limit({ key });
      if (!success) return tooManyRequests();
    }
    await next();
  };
}
