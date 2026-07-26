import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { rateLimit, rateLimitByCredential } from "../../src/http/ratelimit";
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

describe("rateLimitByCredential middleware", () => {
  const keyAuth = {
    source: "API_KEY", account_id: "a1", scope_type: "ACCOUNT", scope_ref: null,
    user_id: null, role: null, session_id: null, api_key_id: "key-9",
  };
  const sessionAuth = {
    source: "SESSION", account_id: "a1", scope_type: "ACCOUNT", scope_ref: null,
    user_id: "u7", role: "OWNER", session_id: "s1", api_key_id: null,
  };

  function credApp(pick: (e: Env) => RateLimiter | undefined, auth: unknown) {
    const app = new Hono<AppBindings>();
    app.use("*", async (c, next) => { c.set("auth", auth as never); await next(); });
    app.use("*", rateLimitByCredential(pick));
    app.get("/", (c) => c.text("ok"));
    return app;
  }

  it("allows when the binding is absent", async () => {
    const res = await req(credApp((e) => e.RL_WRITE, keyAuth), {}, {});
    expect(res.status).toBe(200);
  });

  it("keys an API_KEY credential on the key id", async () => {
    const seen: string[] = [];
    const spy: RateLimiter = { limit: async ({ key }) => { seen.push(key); return { success: true }; } };
    const res = await req(credApp((e) => e.RL_WRITE, keyAuth), {}, { RL_WRITE: spy });
    expect(res.status).toBe(200);
    expect(seen).toEqual(["k:key-9"]);
  });

  it("keys a SESSION credential on account + user", async () => {
    const seen: string[] = [];
    const spy: RateLimiter = { limit: async ({ key }) => { seen.push(key); return { success: true }; } };
    const res = await req(credApp((e) => e.RL_WRITE, sessionAuth), {}, { RL_WRITE: spy });
    expect(res.status).toBe(200);
    expect(seen).toEqual(["u:a1:u7"]);
  });

  it("429s with Retry-After and a JSON:API body when over the limit", async () => {
    const res = await req(credApp((e) => e.RL_INGEST, keyAuth), {}, { RL_INGEST: deny });
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("60");
    const body = (await res.json()) as { errors: { status: string; title: string }[] };
    expect(body.errors[0].status).toBe("429");
    expect(body.errors[0].title).toBe("Too Many Requests");
  });
});
