// Takedown: the public request affordance (a contact channel, never a delete) and the
// operator-only true delete behind the system endpoint — the only way a published record ever
// vanishes, and even then the removal itself is recorded in Smpl Audit.
import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  apiDelete,
  apiGet,
  apiPost,
  bearer,
  linkMetric,
  makeBenchmark,
  makeMetric,
  makeRun,
  makeSubject,
  makeMeasurement,
  mintKey,
  publish,
  register,
  resetDb,
  type Resource,
} from "./helpers";

const JOBS_SECRET = "jobs-secret-for-tests";
const AUDIT_EVENTS_URL = "https://audit.smplkit.com/api/v1/events";

let auditPosts: { event_type: string; resource_id: string; data: Record<string, unknown>; actor_type: string | null; actor_id: string | null }[] = [];
let resendPosts: { to: string; subject: string; reply_to?: string; text: string }[] = [];

function stubOutbound(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      // The SDK's openapi-fetch transport passes a Request object; normalize both shapes.
      const req = input instanceof Request ? input : new Request(input, init);
      if (req.url.startsWith(AUDIT_EVENTS_URL) && req.method === "POST") {
        auditPosts.push((JSON.parse(await req.clone().text()) as { data: { attributes: (typeof auditPosts)[0] } }).data.attributes);
        return new Response("{}", { status: 201 });
      }
      if (req.url === "https://api.resend.com/emails") {
        resendPosts.push(JSON.parse(await req.clone().text()) as (typeof resendPosts)[0]);
        return new Response("{}", { status: 200 });
      }
      throw new Error(`unexpected fetch: ${req.url}`);
    }),
  );
}

beforeEach(async () => {
  await resetDb();
  auditPosts = [];
  resendPosts = [];
  stubOutbound();
});

afterEach(() => {
  env.JOBS_TRIGGER_SECRET = undefined;
  env.RESEND_API_KEY = undefined;
  env.SMPLKIT_API_KEY = undefined;
  vi.unstubAllGlobals();
});

function takedownBody(benchmarkId: string, overrides: Record<string, unknown> = {}) {
  return {
    data: {
      type: "takedown_request",
      attributes: {
        benchmark: benchmarkId,
        requester_name: "Concerned Party",
        requester_email: "requester@example.com",
        reason: "The dataset names me and I want it removed.",
        ...overrides,
      },
    },
  };
}

describe("POST /api/v1/takedown_requests (public affordance)", () => {
  it("files a request against a published benchmark, emails operators, and records an internal event", async () => {
    const { token, user_id } = await register();
    const bm = await makeBenchmark(token);
    await publish(token, user_id, bm.id);
    // Configure email + audit only now, so the signup emails above don't muddy the capture.
    env.RESEND_API_KEY = "re_test";
    env.SMPLKIT_API_KEY = "sk_api_test";
    auditPosts = [];
    resendPosts = [];

    const res = await apiPost("/api/v1/takedown_requests", takedownBody(bm.id)); // anonymous
    expect(res.status).toBe(201);
    const doc = ((await res.json()) as { data: Resource }).data;
    expect(doc.type).toBe("takedown_request");
    expect(doc.attributes.status).toBe("OPEN");
    expect(doc.attributes.benchmark).toBe(bm.id);

    // Persisted for the operator work queue, with the benchmark ref snapshotted.
    const row = await env.DB.prepare("SELECT * FROM takedown_request WHERE id = ?").bind(doc.id)
      .first<{ status: string; benchmark_key: string; publisher_slug: string }>();
    expect(row?.status).toBe("OPEN");
    expect(row?.benchmark_key).toBe("scheduler-latency");

    // Routed to operators (support inbox, reply-to the requester)…
    expect(resendPosts).toHaveLength(1);
    expect(resendPosts[0].to).toBe("support@smplmark.org");
    expect(resendPosts[0].subject).toContain("Takedown request");
    expect(resendPosts[0].reply_to).toBe("requester@example.com");
    // …and recorded internally, never on the public history. The requester's identity rides in
    // extra (operators only), NEVER in the actor label — the publisher reads the owner-visible
    // History, and the takedown is typically filed against them.
    await vi.waitFor(() =>
      expect(auditPosts.filter((e) => e.event_type === "benchmark.takedown_requested")).toHaveLength(1),
    );
    const ev = auditPosts[0];
    expect(ev.data.visibility).toBe("internal");
    expect(ev.actor_type).toBe("PUBLIC");
    // Omitted on the wire (the SDK skips unset fields) — the requester's email must not be here.
    expect((ev as unknown as { actor_label?: string | null }).actor_label).toBeUndefined();
  });

  it("still succeeds when neither email nor audit is configured (best-effort routing)", async () => {
    const { token, user_id } = await register();
    const bm = await makeBenchmark(token);
    await publish(token, user_id, bm.id);
    const res = await apiPost("/api/v1/takedown_requests", takedownBody(bm.id));
    expect(res.status).toBe(201);
    expect(resendPosts).toHaveLength(0);
    expect(auditPosts).toHaveLength(0);
  });

  it("accepts requests against withdrawn benchmarks (they are still public record)", async () => {
    const { token, user_id } = await register();
    const bm = await makeBenchmark(token);
    await publish(token, user_id, bm.id);
    const withdraw = await apiPost(
      `/api/v1/benchmarks/${bm.id}/actions/withdraw`,
      { data: { type: "benchmark", attributes: { withdrawal_reason: "obsolete" } } },
      bearer(token),
    );
    expect(withdraw.status).toBe(200);
    expect((await apiPost("/api/v1/takedown_requests", takedownBody(bm.id))).status).toBe(201);
  });

  it("404s for a private or unknown benchmark (no existence leak) and 400s on missing fields", async () => {
    const { token } = await register();
    const bm = await makeBenchmark(token);
    expect((await apiPost("/api/v1/takedown_requests", takedownBody(bm.id))).status).toBe(404);
    expect((await apiPost("/api/v1/takedown_requests", takedownBody(crypto.randomUUID()))).status).toBe(404);
    const missing = await apiPost("/api/v1/takedown_requests", takedownBody(bm.id, { reason: "" }));
    expect(missing.status).toBe(400);
  });
});

describe("POST /api/v1/jobs/benchmark-takedown (operator-only true delete)", () => {
  const trigger = (body: unknown, secret?: string) =>
    apiPost("/api/v1/jobs/benchmark-takedown", body, secret ? { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" } : { "Content-Type": "application/json" });

  it("503s when unconfigured and 401s on a missing/wrong/publisher token", async () => {
    expect((await trigger({ benchmark_id: "x", reason: "r" })).status).toBe(503);
    env.JOBS_TRIGGER_SECRET = JOBS_SECRET;
    expect((await trigger({ benchmark_id: "x", reason: "r" })).status).toBe(401);
    expect((await trigger({ benchmark_id: "x", reason: "r" }, "wrong")).status).toBe(401);
    const { token } = await register();
    expect((await trigger({ benchmark_id: "x", reason: "r" }, token)).status).toBe(401);
  });

  it("hard-deletes the published benchmark's whole subtree, resolves open requests, and records the removal", async () => {
    env.JOBS_TRIGGER_SECRET = JOBS_SECRET;
    env.SMPLKIT_API_KEY = "sk_api_test";
    const { token, user_id } = await register();
    const bm = await makeBenchmark(token);
    const subject = await makeSubject(token, bm.id);
    const run = await makeRun(token, bm.id);
    await makeMeasurement(token, run.id, subject.id);
    const metric = await makeMetric(token);
    await linkMetric(token, bm.id, metric.id);
    await mintKey(token, { scope_type: "BENCHMARK", scope_ref: bm.id });
    await mintKey(token, { scope_type: "RUN", scope_ref: run.id });
    await publish(token, user_id, bm.id);
    expect((await apiPost("/api/v1/takedown_requests", takedownBody(bm.id))).status).toBe(201);
    auditPosts = [];

    const res = await trigger({ benchmark_id: bm.id, reason: "PII removal", removed_by: "mike" }, JOBS_SECRET);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: true, benchmark_id: bm.id, requests_resolved: 1 });

    // The record is gone — publicly and for the owner alike.
    expect((await apiGet(`/api/v1/benchmarks/${bm.id}`)).status).toBe(404);
    expect((await apiGet(`/api/v1/benchmarks/${bm.id}`, bearer(token))).status).toBe(404);
    // The whole subtree went with it — including the link rows and scoped keys the cascade owns.
    const count = async (sql: string) => (await env.DB.prepare(sql).bind(bm.id).first<{ n: number }>())?.n ?? 0;
    expect(await count("SELECT COUNT(*) AS n FROM run WHERE benchmark_id = ?")).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM benchmark_metric WHERE benchmark_id = ?")).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM benchmark_subject WHERE benchmark_id = ?")).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM api_key WHERE scope_ref = ?")).toBe(0);
    const keys = await env.DB.prepare("SELECT COUNT(*) AS n FROM api_key WHERE scope_type IN ('BENCHMARK','RUN')").first<{ n: number }>();
    expect(keys?.n).toBe(0);
    // The subject survives — account-owned, possibly linked elsewhere.
    expect((await apiGet(`/api/v1/subjects/${subject.id}`, bearer(token))).status).toBe(200);

    // The takedown request is the surviving paper trail…
    const req = await env.DB.prepare("SELECT status, resolved_at FROM takedown_request WHERE benchmark_id = ?")
      .bind(bm.id)
      .first<{ status: string; resolved_at: number | null }>();
    expect(req?.status).toBe("RESOLVED");
    expect(req?.resolved_at).not.toBeNull();
    // …and the removal itself is on the audit record, attributed to the operator.
    await vi.waitFor(() =>
      expect(auditPosts.filter((e) => e.event_type === "benchmark.taken_down")).toHaveLength(1),
    );
    const ev = auditPosts.find((e) => e.event_type === "benchmark.taken_down");
    expect(ev?.resource_id).toBe(bm.id);
    expect(ev?.actor_type).toBe("OPERATOR");
    expect(ev?.actor_id).toBe("mike");
    expect(ev?.data.reason).toBe("PII removal");
    expect(ev?.data.visibility).toBe("public");
  });

  it("400s on missing benchmark_id/reason and 404s on an unknown benchmark", async () => {
    env.JOBS_TRIGGER_SECRET = JOBS_SECRET;
    expect((await trigger({ reason: "r" }, JOBS_SECRET)).status).toBe(400);
    expect((await trigger({ benchmark_id: "b" }, JOBS_SECRET)).status).toBe(400);
    expect((await trigger({ benchmark_id: crypto.randomUUID(), reason: "r" }, JOBS_SECRET)).status).toBe(404);
  });

  it("no publisher-facing path reaches it: the benchmark DELETE stays 409 with the takedown pointer", async () => {
    const { token, user_id } = await register();
    const bm = await makeBenchmark(token);
    await publish(token, user_id, bm.id);
    const res = await apiPost(`/api/v1/benchmarks/${bm.id}/actions/withdraw`,
      { data: { type: "benchmark", attributes: { withdrawal_reason: "r" } } }, bearer(token));
    expect(res.status).toBe(200);
    const del = await apiDelete(`/api/v1/benchmarks/${bm.id}`, bearer(token));
    expect(del.status).toBe(409);
    const err = (await del.json()) as { errors: { detail: string }[] };
    expect(err.errors[0].detail).toContain("takedown");
  });
});
