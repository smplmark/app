// IP-based rate limiting via Cloudflare's Workers rate-limiting binding (`env.RL_*`). Mirrors
// smplkit's per-route limits on abuse-prone endpoints (login, register, resend, invite, contact).
//
// Keyed on CF-Connecting-IP. When the client IP is unknown (no CF header — e.g. the test harness) or
// the binding is absent (unconfigured deployment), the middleware is a no-op: we can't identify the
// client, so we don't throttle. Production always sets CF-Connecting-IP, so limits apply there.
import type { MiddlewareHandler } from "hono";
import { JSONAPI_CONTENT_TYPE } from "./jsonapi";
import type { AppBindings } from "./middleware";

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
      if (!success) {
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
    }
    await next();
  };
}
