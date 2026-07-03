import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { rateLimit } from "../../src/http/ratelimit";
import type { AppBindings } from "../../src/http/middleware";

function appWith(pick: (e: Env) => RateLimiter | undefined) {
  const app = new Hono<AppBindings>();
  app.use("*", rateLimit(pick));
  app.get("/", (c) => c.text("ok"));
  return app;
}

const IP = { "CF-Connecting-IP": "203.0.113.7" };
const allow: RateLimiter = { limit: async () => ({ success: true }) };
const deny: RateLimiter = { limit: async () => ({ success: false }) };

function req(app: Hono<AppBindings>, headers: Record<string, string>, env: unknown) {
  return app.request("/", { headers }, env as Env);
}

describe("rateLimit middleware", () => {
  it("allows when the binding is absent", async () => {
    const res = await req(appWith((e) => e.RL_AUTH), IP, {});
    expect(res.status).toBe(200);
  });

  it("allows when there is no client IP (can't identify the caller)", async () => {
    const res = await req(appWith((e) => e.RL_AUTH), {}, { RL_AUTH: deny });
    expect(res.status).toBe(200);
  });

  it("allows when under the limit", async () => {
    const res = await req(appWith((e) => e.RL_AUTH), IP, { RL_AUTH: allow });
    expect(res.status).toBe(200);
  });

  it("429s with Retry-After and a JSON:API body when over the limit", async () => {
    const res = await req(appWith((e) => e.RL_AUTH), IP, { RL_AUTH: deny });
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("60");
    expect(res.headers.get("Content-Type")).toContain("application/vnd.api+json");
    const body = (await res.json()) as { errors: { status: string }[] };
    expect(body.errors[0].status).toBe("429");
  });

  it("ignores a binding that isn't a real limiter", async () => {
    const res = await req(appWith((e) => e.RL_AUTH), IP, { RL_AUTH: {} });
    expect(res.status).toBe(200);
  });
});
