import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  apiDelete,
  apiGet,
  apiPost,
  bearer,
  linkSubject,
  makeAccountSubject,
  makeBenchmark,
  makeMeasurement,
  makeRun,
  makeSubject,
  mintKey,
  publish,
  register,
  resetDb,
  runUuid,
  type Resource,
} from "./helpers";
import { LIMITS } from "../../src/limits";
import { aggregateMeasurements } from "../../src/data/measurements";

/** The internal UUID behind a subject key — never surfaced by the API, read straight from D1 so a
 *  test can exercise the legacy-UUID resolution path. */
async function subjectUuid(key: string): Promise<string> {
  const r = await env.DB.prepare("SELECT id FROM subject WHERE key = ?").bind(key).first<{ id: string }>();
  return r!.id;
}

beforeEach(resetDb);

// Audit capture: emitAuditEvent posts to Smpl Audit via the SDK's global fetch (SELF.fetch, used by
// the API helpers, is a separate transport and is unaffected). Tests that need to assert an emitted
// event stub the outbound fetch and set SMPLKIT_API_KEY; the afterEach undoes both.
const AUDIT_EVENTS_URL = "https://audit.smplkit.com/api/v1/events";
let auditPosts: { event_type: string; resource_id: string; data: Record<string, unknown>; actor_type: string | null; actor_id: string | null }[] = [];

function captureAudit(): void {
  auditPosts = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(input, init);
      if (req.url.startsWith(AUDIT_EVENTS_URL) && req.method === "POST") {
        auditPosts.push((JSON.parse(await req.clone().text()) as { data: { attributes: (typeof auditPosts)[0] } }).data.attributes);
        return new Response("{}", { status: 201 });
      }
      throw new Error(`unexpected fetch: ${req.url}`);
    }),
  );
}

afterEach(() => {
  env.SMPLKIT_API_KEY = undefined;
  vi.unstubAllGlobals();
});

const measurement = (attrs: Record<string, unknown>) => ({
  data: { type: "measurement", attributes: attrs },
});

async function scaffold(token: string) {
  const b = await makeBenchmark(token);
  const t = await makeSubject(token, b.id);
  const r = await makeRun(token, b.id);
  return { b, t, r };
}

describe("POST /measurements", () => {
  it("creates a bare measurement and computes offset_ms on read", async () => {
    const me = await register();
    const { t, r } = await scaffold(me.token);
    const created = Date.UTC(2026, 6, 1, 10, 0, 0) + 87;
    const res = await apiPost(
      "/api/v1/measurements",
      measurement({ run: r.id, subject: t.id, created_at: created }),
      bearer(me.token),
    );
    expect(res.status).toBe(201);
    const body = ((await res.json()) as { data: Resource }).data;
    expect(body.attributes.run).toBe(r.id);
    expect(body.attributes.subject).toBe(t.id);
    expect((body.attributes.metrics as Record<string, number>).offset_ms).toBe(87);
  });

  it("names the subject by its key (UUID no longer accepted), emits the key, and 409s an unlinked subject", async () => {
    const me = await register();
    const { t, r } = await scaffold(me.token); // t.id is the subject key, linked to the run's benchmark

    // By key (the migrated wire form): 201, and the response references the subject by its key.
    const byKey = await apiPost(
      "/api/v1/measurements",
      measurement({ run: r.id, subject: t.id }),
      bearer(me.token),
    );
    expect(byKey.status).toBe(201);
    expect(((await byKey.json()) as { data: Resource }).data.attributes.subject).toBe(t.id);

    // Keys-only (post-cutover): the internal UUID is no longer accepted — it matches no subject key,
    // so the subject resolves to nothing and the post is rejected with the same 409 as an unlinked
    // subject (no-leak: a bad key and an unlinked subject are indistinguishable).
    const uuid = await subjectUuid(t.id as string);
    const byUuid = await apiPost(
      "/api/v1/measurements",
      measurement({ run: r.id, subject: uuid }),
      bearer(me.token),
    );
    expect(byUuid.status).toBe(409);

    // A subject that exists in the account but is not linked to the run's benchmark → 409 (unchanged).
    const unlinked = await makeAccountSubject(me.token, "unlinked");
    const bad = await apiPost(
      "/api/v1/measurements",
      measurement({ run: r.id, subject: unlinked.id }),
      bearer(me.token),
    );
    expect(bad.status).toBe(409);
  });

  it("a measurement names a run and a subject", async () => {
    const me = await register();
    const { t, r } = await scaffold(me.token);
    const res = await apiPost(
      "/api/v1/measurements",
      measurement({ run: r.id, subject: t.id }),
      bearer(me.token),
    );
    expect(res.status).toBe(201);
    const body = ((await res.json()) as { data: Resource }).data;
    expect(body.attributes.run).toBe(r.id);
    expect(body.attributes.subject).toBe(t.id);
  });

  it("rejects a measurement whose run and subject are in different benchmarks", async () => {
    const me = await register();
    // Benchmark A gets a run and a subject; benchmark B contributes a foreign subject.
    const bA = await makeBenchmark(me.token, { key: "bench-a" });
    const subjectA = await makeSubject(me.token, bA.id, "subject-a");
    const runA = await makeRun(me.token, bA.id);
    const bB = await makeBenchmark(me.token, { key: "bench-b" });
    const subjectB = await makeSubject(me.token, bB.id, "subject-b");

    const res = await apiPost(
      "/api/v1/measurements",
      measurement({ run: runA.id, subject: subjectB.id }),
      bearer(me.token),
    );
    expect(res.status).toBe(409);

    // Same-benchmark pairing still succeeds.
    const ok = await apiPost(
      "/api/v1/measurements",
      measurement({ run: runA.id, subject: subjectA.id }),
      bearer(me.token),
    );
    expect(ok.status).toBe(201);
  });

  it("stores numeric metrics and rejects a non-numeric metric value", async () => {
    const me = await register();
    const { t, r } = await scaffold(me.token);
    const ok = await apiPost(
      "/api/v1/measurements",
      measurement({ run: r.id, subject: t.id, metrics: { p95_ms: 12.5 } }),
      bearer(me.token),
    );
    expect(ok.status).toBe(201);
    const bad = await apiPost(
      "/api/v1/measurements",
      measurement({ run: r.id, subject: t.id, metrics: { p95_ms: "slow" } }),
      bearer(me.token),
    );
    expect(bad.status).toBe(400);
  });

  it("rejects appending to a run in another account (404)", async () => {
    const a = await register("a@example.com");
    const { t, r } = await scaffold(a.token);
    const b = await register("b@example.com");
    const res = await apiPost(
      "/api/v1/measurements",
      measurement({ run: r.id, subject: t.id }),
      bearer(b.token),
    );
    expect(res.status).toBe(404);
  });

  it("computes elapsed_ms from run.started_at (widened context)", async () => {
    const me = await register();
    const started = Date.UTC(2026, 6, 1, 12, 0, 0);
    const b = await makeBenchmark(me.token, {
      measurement_schema: {
        metrics: [],
        derived: [{ name: "elapsed_ms", expr: { "-": [{ var: "created_at" }, { var: "run.started_at" }] } }],
        chart: { x: "elapsed_ms", y: "elapsed_ms", x_kind: "NUMBER" },
      },
    });
    const t = await makeSubject(me.token, b.id);
    const r = await makeRun(me.token, b.id, { started_at: started });
    const res = await apiPost(
      "/api/v1/measurements",
      measurement({ run: r.id, subject: t.id, created_at: started + 5000 }),
      bearer(me.token),
    );
    const body = ((await res.json()) as { data: Resource }).data;
    expect((body.attributes.metrics as Record<string, number>).elapsed_ms).toBe(5000);
  });
});

describe("GET /measurements", () => {
  it("requires a scope filter; run may pair with benchmark, subject stays exclusive", async () => {
    const me = await register();
    const { b, t, r } = await scaffold(me.token);
    expect((await apiGet("/api/v1/measurements", bearer(me.token))).status).toBe(400);
    // run+benchmark is the disambiguated form (run keys are unique only per benchmark) — allowed.
    expect(
      (await apiGet(`/api/v1/measurements?filter[run]=${r.id}&filter[benchmark]=${b.id}`, bearer(me.token))).status,
    ).toBe(200);
    // subject combined with any other scope filter stays a 400.
    expect(
      (await apiGet(`/api/v1/measurements?filter[subject]=${t.id}&filter[benchmark]=${b.id}`, bearer(me.token))).status,
    ).toBe(400);
  });

  it("filter[run]+filter[benchmark] resolves a shared run key within the named benchmark", async () => {
    const me = await register();
    // Two benchmarks, each with a run KEYED IDENTICALLY — the ambiguity the combined form exists for.
    const b1 = await makeBenchmark(me.token, { key: "combo-a" });
    const s1 = await makeSubject(me.token, b1.id, "combo-subj-a");
    const r1 = await makeRun(me.token, b1.id, { key: "shared-run" });
    // Ingest b1's rows BEFORE the identically-keyed run exists elsewhere — an ACCOUNT-scoped ingest
    // of an ambiguous run key is itself a 409 (resolveOwnedRun), which is not what's under test here.
    await makeMeasurement(me.token, r1.id, s1.id, { metrics: { offset_ms: 1 } });
    await makeMeasurement(me.token, r1.id, s1.id, { metrics: { offset_ms: 2 } });
    const b2 = await makeBenchmark(me.token, { key: "combo-b" });
    const s2 = await makeSubject(me.token, b2.id, "combo-subj-b");
    await makeRun(me.token, b2.id, { key: "shared-run" });
    // b2's identically-keyed run stays empty except one row for the other subject.
    const r2doc = await apiGet(`/api/v1/measurements?filter[run]=shared-run&filter[benchmark]=${b2.id}`, bearer(me.token));
    expect(r2doc.status).toBe(200);
    expect(((await r2doc.json()) as { data: unknown[] }).data).toHaveLength(0);

    const r1doc = await apiGet(`/api/v1/measurements?filter[run]=shared-run&filter[benchmark]=${b1.id}`, bearer(me.token));
    expect(((await r1doc.json()) as { data: { attributes: { subject: string } }[] }).data.map((m) => m.attributes.subject)).toEqual([
      "combo-subj-a",
      "combo-subj-a",
    ]);
    void s2;

    // A run key that exists nowhere under the named benchmark is a 404 (no-leak).
    expect(
      (await apiGet(`/api/v1/measurements?filter[run]=no-such-run&filter[benchmark]=${b1.id}`, bearer(me.token))).status,
    ).toBe(404);
  });

  it("reads measurements scoped to a run and honors visibility", async () => {
    const me = await register();
    const { b, t, r } = await scaffold(me.token);
    await apiPost(
      "/api/v1/measurements",
      measurement({ run: r.id, subject: t.id, created_at: Date.UTC(2026, 6, 1, 10, 0, 0) }),
      bearer(me.token),
    );

    // Private → anonymous 404, owner 200.
    expect((await apiGet(`/api/v1/measurements?filter[run]=${r.id}`)).status).toBe(404);
    const owner = await apiGet(`/api/v1/measurements?filter[run]=${r.id}`, bearer(me.token));
    expect(owner.status).toBe(200);
    expect(((await owner.json()) as { data: Resource[] }).data.length).toBe(1);

    // After publish, anonymous can read by benchmark/subject too.
    await publish(me.token, me.user_id, b.id);
    expect((await apiGet(`/api/v1/measurements?filter[benchmark]=${b.id}`)).status).toBe(200);
    expect((await apiGet(`/api/v1/measurements?filter[subject]=${t.id}`)).status).toBe(200);
  });

  it("serves CSV via the Accept header", async () => {
    const me = await register();
    const { t, r } = await scaffold(me.token);
    await apiPost(
      "/api/v1/measurements",
      measurement({ run: r.id, subject: t.id, created_at: Date.UTC(2026, 6, 1, 10, 0, 0) }),
      bearer(me.token),
    );
    const res = await apiGet(`/api/v1/measurements?filter[run]=${r.id}`, {
      ...bearer(me.token),
      Accept: "text/csv",
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/csv");
    expect(res.headers.get("Vary")).toContain("Accept");
    expect(await res.text()).toContain("id,created_at,run,subject");
  });
});

describe("GET /measurements meta[stats]", () => {
  const TOP = Date.UTC(2026, 6, 1, 10, 0, 0); // top-of-minute → offset_ms is the +offset

  // A benchmark whose schema carries a stored metric (latency_ms) and the derived offset_ms.
  async function statsScaffold(token: string) {
    const b = await makeBenchmark(token, {
      measurement_schema: {
        metrics: [{ name: "latency_ms", type: "DECIMAL" }],
        derived: [{ name: "offset_ms", unit: "ms", expr: { minute_offset_ms: [{ var: "created_at" }] } }],
        chart: { x: "created_at", y: "latency_ms", x_kind: "TIME" },
      },
    });
    const t1 = await makeSubject(token, b.id, "sub-a");
    const t2 = await makeSubject(token, b.id, "sub-b");
    const r = await makeRun(token, b.id);
    // sub-a: three measurements (latency 10/20/30, offset 100/200/300); sub-b: one (latency 5, offset 50).
    await makeMeasurement(token, r.id, t1.id, { created_at: TOP + 100, metrics: { latency_ms: 10 } });
    await makeMeasurement(token, r.id, t1.id, { created_at: TOP + 200, metrics: { latency_ms: 20 } });
    await makeMeasurement(token, r.id, t1.id, { created_at: TOP + 300, metrics: { latency_ms: 30 } });
    await makeMeasurement(token, r.id, t2.id, { created_at: TOP + 50, metrics: { latency_ms: 5 } });
    return { b, t1, t2, r };
  }

  interface MetricStats { count: number; sum: number; min: number; max: number; avg: number; median: number; p75: number; p90: number; p95: number; p99: number }
  interface StatsMeta { measurements: number; truncated: boolean; subjects: { subject: string; metrics: Record<string, MetricStats> }[] }

  async function getStats(token: string, query: string): Promise<{ data: Resource[]; meta: { stats?: StatsMeta } }> {
    const res = await apiGet(`/api/v1/measurements?${query}`, bearer(token));
    expect(res.status).toBe(200);
    return (await res.json()) as { data: Resource[]; meta: { stats?: StatsMeta } };
  }

  it("summarizes stored and derived metrics per subject over the full set", async () => {
    const me = await register();
    const { t1, t2, r } = await statsScaffold(me.token);

    const body = await getStats(me.token, `filter[run]=${r.id}&meta[stats]=true&page[size]=1`);
    // Statistics cover all four measurements even though only one row is returned in the page.
    expect(body.data.length).toBe(1);
    const stats = body.meta.stats!;
    expect(stats.measurements).toBe(4);
    expect(stats.truncated).toBe(false);
    expect(stats.subjects.length).toBe(2);

    const a = stats.subjects.find((s) => s.subject === t1.id)!.metrics;
    expect(a.latency_ms).toMatchObject({ count: 3, min: 10, max: 30, avg: 20, median: 20, sum: 60 });
    expect(a.latency_ms.p75).toBeCloseTo(25);
    expect(a.offset_ms).toMatchObject({ count: 3, min: 100, max: 300, avg: 200, median: 200 });

    const b = stats.subjects.find((s) => s.subject === t2.id)!.metrics;
    expect(b.latency_ms).toMatchObject({ count: 1, avg: 5 });
    expect(b.offset_ms).toMatchObject({ count: 1, avg: 50 });
  });

  it("omits stats unless meta[stats]=true", async () => {
    const me = await register();
    const { r } = await statsScaffold(me.token);
    const body = await getStats(me.token, `filter[run]=${r.id}`);
    expect(body.meta.stats).toBeUndefined();
    const off = await getStats(me.token, `filter[run]=${r.id}&meta[stats]=false`);
    expect(off.meta.stats).toBeUndefined();
  });

  it("honors filter[created_at] when computing stats", async () => {
    const me = await register();
    const { t1, t2, r } = await statsScaffold(me.token);
    // Keep only measurements at/after TOP+150 → sub-a's 20 & 30 remain; sub-b (TOP+50) drops out.
    const from = new Date(TOP + 150).toISOString();
    const body = await getStats(me.token, `filter[run]=${r.id}&meta[stats]=true&filter[created_at]=${encodeURIComponent(`[${from},*)`)}&page[size]=1`);
    const stats = body.meta.stats!;
    expect(stats.measurements).toBe(2);
    expect(stats.subjects.length).toBe(1);
    const a = stats.subjects.find((s) => s.subject === t1.id)!.metrics;
    expect(a.latency_ms).toMatchObject({ count: 2, min: 20, max: 30, avg: 25 });
    expect(stats.subjects.find((s) => s.subject === t2.id)).toBeUndefined();
  });

  it("rejects a malformed meta[stats] value", async () => {
    const me = await register();
    const { r } = await statsScaffold(me.token);
    const res = await apiGet(`/api/v1/measurements?filter[run]=${r.id}&meta[stats]=yes`, bearer(me.token));
    expect(res.status).toBe(400);
  });

  it("ignores meta[stats] for a CSV export (CSV carries no meta)", async () => {
    const me = await register();
    const { r } = await statsScaffold(me.token);
    const res = await apiGet(`/api/v1/measurements?filter[run]=${r.id}&meta[stats]=true`, {
      ...bearer(me.token),
      Accept: "text/csv",
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/csv");
  });
});

describe("run reference by key (key-as-id migration)", () => {
  it("names the run by its key (UUID no longer accepted), emits the run key, and 404s a foreign run", async () => {
    const me = await register();
    const { t, r } = await scaffold(me.token); // r.id is the run key, linked to the run's benchmark

    // By key (the migrated wire form): 201, and the response references the run by its key.
    const byKey = await apiPost("/api/v1/measurements", measurement({ run: r.id, subject: t.id }), bearer(me.token));
    expect(byKey.status).toBe(201);
    expect(((await byKey.json()) as { data: Resource }).data.attributes.run).toBe(r.id);

    // Keys-only (post-cutover): the internal UUID no longer resolves — it matches no run key → 404.
    const byUuid = await apiPost("/api/v1/measurements", measurement({ run: await runUuid(r), subject: t.id }), bearer(me.token));
    expect(byUuid.status).toBe(404);

    // A run owned by another account → 404 (no-leak): its UUID matches no run key in this account.
    const other = await register("other@example.com");
    const foreign = await scaffold(other.token);
    const foreignRun = await apiPost(
      "/api/v1/measurements",
      measurement({ run: await runUuid(foreign.r), subject: t.id }),
      bearer(me.token),
    );
    expect(foreignRun.status).toBe(404);
  });

  it("POST accepts the run by key with a RUN-scoped and a BENCHMARK-scoped API key", async () => {
    const me = await register();
    const { b, t, r } = await scaffold(me.token);

    // A RUN-scoped key references its own run by key; the scope resolves the key to its run.
    const { key: runKey } = await mintKey(me.token, { scope_type: "RUN", scope_ref: r.id });
    expect((await apiPost("/api/v1/measurements", measurement({ run: r.id, subject: t.id }), bearer(runKey))).status).toBe(201);

    // A BENCHMARK-scoped key resolves the run key within its scoped benchmark.
    const { key: benchKey } = await mintKey(me.token, { scope_type: "BENCHMARK", scope_ref: b.id });
    expect((await apiPost("/api/v1/measurements", measurement({ run: r.id, subject: t.id }), bearer(benchKey))).status).toBe(201);
  });

  it("an ACCOUNT-scoped caller gets a 409 when a run key is ambiguous across benchmarks", async () => {
    const me = await register();
    // Two benchmarks in the same account, each with a run sharing the key "shared".
    const b1 = await makeBenchmark(me.token, { key: "bench-1" });
    const t1 = await makeSubject(me.token, b1.id, "s1");
    await makeRun(me.token, b1.id, { key: "shared" });
    const b2 = await makeBenchmark(me.token, { key: "bench-2" });
    await makeRun(me.token, b2.id, { key: "shared" });

    const res = await apiPost("/api/v1/measurements", measurement({ run: "shared", subject: t1.id }), bearer(me.token));
    expect(res.status).toBe(409);
    expect(((await res.json()) as { errors: { detail: string }[] }).errors[0].detail).toBe(
      "Ambiguous run key across benchmarks; scope the API key to the benchmark.",
    );
  });

  it("filter[run] accepts the run key (and the UUID)", async () => {
    const me = await register();
    const { t, r } = await scaffold(me.token);
    await apiPost(
      "/api/v1/measurements",
      measurement({ run: r.id, subject: t.id, created_at: Date.UTC(2026, 6, 1, 10, 0, 0) }),
      bearer(me.token),
    );

    const byKey = await apiGet(`/api/v1/measurements?filter[run]=${r.id}`, bearer(me.token));
    expect(byKey.status).toBe(200);
    expect(((await byKey.json()) as { data: Resource[] }).data.length).toBe(1);

    const byUuid = await apiGet(`/api/v1/measurements?filter[run]=${await runUuid(r)}`, bearer(me.token));
    expect(byUuid.status).toBe(200);
    expect(((await byUuid.json()) as { data: Resource[] }).data.length).toBe(1);
  });
});

describe("DELETE /measurements/:id", () => {
  it("deletes a measurement whether the benchmark is a draft or published, auditing the published removal", async () => {
    const me = await register();
    const { b, t, r } = await scaffold(me.token);
    const m1 = await makeMeasurement(me.token, r.id, t.id, { metrics: { offset_ms: 1 } });
    const m2 = await makeMeasurement(me.token, r.id, t.id, { metrics: { offset_ms: 2 } });

    // Draft: a measurement is freely deletable.
    expect((await apiDelete(`/api/v1/measurements/${m1.id}`, bearer(me.token))).status).toBe(204);
    const after = (await (await apiGet(`/api/v1/measurements?filter[run]=${r.id}`, bearer(me.token))).json()) as { data: Resource[] };
    expect(after.data.map((x) => x.id)).toEqual([m2.id]);

    // Publish, then delete a published measurement: no longer refused (owner-approved policy) — it
    // returns 204, the row is gone, and the removal leaves an audited public trail.
    await publish(me.token, me.user_id, b.id);
    const runId = await runUuid(r);
    const subjId = await subjectUuid(t.id); // the correlation carries internal UUIDs, not keys
    env.SMPLKIT_API_KEY = "sk_api_test";
    captureAudit();

    const del = await apiDelete(`/api/v1/measurements/${m2.id}`, bearer(me.token));
    expect(del.status).toBe(204);
    const gone = (await (await apiGet(`/api/v1/measurements?filter[run]=${r.id}`, bearer(me.token))).json()) as { data: Resource[] };
    expect(gone.data.map((x) => x.id)).toEqual([]);

    // A public-record change still leaves a trail: a public `measurement.deleted` event with the
    // run/subject correlation, attributed to the acting user.
    await vi.waitFor(() =>
      expect(auditPosts.filter((e) => e.event_type === "measurement.deleted")).toHaveLength(1),
    );
    const ev = auditPosts.find((e) => e.event_type === "measurement.deleted")!;
    expect(ev.resource_id).toBe(m2.id);
    expect(ev.data.visibility).toBe("public");
    expect(ev.data.benchmark_id).toBe(b.id);
    expect(ev.data.run_id).toBe(runId);
    expect(ev.data.subject_id).toBe(subjId);
    expect(ev.actor_type).toBe("USER");
    expect(ev.actor_id).toBe(me.user_id);
  });

  it("audits a draft measurement deletion as an internal event", async () => {
    const me = await register();
    const { t, r } = await scaffold(me.token);
    const m = await makeMeasurement(me.token, r.id, t.id, { metrics: { offset_ms: 1 } });

    env.SMPLKIT_API_KEY = "sk_api_test";
    captureAudit();
    expect((await apiDelete(`/api/v1/measurements/${m.id}`, bearer(me.token))).status).toBe(204);

    await vi.waitFor(() =>
      expect(auditPosts.filter((e) => e.event_type === "measurement.deleted")).toHaveLength(1),
    );
    expect(auditPosts.find((e) => e.event_type === "measurement.deleted")!.data.visibility).toBe("internal");
  });

  it("404s an unknown id and isolates tenants", async () => {
    const me = await register();
    const other = await register("other@example.com");
    const { t, r } = await scaffold(me.token);
    const m = await makeMeasurement(me.token, r.id, t.id, { metrics: { offset_ms: 1 } });

    expect((await apiDelete("/api/v1/measurements/999999", bearer(me.token))).status).toBe(404);
    expect((await apiDelete("/api/v1/measurements/not-a-number", bearer(me.token))).status).toBe(404);
    // Another account can't see or delete it.
    expect((await apiDelete(`/api/v1/measurements/${m.id}`, bearer(other.token))).status).toBe(404);
  });
});

describe("per-run measurement capacity", () => {
  /** Read a run's denormalized counter straight from D1. */
  async function counterOf(uuid: string): Promise<number> {
    const row = await env.DB
      .prepare("SELECT measurement_count AS n FROM run WHERE id = ?")
      .bind(uuid)
      .first<{ n: number }>();
    return row!.n;
  }

  it("409s a run at capacity and accepts one below it", async () => {
    const me = await register();
    const { t, r } = await scaffold(me.token);
    const uuid = await runUuid(r);

    // Seed the counter to the ceiling (inserting 100k real rows is not a test's job).
    await env.DB
      .prepare("UPDATE run SET measurement_count = ? WHERE id = ?")
      .bind(LIMITS.measurementsPerRun, uuid)
      .run();
    const full = await apiPost(
      "/api/v1/measurements",
      measurement({ run: r.id, subject: t.id }),
      bearer(me.token),
    );
    expect(full.status).toBe(409);
    const err = (await full.json()) as { errors: { detail: string }[] };
    expect(err.errors[0].detail).toContain("100,000");

    await env.DB
      .prepare("UPDATE run SET measurement_count = ? WHERE id = ?")
      .bind(LIMITS.measurementsPerRun - 1, uuid)
      .run();
    const ok = await apiPost(
      "/api/v1/measurements",
      measurement({ run: r.id, subject: t.id }),
      bearer(me.token),
    );
    expect(ok.status).toBe(201);
  });

  it("insert and delete maintain the run counter", async () => {
    const me = await register();
    const { t, r } = await scaffold(me.token);
    const uuid = await runUuid(r);

    const m1 = await makeMeasurement(me.token, r.id, t.id, { metrics: { offset_ms: 1 } });
    await makeMeasurement(me.token, r.id, t.id, { metrics: { offset_ms: 2 } });
    expect(await counterOf(uuid)).toBe(2);

    expect((await apiDelete(`/api/v1/measurements/${m1.id}`, bearer(me.token))).status).toBe(204);
    expect(await counterOf(uuid)).toBe(1);
  });

  it("unlinking a subject sheds its rows from the run counter", async () => {
    const me = await register();
    const b = await makeBenchmark(me.token);
    const s1 = await makeAccountSubject(me.token, "shed-a");
    const s2 = await makeAccountSubject(me.token, "shed-b");
    const link1 = await linkSubject(me.token, b.id, s1.id);
    await linkSubject(me.token, b.id, s2.id);
    const r = await makeRun(me.token, b.id);
    const uuid = await runUuid(r);

    await makeMeasurement(me.token, r.id, s1.id, { metrics: { offset_ms: 1 } });
    await makeMeasurement(me.token, r.id, s1.id, { metrics: { offset_ms: 2 } });
    await makeMeasurement(me.token, r.id, s2.id, { metrics: { offset_ms: 3 } });
    expect(await counterOf(uuid)).toBe(3);

    const res = await apiDelete(
      `/api/v1/benchmark_subjects/${link1.id}?delete_measurements=true`,
      bearer(me.token),
    );
    expect(res.status).toBe(204);
    expect(await counterOf(uuid)).toBe(1);
  });

  it("deleting a subject sheds its rows from every run counter", async () => {
    const me = await register();
    const b = await makeBenchmark(me.token);
    const s1 = await makeAccountSubject(me.token, "gone-a");
    const s2 = await makeAccountSubject(me.token, "stays-b");
    await linkSubject(me.token, b.id, s1.id);
    await linkSubject(me.token, b.id, s2.id);
    const rA = await makeRun(me.token, b.id, { key: "run-a" });
    const rB = await makeRun(me.token, b.id, { key: "run-b" });
    const uuidA = await runUuid(rA);
    const uuidB = await runUuid(rB);

    await makeMeasurement(me.token, rA.id, s1.id, { metrics: { offset_ms: 1 } });
    await makeMeasurement(me.token, rA.id, s2.id, { metrics: { offset_ms: 2 } });
    await makeMeasurement(me.token, rB.id, s1.id, { metrics: { offset_ms: 3 } });
    expect(await counterOf(uuidA)).toBe(2);
    expect(await counterOf(uuidB)).toBe(1);

    // Hard-delete the subject (its benchmark is still PRIVATE, so the cascade is permitted).
    const res = await apiDelete(`/api/v1/subjects/${s1.id}`, bearer(me.token));
    expect(res.status).toBe(204);
    expect(await counterOf(uuidA)).toBe(1);
    expect(await counterOf(uuidB)).toBe(0);
  });
});

describe("GET /measurements meta[counts]", () => {
  it("returns exact per-subject counts over the full filtered set, not the page", async () => {
    const me = await register();
    const b = await makeBenchmark(me.token);
    const s1 = await makeSubject(me.token, b.id, "count-a");
    const s2 = await makeAccountSubject(me.token, "count-b");
    await linkSubject(me.token, b.id, s2.id);
    const r = await makeRun(me.token, b.id);

    const t0 = Date.UTC(2026, 6, 1, 10, 0, 0);
    await makeMeasurement(me.token, r.id, s1.id, { created_at: t0 });
    await makeMeasurement(me.token, r.id, s1.id, { created_at: t0 + 1000 });
    await makeMeasurement(me.token, r.id, s2.id, { created_at: t0 + 2000 });

    // page[size]=1 proves the counts cover the whole set, not the returned page.
    const res = await apiGet(
      `/api/v1/measurements?filter[run]=${r.id}&meta[counts]=true&page[size]=1`,
      bearer(me.token),
    );
    expect(res.status).toBe(200);
    const doc = (await res.json()) as { data: unknown[]; meta: { counts: { subject: string; count: number }[] } };
    expect(doc.data).toHaveLength(1);
    expect(doc.meta.counts).toEqual([
      { subject: "count-a", count: 2 },
      { subject: "count-b", count: 1 },
    ]);
  });

  it("honors filter[created_at] and omits counts unless requested", async () => {
    const me = await register();
    const { t, r } = await scaffold(me.token);
    const t0 = Date.UTC(2026, 6, 1, 10, 0, 0);
    await makeMeasurement(me.token, r.id, t.id, { created_at: t0 });
    await makeMeasurement(me.token, r.id, t.id, { created_at: t0 + 60_000 });

    const windowed = await apiGet(
      `/api/v1/measurements?filter[run]=${r.id}&meta[counts]=true&filter[created_at]=${encodeURIComponent(
        `[${new Date(t0 + 30_000).toISOString()},*)`,
      )}`,
      bearer(me.token),
    );
    const wdoc = (await windowed.json()) as { meta: { counts: { subject: string; count: number }[] } };
    expect(wdoc.meta.counts).toEqual([{ subject: t.id, count: 1 }]);

    const plain = await apiGet(`/api/v1/measurements?filter[run]=${r.id}`, bearer(me.token));
    const pdoc = (await plain.json()) as { meta: Record<string, unknown> };
    expect(pdoc.meta.counts).toBeUndefined();
  });

  it("rejects a malformed meta[counts] value", async () => {
    const me = await register();
    const { r } = await scaffold(me.token);
    const res = await apiGet(
      `/api/v1/measurements?filter[run]=${r.id}&meta[counts]=yes`,
      bearer(me.token),
    );
    expect(res.status).toBe(400);
  });
});

describe("aggregateMeasurements chunked scan", () => {
  /** Seed n measurements 1s apart under the run/subject, oldest first, via direct SQL. */
  async function seedRows(runUuidStr: string, subjKey: string, n: number, t0: number): Promise<void> {
    const s = await env.DB.prepare("SELECT id FROM subject WHERE key = ?").bind(subjKey).first<{ id: string }>();
    const values = Array.from(
      { length: n },
      (_, i) => `('${runUuidStr}', '${s!.id}', ${t0 + i * 1000}, '{"v":${i}}')`,
    );
    for (let i = 0; i < values.length; i += 80) {
      await env.DB.prepare(
        `INSERT INTO measurement (run_id, subject_id, created_at, metrics) VALUES ${values.slice(i, i + 80).join(",")}`,
      ).run();
    }
  }

  it("walks multiple chunks and returns the full set untruncated", async () => {
    const me = await register();
    const { t, r } = await scaffold(me.token);
    const uuid = await runUuid(r);
    const t0 = Date.UTC(2026, 6, 1, 0, 0, 0);
    await seedRows(uuid, t.id as string, 10, t0);

    const { rows, truncated } = await aggregateMeasurements(env.DB, {
      scope: { run: uuid },
      cap: 100,
      chunk: 4, // 10 rows → chunks of 4, 4, 2
    });
    expect(truncated).toBe(false);
    expect(rows).toHaveLength(10);
    // Newest-first walk; every row distinct (keyset paging can't skip or duplicate).
    expect(rows.map((x) => x.created_at)).toEqual(
      Array.from({ length: 10 }, (_, i) => t0 + (9 - i) * 1000),
    );
  });

  it("keeps the NEWEST rows and flags truncated when the cap bites", async () => {
    const me = await register();
    const { t, r } = await scaffold(me.token);
    const uuid = await runUuid(r);
    const t0 = Date.UTC(2026, 6, 1, 0, 0, 0);
    await seedRows(uuid, t.id as string, 10, t0);

    const { rows, truncated } = await aggregateMeasurements(env.DB, {
      scope: { run: uuid },
      cap: 6,
      chunk: 4,
    });
    expect(truncated).toBe(true);
    expect(rows).toHaveLength(6);
    // The 6 newest of the 10 (t0+9s … t0+4s) — never an arbitrary slice.
    expect(rows.map((x) => x.created_at)).toEqual(
      Array.from({ length: 6 }, (_, i) => t0 + (9 - i) * 1000),
    );
  });

  it("breaks created_at ties by id so the walk stays stable", async () => {
    const me = await register();
    const { t, r } = await scaffold(me.token);
    const uuid = await runUuid(r);
    const t0 = Date.UTC(2026, 6, 1, 0, 0, 0);
    const s = await env.DB.prepare("SELECT id FROM subject WHERE key = ?").bind(t.id).first<{ id: string }>();
    // 7 rows sharing one timestamp: only the id tiebreak orders them.
    const values = Array.from({ length: 7 }, (_, i) => `('${uuid}', '${s!.id}', ${t0}, '{"v":${i}}')`);
    await env.DB.prepare(
      `INSERT INTO measurement (run_id, subject_id, created_at, metrics) VALUES ${values.join(",")}`,
    ).run();

    const { rows, truncated } = await aggregateMeasurements(env.DB, {
      scope: { run: uuid },
      cap: 100,
      chunk: 3,
    });
    expect(truncated).toBe(false);
    expect(rows).toHaveLength(7);
    expect(new Set(rows.map((x) => x.metrics)).size).toBe(7); // no dupes, no skips
  });
});
