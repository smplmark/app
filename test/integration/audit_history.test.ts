// The auditable-record model end to end: post-publish mutations succeed and emit Smpl Audit
// events (off the response path, best-effort), the History endpoints serve the trail with the
// owner/public dual view, and everything keeps working when the audit key is unset or the audit
// service is down. Audit HTTP traffic is stubbed at the global fetch (the house pattern).
import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  apiDelete,
  apiGet,
  apiPost,
  apiPut,
  bearer,
  makeBenchmark,
  makeMeasurement,
  makeMetric,
  makeRun,
  makeSubject,
  mintKey,
  publish,
  register,
  resetDb,
  runUuid,
  SKEW_SCHEMA,
  type Resource,
} from "./helpers";

const AUDIT_EVENTS_URL = "https://audit.smplkit.com/api/v1/events";

interface CapturedEvent {
  event_type: string;
  resource_type: string;
  resource_id: string;
  category?: string;
  description: string;
  actor_type: string | null;
  actor_id: string | null;
  actor_label: string | null;
  occurred_at: string;
  data: Record<string, unknown>;
}

/** Captured audit POST bodies + a canned GET response the history endpoints will read. */
let captured: CapturedEvent[] = [];
let auditGetResponse: () => Response;

/** One event resource in Smpl Audit's own wire shape (what GET /api/v1/events returns). */
function auditWireEvent(
  id: string,
  attrs: Partial<CapturedEvent> & { data?: Record<string, unknown> },
): { id: string; attributes: Record<string, unknown> } {
  return {
    id,
    attributes: {
      event_type: "benchmark.edited",
      resource_type: "benchmark",
      resource_id: "b1",
      occurred_at: "2026-07-16T12:00:00Z",
      description: "x",
      actor_type: "USER",
      actor_id: "u1",
      actor_label: "member@acme.test",
      ...attrs,
    },
  };
}

function stubAuditFetch(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      // The SDK's openapi-fetch transport passes a Request object; normalize both shapes.
      const req = input instanceof Request ? input : new Request(input, init);
      if (req.url.startsWith(AUDIT_EVENTS_URL)) {
        if (req.method === "POST") {
          const body = JSON.parse(await req.clone().text()) as { data: { attributes: CapturedEvent } };
          captured.push(body.data.attributes);
          return new Response("{}", { status: 201 });
        }
        return auditGetResponse();
      }
      throw new Error(`unexpected fetch: ${req.url}`);
    }),
  );
}

beforeEach(async () => {
  await resetDb();
  captured = [];
  auditGetResponse = () => Response.json({ data: [], links: { next: null } });
  env.SMPLKIT_API_KEY = "sk_api_test";
  stubAuditFetch();
});

afterEach(() => {
  env.SMPLKIT_API_KEY = undefined;
  vi.unstubAllGlobals();
});

/** Wait for the fire-and-forget (waitUntil) audit writes to land. */
async function expectEvents(n: number): Promise<void> {
  await vi.waitFor(() => expect(captured.length).toBeGreaterThanOrEqual(n));
}
const byType = (t: string) => captured.filter((e) => e.event_type === t);

describe("audit events on the publish lifecycle", () => {
  it("publish emits a public benchmark.published with the attribution and the subtree category", async () => {
    const { token, user_id } = await register();
    const bm = await makeBenchmark(token);
    await publish(token, user_id, bm.id);
    await expectEvents(1);
    const ev = byType("benchmark.published")[0];
    expect(ev).toBeDefined();
    expect(ev.resource_type).toBe("benchmark");
    expect(ev.resource_id).toBe(bm.id);
    expect(ev.category).toBe(`benchmark:${bm.id}`);
    expect(ev.data.visibility).toBe("public");
    expect(ev.data.published_as_kind).toBe("PERSONAL");
    expect(ev.actor_type).toBe("USER");
    expect(ev.actor_id).toBe(user_id);
    expect(String(ev.actor_label)).toContain("@"); // the member's email — console-only detail
  });

  it("withdraw emits a public benchmark.withdrawn carrying the reason", async () => {
    const { token, user_id } = await register();
    const bm = await makeBenchmark(token);
    await publish(token, user_id, bm.id);
    const res = await apiPost(
      `/api/v1/benchmarks/${bm.id}/actions/withdraw`,
      { data: { type: "benchmark", attributes: { withdrawal_reason: "methodology flaw" } } },
      bearer(token),
    );
    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(byType("benchmark.withdrawn")).toHaveLength(1));
    const ev = byType("benchmark.withdrawn")[0];
    expect(ev.data.visibility).toBe("public");
    expect(ev.data.reason).toBe("methodology flaw");
  });

  it("benchmark.created is internal (drafts are never public history)", async () => {
    const { token } = await register();
    const bm = await makeBenchmark(token);
    await vi.waitFor(() => expect(byType("benchmark.created")).toHaveLength(1));
    const ev = byType("benchmark.created")[0];
    expect(ev.resource_id).toBe(bm.id);
    expect(ev.data.visibility).toBe("internal");
  });
});

describe("editing a published benchmark (the old freeze, now audited)", () => {
  it("a semantic-core edit (changed metric set) succeeds and is flagged on the event", async () => {
    const { token, user_id } = await register();
    const bm = await makeBenchmark(token);
    await publish(token, user_id, bm.id);
    captured = [];

    const fresh = ((await (await apiGet(`/api/v1/benchmarks/${bm.id}`, bearer(token))).json()) as { data: Resource }).data;
    const a = fresh.attributes as Record<string, unknown>;
    // A real semantic-core change: add a stored metric (the metric SET changed). Changing a derived
    // formula is no longer semantic-core — formulas live on the library metric, not the schema.
    const schema = structuredClone(SKEW_SCHEMA) as typeof SKEW_SCHEMA;
    schema.metrics.push({ name: "latency_ms", type: "DECIMAL" });
    const res = await apiPut(
      `/api/v1/benchmarks/${bm.id}`,
      { data: { type: "benchmark", attributes: { ...a, measurement_schema: schema } } },
      bearer(token),
    );
    expect(res.status).toBe(200);

    await vi.waitFor(() => expect(byType("benchmark.edited")).toHaveLength(1));
    const ev = byType("benchmark.edited")[0];
    expect(ev.data.visibility).toBe("public");
    expect(ev.data.semantic_core).toBe(true);
    const changes = ev.data.changes as Record<string, { before: unknown; after: unknown }>;
    expect(changes.measurement_schema).toBeDefined();
  });

  it("a cosmetic edit emits an unflagged edited event with only the changed fields", async () => {
    const { token, user_id } = await register();
    const bm = await makeBenchmark(token);
    await publish(token, user_id, bm.id);
    captured = [];

    const fresh = ((await (await apiGet(`/api/v1/benchmarks/${bm.id}`, bearer(token))).json()) as { data: Resource }).data;
    const res = await apiPut(
      `/api/v1/benchmarks/${bm.id}`,
      { data: { type: "benchmark", attributes: { ...(fresh.attributes as Record<string, unknown>), description: "clearer wording" } } },
      bearer(token),
    );
    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(byType("benchmark.edited")).toHaveLength(1));
    const ev = byType("benchmark.edited")[0];
    expect(ev.data.semantic_core).toBe(false);
    const changes = ev.data.changes as Record<string, { before: unknown; after: unknown }>;
    expect(Object.keys(changes)).toEqual(["description"]);
    expect(changes.description).toEqual({ before: null, after: "clearer wording" });
  });

  it("an unchanged round-trip PUT emits nothing", async () => {
    const { token, user_id } = await register();
    const bm = await makeBenchmark(token);
    await publish(token, user_id, bm.id);
    captured = [];

    const fresh = ((await (await apiGet(`/api/v1/benchmarks/${bm.id}`, bearer(token))).json()) as { data: Resource }).data;
    const res = await apiPut(
      `/api/v1/benchmarks/${bm.id}`,
      { data: { type: "benchmark", attributes: fresh.attributes } },
      bearer(token),
    );
    expect(res.status).toBe(200);
    // Give any stray waitUntil a beat, then assert silence.
    await new Promise((r) => setTimeout(r, 50));
    expect(byType("benchmark.edited")).toHaveLength(0);
  });

  it("the attribution snapshot stays frozen: a PUT smuggling published_as/attribution fields changes nothing", async () => {
    const { token, user_id } = await register();
    const bm = await makeBenchmark(token);
    const published = await publish(token, user_id, bm.id);
    const before = published.attributes.published_as;

    const fresh = ((await (await apiGet(`/api/v1/benchmarks/${bm.id}`, bearer(token))).json()) as { data: Resource }).data;
    const res = await apiPut(
      `/api/v1/benchmarks/${bm.id}`,
      {
        data: {
          type: "benchmark",
          attributes: {
            ...(fresh.attributes as Record<string, unknown>),
            published_as: { kind: "ORGANIZATION", domain: "impostor.example", icon: "monogram" },
            published_by: "someone-else",
            attribution_snapshot: JSON.stringify({ domain: "impostor.example", icon: "monogram" }),
            published_at: "1999-01-01T00:00:00.000Z",
            status: "PRIVATE",
          },
        },
      },
      bearer(token),
    );
    expect(res.status).toBe(200);
    const after = ((await res.json()) as { data: Resource }).data.attributes as Record<string, unknown>;
    expect(after.published_as).toEqual(before);
    expect(after.status).toBe("PUBLISHED");
    expect(after.published_at).toBe(published.attributes.published_at);
  });
});

describe("audit events on runs and measurements", () => {
  async function publishedFixture() {
    const { token, user_id } = await register();
    const bm = await makeBenchmark(token);
    const subject = await makeSubject(token, bm.id);
    const run = await makeRun(token, bm.id);
    await makeMeasurement(token, run.id, subject.id);
    await publish(token, user_id, bm.id);
    captured = [];
    return { token, user_id, bm, subject, run };
  }

  it("post-publish measurement ingest emits a public measurement.created", async () => {
    const { token, bm, subject, run } = await publishedFixture();
    const m = await makeMeasurement(token, run.id, subject.id);
    await vi.waitFor(() => expect(byType("measurement.created")).toHaveLength(1));
    const ev = byType("measurement.created")[0];
    expect(ev.resource_id).toBe(m.id);
    expect(ev.category).toBe(`benchmark:${bm.id}`);
    expect(ev.data.visibility).toBe("public");
    expect(byType("run.appended")).toHaveLength(0); // the run was live — no append flag
  });

  it("appending to an ended run succeeds and additionally emits run.appended", async () => {
    const { token, bm, subject, run } = await publishedFixture();
    const end = await apiPost(`/api/v1/runs/${run.id}/actions/end`, undefined, bearer(token));
    expect(end.status).toBe(200);
    const m = await makeMeasurement(token, run.id, subject.id);
    await vi.waitFor(() => expect(byType("run.appended")).toHaveLength(1));
    const ev = byType("run.appended")[0];
    expect(ev.resource_type).toBe("run");
    // Audit records the run by its internal id (audit references stay UUID, per the invariant).
    expect(ev.resource_id).toBe(await runUuid(run));
    expect(ev.data.measurement_id).toBe(m.id);
    expect(ev.data.visibility).toBe("public");
    expect(byType("run.ended")).toHaveLength(1);
    expect(byType("measurement.created")).toHaveLength(1);
  });

  it("correcting a measurement in place records before/after and recomputes the response", async () => {
    const { token, subject, run } = await publishedFixture();
    const m = await makeMeasurement(token, run.id, subject.id, { metrics: undefined });
    captured = [];
    const res = await apiPut(
      `/api/v1/measurements/${m.id}`,
      { data: { type: "measurement", attributes: { created_at: m.attributes.created_at, meta: { corrected: true } } } },
      bearer(token),
    );
    expect(res.status).toBe(200);
    const body = ((await res.json()) as { data: Resource }).data;
    expect(body.attributes.meta).toEqual({ corrected: true });

    await vi.waitFor(() => expect(byType("measurement.corrected")).toHaveLength(1));
    const ev = byType("measurement.corrected")[0];
    expect(ev.resource_id).toBe(m.id);
    expect(ev.data.visibility).toBe("public");
    const changes = ev.data.changes as Record<string, { before: unknown; after: unknown }>;
    expect(changes.meta).toEqual({ before: null, after: { corrected: true } });
  });

  it("a no-op measurement correction emits nothing", async () => {
    const { token, subject, run } = await publishedFixture();
    const m = await makeMeasurement(token, run.id, subject.id, { metrics: { latency: 5 } });
    captured = [];
    const res = await apiPut(
      `/api/v1/measurements/${m.id}`,
      { data: { type: "measurement", attributes: { created_at: m.attributes.created_at, metrics: { latency: 5 } } } },
      bearer(token),
    );
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 50));
    expect(byType("measurement.corrected")).toHaveLength(0);
  });

  it("run edits emit run.edited; clearing ended_at emits run.reopened; invalidation carries its reason", async () => {
    const { token, run } = await publishedFixture();
    const rename = await apiPut(
      `/api/v1/runs/${run.id}`,
      { data: { type: "run", attributes: { name: "corrected label" } } },
      bearer(token),
    );
    expect(rename.status).toBe(200);
    await vi.waitFor(() => expect(byType("run.edited")).toHaveLength(1));
    expect((byType("run.edited")[0].data.changes as Record<string, unknown>).name).toEqual({ before: null, after: "corrected label" });

    const end = await apiPost(`/api/v1/runs/${run.id}/actions/end`, undefined, bearer(token));
    expect(end.status).toBe(200);
    const reopen = await apiPut(
      `/api/v1/runs/${run.id}`,
      { data: { type: "run", attributes: { name: "corrected label", ended_at: null } } },
      bearer(token),
    );
    expect(reopen.status).toBe(200);
    await vi.waitFor(() => expect(byType("run.reopened")).toHaveLength(1));

    const inv = await apiPost(
      `/api/v1/runs/${run.id}/actions/invalidate`,
      { data: { type: "run", attributes: { invalidation_reason: "harness bug" } } },
      bearer(token),
    );
    expect(inv.status).toBe(200);
    await vi.waitFor(() => expect(byType("run.invalidated")).toHaveLength(1));
    expect(byType("run.invalidated")[0].data.reason).toBe("harness bug");
  });

  it("post-publish subject/metric links emit public benchmark.edited events (metric ones semantic-core)", async () => {
    const { token, bm } = await publishedFixture();
    await makeSubject(token, bm.id, "late-subject");
    const metric = await makeMetric(token, { label: "Latency P99" });
    const link = await apiPost(
      "/api/v1/benchmark_metrics",
      { data: { type: "benchmark_metric", attributes: { benchmark: bm.id, metric: metric.id } } },
      bearer(token),
    );
    expect(link.status).toBe(201);
    await vi.waitFor(() => expect(byType("benchmark.edited")).toHaveLength(2));
    const [subjectEv, metricEv] = byType("benchmark.edited");
    expect(subjectEv.data.subject_linked).toBeDefined();
    expect(subjectEv.data.visibility).toBe("public");
    expect(metricEv.data.metric_linked).toBe(metric.id);
    expect(metricEv.data.semantic_core).toBe(true);

    const linkId = ((await link.json()) as { data: Resource }).data.id;
    captured = [];
    const unlink = await apiDelete(`/api/v1/benchmark_metrics/${linkId}`, bearer(token));
    expect(unlink.status).toBe(204);
    await vi.waitFor(() => expect(byType("benchmark.edited")).toHaveLength(1));
    expect(byType("benchmark.edited")[0].data.metric_unlinked).toBe(metric.id);
  });
});

describe("graceful degradation", () => {
  it("with SMPLKIT_API_KEY unset every mutation works and nothing is sent", async () => {
    env.SMPLKIT_API_KEY = undefined;
    const { token, user_id } = await register();
    const bm = await makeBenchmark(token);
    await publish(token, user_id, bm.id);
    const fresh = ((await (await apiGet(`/api/v1/benchmarks/${bm.id}`, bearer(token))).json()) as { data: Resource }).data;
    const res = await apiPut(
      `/api/v1/benchmarks/${bm.id}`,
      { data: { type: "benchmark", attributes: { ...(fresh.attributes as Record<string, unknown>), description: "still works" } } },
      bearer(token),
    );
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 50));
    expect(captured).toHaveLength(0);
  });

  it("an audit service outage never fails the mutation (writes are off the response path)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("audit down"); }));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { token, user_id } = await register();
    const bm = await makeBenchmark(token);
    await publish(token, user_id, bm.id); // asserts 200 internally
    errSpy.mockRestore();
  });
});

describe("history endpoints", () => {
  async function publishedBenchmark() {
    const { token, user_id } = await register();
    const bm = await makeBenchmark(token);
    await publish(token, user_id, bm.id);
    return { token, user_id, bm };
  }

  it("serves the owner the full trail with real actors, querying by the subtree category", async () => {
    const { token, bm } = await publishedBenchmark();
    const urls: string[] = [];
    auditGetResponse = () =>
      Response.json({
        data: [
          auditWireEvent("e1", {
            event_type: "benchmark.published",
            resource_id: bm.id,
            data: { visibility: "public", benchmark_id: bm.id },
          }),
          auditWireEvent("e2", {
            event_type: "benchmark.created",
            resource_id: bm.id,
            data: { visibility: "internal", benchmark_id: bm.id },
          }),
        ],
        links: { next: null },
      });
    const prev = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      urls.push(input instanceof Request ? input.url : String(input));
      return prev(input as RequestInfo, init);
    }));

    const res = await apiGet(`/api/v1/benchmarks/${bm.id}/history`, bearer(token));
    expect(res.status).toBe(200);
    const doc = (await res.json()) as { data: Resource[]; meta: { count: number } };
    expect(doc.meta.count).toBe(2);
    expect(doc.data.map((e) => e.id)).toEqual(["e1", "e2"]);
    expect((doc.data[0].attributes.actor as Record<string, unknown>).label).toBe("member@acme.test");
    expect(doc.data[1].attributes.visibility).toBe("internal");
    expect(decodeURIComponent(urls.find((u) => u.startsWith(AUDIT_EVENTS_URL)) ?? "")).toContain(
      `filter[category]=benchmark:${bm.id}`,
    );
  });

  it("serves anonymous visitors only PUBLIC events with the actor redacted to the publisher identity", async () => {
    const { bm } = await publishedBenchmark();
    auditGetResponse = () =>
      Response.json({
        data: [
          auditWireEvent("pub", { event_type: "benchmark.published", resource_id: bm.id, data: { visibility: "public", benchmark_id: bm.id } }),
          auditWireEvent("draft", { event_type: "benchmark.created", resource_id: bm.id, data: { visibility: "internal", benchmark_id: bm.id } }),
          auditWireEvent("edit", { event_type: "benchmark.edited", resource_id: bm.id, data: { visibility: "public", benchmark_id: bm.id, semantic_core: true } }),
        ],
        links: { next: null },
      });

    const res = await apiGet(`/api/v1/benchmarks/${bm.id}/history`);
    expect(res.status).toBe(200);
    const doc = (await res.json()) as { data: Resource[]; meta: { count: number } };
    expect(doc.meta.count).toBe(2);
    expect(doc.data.map((e) => e.id)).toEqual(["pub", "edit"]);
    for (const e of doc.data) {
      const actor = e.attributes.actor as Record<string, unknown>;
      // Redacted to the publisher — never an individual email or user id.
      expect(actor).toEqual({ type: "PUBLISHER", id: null, label: "Test User" });
      expect(JSON.stringify(e)).not.toContain("member@acme.test");
      expect(JSON.stringify(e)).not.toContain('"u1"');
    }
    expect(doc.data[1].attributes.semantic_core).toBe(true);
  });

  it("404s anonymous callers on a private benchmark and serves the covered owner", async () => {
    const { token } = await register();
    const bm = await makeBenchmark(token);
    expect((await apiGet(`/api/v1/benchmarks/${bm.id}/history`)).status).toBe(404);
    expect((await apiGet(`/api/v1/benchmarks/${bm.id}/history`, bearer(token))).status).toBe(200);
  });

  it("returns an empty trail when audit is unconfigured, and 503 when the audit service errors", async () => {
    const { token, bm } = await publishedBenchmark();
    env.SMPLKIT_API_KEY = undefined;
    const empty = await apiGet(`/api/v1/benchmarks/${bm.id}/history`, bearer(token));
    expect(empty.status).toBe(200);
    expect(((await empty.json()) as { data: Resource[] }).data).toEqual([]);

    env.SMPLKIT_API_KEY = "sk_api_test";
    auditGetResponse = () => new Response("boom", { status: 500 });
    const down = await apiGet(`/api/v1/benchmarks/${bm.id}/history`, bearer(token));
    expect(down.status).toBe(503);
  });

  it("serves run history by resource pair with the same dual view", async () => {
    const { token, user_id } = await register();
    const bm = await makeBenchmark(token);
    const run = await makeRun(token, bm.id);
    const runId = await runUuid(run); // the internal id the history endpoint queries audit by
    await makeSubject(token, bm.id);
    await publish(token, user_id, bm.id);
    const urls: string[] = [];
    auditGetResponse = () =>
      Response.json({
        data: [
          auditWireEvent("r1", { event_type: "run.invalidated", resource_type: "run", resource_id: run.id, data: { visibility: "public", benchmark_id: bm.id } }),
          auditWireEvent("r2", { event_type: "run.created", resource_type: "run", resource_id: run.id, data: { visibility: "internal", benchmark_id: bm.id } }),
        ],
        links: { next: null },
      });
    const prev = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      urls.push(input instanceof Request ? input.url : String(input));
      return prev(input as RequestInfo, init);
    }));

    const owner = await apiGet(`/api/v1/runs/${run.id}/history`, bearer(token));
    expect(owner.status).toBe(200);
    expect(((await owner.json()) as { data: Resource[] }).data).toHaveLength(2);
    expect(decodeURIComponent(urls.find((u) => u.startsWith(AUDIT_EVENTS_URL)) ?? "")).toContain(
      `filter[resource_id]=${runId}`,
    );

    const anon = await apiGet(`/api/v1/runs/${run.id}/history`);
    expect(anon.status).toBe(200);
    const anonDoc = (await anon.json()) as { data: Resource[] };
    expect(anonDoc.data.map((e) => e.id)).toEqual(["r1"]);
    expect((anonDoc.data[0].attributes.actor as Record<string, unknown>).type).toBe("PUBLISHER");
  });

  it("serves subject history to the covered account; the public view of subject events is empty", async () => {
    const { token, user_id } = await register();
    const bm = await makeBenchmark(token);
    const subject = await makeSubject(token, bm.id);
    await publish(token, user_id, bm.id); // makes the subject world-visible via its benchmark
    auditGetResponse = () =>
      Response.json({
        data: [
          auditWireEvent("s1", { event_type: "subject.edited", resource_type: "subject", resource_id: subject.id, data: { visibility: "internal" } }),
        ],
        links: { next: null },
      });

    const owner = await apiGet(`/api/v1/subjects/${subject.id}/history`, bearer(token));
    expect(owner.status).toBe(200);
    expect(((await owner.json()) as { data: Resource[] }).data).toHaveLength(1);

    const anon = await apiGet(`/api/v1/subjects/${subject.id}/history`);
    expect(anon.status).toBe(200);
    expect(((await anon.json()) as { data: Resource[] }).data).toEqual([]);
  });

  it("subject mutations emit internal subject events with before/after", async () => {
    const { token } = await register();
    const bm = await makeBenchmark(token);
    const subject = await makeSubject(token, bm.id, "sub-audit");
    captured = [];
    const res = await apiPut(
      `/api/v1/subjects/${subject.id}`,
      { data: { type: "subject", attributes: { name: "Renamed" } } },
      bearer(token),
    );
    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(byType("subject.edited")).toHaveLength(1));
    const ev = byType("subject.edited")[0];
    expect(ev.data.visibility).toBe("internal");
    expect(ev.category).toBeUndefined(); // account-level: no benchmark correlation
    expect((ev.data.changes as Record<string, unknown>).name).toEqual({ before: "sub-audit", after: "Renamed" });
  });
});

describe("review fixes: scoped keys, close/reopen, canonical diffs", () => {
  it("gives a BENCHMARK-scoped key every event but redacts actors — member emails never reach scoped credentials", async () => {
    const { token, user_id } = await register();
    const bm = await makeBenchmark(token);
    await publish(token, user_id, bm.id);
    const { key } = await mintKey(token, { scope_type: "BENCHMARK", scope_ref: bm.id });
    auditGetResponse = () =>
      Response.json({
        data: [
          auditWireEvent("pub", { event_type: "benchmark.published", resource_id: bm.id, data: { visibility: "public", benchmark_id: bm.id } }),
          auditWireEvent("draft", { event_type: "benchmark.created", resource_id: bm.id, data: { visibility: "internal", benchmark_id: bm.id } }),
        ],
        links: { next: null },
      });

    const res = await apiGet(`/api/v1/benchmarks/${bm.id}/history`, bearer(key));
    expect(res.status).toBe(200);
    const doc = (await res.json()) as { data: Resource[] };
    // Covered: internal events included — the key can read all the subtree's data anyway…
    expect(doc.data.map((e) => e.id)).toEqual(["pub", "draft"]);
    // …but actors are redacted: emails/user ids are account-level data a scoped key is denied
    // everywhere else (cf. the member-roster gate).
    for (const e of doc.data) {
      expect((e.attributes.actor as Record<string, unknown>).type).toBe("PUBLISHER");
      expect(JSON.stringify(e)).not.toContain("member@acme.test");
    }
  });

  it("gives a RUN-scoped key its run's history actor-redacted, and only the public benchmark view", async () => {
    const { token, user_id } = await register();
    const bm = await makeBenchmark(token);
    const run = await makeRun(token, bm.id);
    await makeSubject(token, bm.id);
    await publish(token, user_id, bm.id);
    const { key } = await mintKey(token, { scope_type: "RUN", scope_ref: await runUuid(run) });
    auditGetResponse = () =>
      Response.json({
        data: [
          auditWireEvent("r1", { event_type: "run.created", resource_type: "run", resource_id: run.id, data: { visibility: "internal", benchmark_id: bm.id } }),
        ],
        links: { next: null },
      });

    const runView = await apiGet(`/api/v1/runs/${run.id}/history`, bearer(key));
    expect(runView.status).toBe(200);
    const runDoc = (await runView.json()) as { data: Resource[] };
    expect(runDoc.data).toHaveLength(1); // covered → internal events included
    expect((runDoc.data[0].attributes.actor as Record<string, unknown>).type).toBe("PUBLISHER");
    expect(JSON.stringify(runDoc)).not.toContain("member@acme.test");

    // The benchmark subtree is outside a RUN key's coverage: it gets the public view only.
    const benchView = await apiGet(`/api/v1/benchmarks/${bm.id}/history`, bearer(key));
    expect(benchView.status).toBe(200);
    expect(((await benchView.json()) as { data: Resource[] }).data.map((e) => e.id)).toEqual([]);
  });

  it("audits close and reopen as public events on a published benchmark", async () => {
    const { token, user_id } = await register();
    const bm = await makeBenchmark(token);
    await publish(token, user_id, bm.id);
    captured = [];
    expect((await apiPost(`/api/v1/benchmarks/${bm.id}/actions/close`, undefined, bearer(token))).status).toBe(200);
    expect((await apiPost(`/api/v1/benchmarks/${bm.id}/actions/reopen`, undefined, bearer(token))).status).toBe(200);
    await vi.waitFor(() => expect(byType("benchmark.closed")).toHaveLength(1));
    await vi.waitFor(() => expect(byType("benchmark.reopened")).toHaveLength(1));
    expect(byType("benchmark.closed")[0].data.visibility).toBe("public");
    expect(byType("benchmark.reopened")[0].data.visibility).toBe("public");
  });

  it("a key-order-only round-trip of run details is not a change (no spurious public event)", async () => {
    const { token, user_id } = await register();
    const bm = await makeBenchmark(token);
    const run = await makeRun(token, bm.id, { details: { b: 2, a: 1 } });
    await makeSubject(token, bm.id);
    await publish(token, user_id, bm.id);
    captured = [];
    const res = await apiPut(
      `/api/v1/runs/${run.id}`,
      { data: { type: "run", attributes: { details: { a: 1, b: 2 } } } },
      bearer(token),
    );
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 50));
    expect(byType("run.edited")).toHaveLength(0);
  });

  it("bounds an oversized before/after entry to a truncation marker so the event still lands", async () => {
    const { token, user_id } = await register();
    const bm = await makeBenchmark(token);
    const run = await makeRun(token, bm.id);
    await makeSubject(token, bm.id);
    await publish(token, user_id, bm.id);
    captured = [];
    const huge = { blob: "x".repeat(40_000) };
    const res = await apiPut(
      `/api/v1/runs/${run.id}`,
      { data: { type: "run", attributes: { name: "renamed", details: huge } } },
      bearer(token),
    );
    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(byType("run.edited")).toHaveLength(1));
    const changes = byType("run.edited")[0].data.changes as Record<string, unknown>;
    // The oversized details entry collapses; the record of WHAT changed survives, bounded.
    expect(changes.details).toEqual({ truncated: true });
    expect(changes.name).toEqual({ before: null, after: "renamed" });
    expect(JSON.stringify(byType("run.edited")[0]).length).toBeLessThan(20_000);
  });
});
