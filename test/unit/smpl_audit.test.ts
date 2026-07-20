// The Smpl Audit integration: best-effort writes (never throw, never wedge), graceful no-op when
// the key is unset, and bounded history reads that turn transport failures into an honest 503
// rather than a silently-empty history.
import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  emitAuditEvent,
  listHistoryEvents,
  type AuditEventInput,
} from "../../src/audit/smpl_audit";
import { ServiceUnavailableError } from "../../src/errors";
import type { AuthContext } from "../../src/types";

type Ctx = Parameters<typeof emitAuditEvent>[0];

/** A minimal Hono-context stand-in: env + an executionCtx that records waitUntil promises. */
function fakeCtx(testEnv: Env, tasks: Promise<unknown>[]): Ctx {
  return {
    env: testEnv,
    executionCtx: { waitUntil: (p: Promise<unknown>) => tasks.push(p) },
  } as unknown as Ctx;
}

/** A context whose executionCtx throws (harnesses without an ExecutionContext). */
function noCtx(testEnv: Env): Ctx {
  return {
    env: testEnv,
    get executionCtx(): never {
      throw new Error("no execution context");
    },
  } as unknown as Ctx;
}

const OPERATOR: AuditEventInput["actor"] = { type: "OPERATOR", id: "mike", label: "mike" };

const keyCtx = (): AuthContext => ({
  source: "API_KEY",
  account_id: "a1",
  scope_type: "ACCOUNT",
  scope_ref: null,
  user_id: null,
  role: null,
  session_id: null,
  api_key_id: "key-9",
});

function baseInput(overrides: Partial<AuditEventInput> = {}): AuditEventInput {
  return {
    event_type: "benchmark.edited",
    resource_type: "benchmark",
    resource_id: "b1",
    benchmark_id: "b1",
    visibility: "public",
    description: "Benchmark edited.",
    actor: OPERATOR,
    ...overrides,
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("emitAuditEvent", () => {
  it("is a logged no-op when SMPLKIT_API_KEY is unset — no network call at all", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const tasks: Promise<unknown>[] = [];
    emitAuditEvent(fakeCtx({ ...env, SMPLKIT_API_KEY: undefined } as Env, tasks), baseInput());
    expect(fetchMock).not.toHaveBeenCalled();
    expect(tasks).toHaveLength(0);
  });

  it("POSTs the event envelope off the response path with the category correlation", async () => {
    // The SDK's openapi-fetch transport calls fetch with a Request object.
    const calls: { url: string; method: string; headers: Headers; body: string }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(input, init);
      calls.push({ url: req.url, method: req.method, headers: req.headers, body: await req.clone().text() });
      return new Response("{}", { status: 201 });
    }));
    const tasks: Promise<unknown>[] = [];
    // Explicitly unset the environment (the wrangler.jsonc var makes it "production" by default) to
    // cover the branch where no environment is named — the SDK then omits it from the envelope.
    const testEnv = { ...env, SMPLKIT_API_KEY: "sk_api_test", SMPLKIT_ENVIRONMENT: undefined } as Env;
    emitAuditEvent(fakeCtx(testEnv, tasks), baseInput({
      changes: { name: { before: "Old", after: "New" } },
      semantic_core: true,
      extra: { reason: "typo" },
    }));
    expect(tasks).toHaveLength(1);
    await Promise.all(tasks);

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://audit.smplkit.com/api/v1/events");
    expect(calls[0].headers.get("Authorization")).toBe("Bearer sk_api_test");
    expect(calls[0].headers.get("Content-Type")).toBe("application/vnd.api+json");
    // The platform WAF rejects UA-less requests (Workers' fetch default) — the UA must travel.
    expect(calls[0].headers.get("User-Agent")).toContain("smplmark-app");
    const body = JSON.parse(calls[0].body) as { data: { type: string; attributes: Record<string, unknown> } };
    expect(body.data.type).toBe("event");
    const a = body.data.attributes;
    expect(a.event_type).toBe("benchmark.edited");
    expect(a.resource_type).toBe("benchmark");
    expect(a.resource_id).toBe("b1");
    expect(a.category).toBe("benchmark:b1");
    expect(a.actor_type).toBe("OPERATOR");
    expect(a.actor_id).toBe("mike");
    expect(a.data).toEqual({
      visibility: "public",
      benchmark_id: "b1",
      changes: { name: { before: "Old", after: "New" } },
      semantic_core: true,
      reason: "typo",
    });
    expect(a).not.toHaveProperty("environment");
    expect(typeof a.occurred_at).toBe("string");
  });

  it("names the audit environment only when SMPLKIT_ENVIRONMENT is set, and omits the category for account-level resources", async () => {
    const calls: { body: string }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(input, init);
      calls.push({ body: await req.clone().text() });
      return new Response("{}", { status: 201 });
    }));
    const tasks: Promise<unknown>[] = [];
    const testEnv = { ...env, SMPLKIT_API_KEY: "sk_api_test", SMPLKIT_ENVIRONMENT: "production" } as Env;
    emitAuditEvent(fakeCtx(testEnv, tasks), baseInput({
      resource_type: "subject",
      resource_id: "t1",
      benchmark_id: undefined,
      visibility: "internal",
    }));
    await Promise.all(tasks);
    const a = (JSON.parse(calls[0].body) as { data: { attributes: Record<string, unknown> } }).data.attributes;
    expect(a.environment).toBe("production");
    expect(a).not.toHaveProperty("category");
    expect((a.data as Record<string, unknown>).visibility).toBe("internal");
    expect(a.data as Record<string, unknown>).not.toHaveProperty("benchmark_id");
  });

  it("identifies an API-key actor by its key id and a session actor by the user's email", async () => {
    const calls: { body: string }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(input, init);
      calls.push({ body: await req.clone().text() });
      return new Response("{}", { status: 201 });
    }));
    const userId = crypto.randomUUID();
    await env.DB.prepare(
      "INSERT INTO user (id, email, email_verified, display_name, created_at) VALUES (?,?,?,?,?)",
    ).bind(userId, `${userId}@test.example`, 1, "Ada", Date.now()).run();

    const tasks: Promise<unknown>[] = [];
    const testEnv = { ...env, SMPLKIT_API_KEY: "sk_api_test" } as Env;
    emitAuditEvent(fakeCtx(testEnv, tasks), baseInput({ actor: keyCtx() }));
    emitAuditEvent(fakeCtx(testEnv, tasks), baseInput({
      actor: {
        source: "SESSION", account_id: "a1", scope_type: "ACCOUNT", scope_ref: null,
        user_id: userId, role: "OWNER", session_id: "s1", api_key_id: null,
      },
    }));
    await Promise.all(tasks);

    const attrs = calls.map((c) => (JSON.parse(c.body) as { data: { attributes: Record<string, unknown> } }).data.attributes);
    expect(attrs[0].actor_type).toBe("API_KEY");
    expect(attrs[0].actor_id).toBe("key-9");
    // The SDK omits unset fields rather than sending explicit nulls; the service treats both alike.
    expect(attrs[0].actor_label).toBeUndefined();
    expect(attrs[1].actor_type).toBe("USER");
    expect(attrs[1].actor_id).toBe(userId);
    expect(attrs[1].actor_label).toBe(`${userId}@test.example`);
  });

  it("labels a session with a missing user as USER with no label (never throws)", async () => {
    const calls: { body: string }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(input, init);
      calls.push({ body: await req.clone().text() });
      return new Response("{}", { status: 201 });
    }));
    const tasks: Promise<unknown>[] = [];
    emitAuditEvent(fakeCtx({ ...env, SMPLKIT_API_KEY: "sk" } as Env, tasks), baseInput({
      actor: {
        source: "SESSION", account_id: "a1", scope_type: "ACCOUNT", scope_ref: null,
        user_id: crypto.randomUUID(), role: "OWNER", session_id: "s1", api_key_id: null,
      },
    }));
    await Promise.all(tasks);
    const a = (JSON.parse(calls[0].body) as { data: { attributes: Record<string, unknown> } }).data.attributes;
    expect(a.actor_type).toBe("USER");
    expect(a.actor_label).toBeUndefined(); // omitted, not null — SDK wire shape
  });

  it("swallows a non-2xx response and a thrown fetch — a mutation is never wedged by audit", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 500 })));
    const tasks: Promise<unknown>[] = [];
    const testEnv = { ...env, SMPLKIT_API_KEY: "sk" } as Env;
    emitAuditEvent(fakeCtx(testEnv, tasks), baseInput());
    await expect(Promise.all(tasks)).resolves.toBeDefined();

    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network down"); }));
    const tasks2: Promise<unknown>[] = [];
    emitAuditEvent(fakeCtx(testEnv, tasks2), baseInput());
    await expect(Promise.all(tasks2)).resolves.toBeDefined();
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it("still sends (inline) when there is no execution context", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    emitAuditEvent(noCtx({ ...env, SMPLKIT_API_KEY: "sk" } as Env), baseInput());
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  });
});

describe("listHistoryEvents", () => {
  const event = (id: string, attributes: Record<string, unknown>) => ({ id, attributes });

  it("returns empty when unconfigured (the feature is off, not broken)", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const out = await listHistoryEvents({ ...env, SMPLKIT_API_KEY: undefined } as Env, { benchmark_id: "b1" });
    expect(out).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("queries the subtree by category and parses events, defaulting visibility to internal", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : String(input);
      urls.push(url);
      return Response.json({
        data: [
          event("e1", {
            event_type: "benchmark.published", resource_type: "benchmark", resource_id: "b1",
            occurred_at: "2026-07-16T12:00:00Z", description: "Published.",
            actor_type: "USER", actor_id: "u1", actor_label: "a@b.com",
            data: { visibility: "public", benchmark_id: "b1", semantic_core: false },
          }),
          // No visibility tag, changes is an array (malformed), missing description →
          // internal / null / null: the safe defaults for the public surface.
          event("e2", { event_type: "benchmark.edited", resource_type: "benchmark", resource_id: "b1", occurred_at: "2026-07-16T13:00:00Z", data: { changes: [1] } }),
        ],
        links: { next: null },
      });
    }));
    const out = await listHistoryEvents({ ...env, SMPLKIT_API_KEY: "sk" } as Env, { benchmark_id: "b1" });
    expect(urls).toHaveLength(1);
    expect(decodeURIComponent(urls[0])).toContain("filter[category]=benchmark:b1");
    expect(decodeURIComponent(urls[0])).toContain("page[size]=200");
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({
      id: "e1", event_type: "benchmark.published", resource_type: "benchmark", resource_id: "b1",
      occurred_at: "2026-07-16T12:00:00Z", description: "Published.",
      actor_type: "USER", actor_id: "u1", actor_label: "a@b.com",
      visibility: "public", benchmark_id: "b1", changes: null, semantic_core: false,
    });
    expect(out[1].visibility).toBe("internal");
    expect(out[1].description).toBeNull();
    expect(out[1].changes).toBeNull();
  });

  it("queries a single resource by resource_type + resource_id and follows links.next", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : String(input);
      urls.push(url);
      if (urls.length === 1) {
        return Response.json({
          data: [event("e1", { event_type: "run.created", resource_type: "run", resource_id: "r1", occurred_at: "t", data: {} })],
          links: { next: "https://audit.smplkit.com/api/v1/events?page[after]=cursor" },
        });
      }
      return Response.json({
        data: [event("e2", { event_type: "run.ended", resource_type: "run", resource_id: "r1", occurred_at: "t", data: {} })],
        links: { next: null },
      });
    }));
    const out = await listHistoryEvents({ ...env, SMPLKIT_API_KEY: "sk" } as Env, { resource_type: "run", resource_id: "r1" });
    expect(urls).toHaveLength(2);
    expect(decodeURIComponent(urls[0])).toContain("filter[resource_type]=run");
    expect(decodeURIComponent(urls[0])).toContain("filter[resource_id]=r1");
    expect(out.map((e) => e.id)).toEqual(["e1", "e2"]);
  });

  it("turns a non-2xx audit response and a transport failure into a 503 — never a silently-empty history", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn(async () => new Response("boom", { status: 500 })));
    const testEnv = { ...env, SMPLKIT_API_KEY: "sk" } as Env;
    await expect(listHistoryEvents(testEnv, { benchmark_id: "b1" })).rejects.toBeInstanceOf(ServiceUnavailableError);

    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("down"); }));
    await expect(listHistoryEvents(testEnv, { benchmark_id: "b1" })).rejects.toBeInstanceOf(ServiceUnavailableError);
    errSpy.mockRestore();
  });
});
