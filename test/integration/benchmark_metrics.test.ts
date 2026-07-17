// Benchmark ↔ metric M:N link — snapshot-on-link into the benchmark's measurement_schema,
// post-publish link/unlink behavior (open and audited, not frozen), list scoping, and the "can't
// delete a linked metric" guard.
import { beforeEach, describe, expect, it } from "vitest";
import {
  apiDelete,
  apiGet,
  apiPost,
  apiPut,
  bearer,
  addMember,
  linkMetric,
  makeBenchmark,
  makeMetric,
  mintKey,
  publish,
  register,
  resetDb,
  type Resource,
} from "./helpers";

beforeEach(resetDb);

const EMPTY = { metrics: [], derived: [] };

/** Read a benchmark's current measurement_schema. */
async function schemaOf(token: string, benchmarkId: string): Promise<{ metrics: any[]; derived: any[]; chart?: any }> {
  const doc = (await (await apiGet(`/api/v1/benchmarks/${benchmarkId}`, bearer(token))).json()) as { data: Resource };
  return doc.data.attributes.measurement_schema as { metrics: any[]; derived: any[]; chart?: any };
}

describe("benchmark_metric — snapshot on link", () => {
  it("links an INTEGER metric, appending a MetricDecl to the schema", async () => {
    const me = await register();
    const bm = await makeBenchmark(me.token, { measurement_schema: EMPTY });
    const metric = await makeMetric(me.token, { label: "Throughput (req/s)", type: "INTEGER", unit: "req/s", format: "#,##0", description: "Requests per second" });

    const link = await linkMetric(me.token, bm.id, metric.id);
    expect(link.attributes).toMatchObject({ benchmark: bm.id, metric: metric.id });

    const schema = await schemaOf(me.token, bm.id);
    // The unit + format snapshot into the schema so the display layer can render values.
    expect(schema.metrics).toEqual([{ name: "throughput_req_s", type: "INTEGER", unit: "req/s", format: "#,##0", description: "Requests per second" }]);
    expect(schema.derived).toEqual([]);
  });

  it("links a FORMULA metric, appending a DerivedDecl with the compiled expression", async () => {
    const me = await register();
    const bm = await makeBenchmark(me.token, { measurement_schema: EMPTY });
    const metric = await makeMetric(me.token, {
      label: "Skew",
      type: "FORMULA",
      unit: "ms",
      // Minute-skew from primitives: created_at mod 60000.
      formula: {
        steps: [{ id: "A", kind: "OP", op: "MOD", a: { kind: "CREATED_AT" }, b: { kind: "NUMBER", value: 60000 } }],
        result: "A",
      },
    });

    await linkMetric(me.token, bm.id, metric.id);
    const schema = await schemaOf(me.token, bm.id);
    expect(schema.metrics).toEqual([]);
    expect(schema.derived).toEqual([{ name: "skew", unit: "ms", expr: { "%": [{ var: "created_at" }, 60000] } }]);
  });

  it("rejects a double-link and a foreign-account metric", async () => {
    const me = await register();
    const other = await register("other@example.com");
    const bm = await makeBenchmark(me.token, { measurement_schema: EMPTY });
    const metric = await makeMetric(me.token, { label: "Latency", type: "DECIMAL" });
    await linkMetric(me.token, bm.id, metric.id);

    // Double-link → 409.
    const dup = await apiPost(
      "/api/v1/benchmark_metrics",
      { data: { type: "benchmark_metric", attributes: { benchmark: bm.id, metric: metric.id } } },
      bearer(me.token),
    );
    expect(dup.status).toBe(409);

    // Foreign-account metric → 409 (indistinguishable from missing).
    const foreign = await makeMetric(other.token, { label: "Foreign", type: "DECIMAL" });
    const cross = await apiPost(
      "/api/v1/benchmark_metrics",
      { data: { type: "benchmark_metric", attributes: { benchmark: bm.id, metric: foreign.id } } },
      bearer(me.token),
    );
    expect(cross.status).toBe(409);
  });

  it("rejects linking a metric whose name is already defined in the schema", async () => {
    const me = await register();
    // A hand-authored schema entry named "latency" already occupies that key.
    const bm = await makeBenchmark(me.token, {
      measurement_schema: { metrics: [{ name: "latency", type: "DECIMAL" }], derived: [] },
    });
    const metric = await makeMetric(me.token, { label: "Latency", type: "DECIMAL" });
    expect(metric.attributes.name).toBe("latency");

    const res = await apiPost(
      "/api/v1/benchmark_metrics",
      { data: { type: "benchmark_metric", attributes: { benchmark: bm.id, metric: metric.id } } },
      bearer(me.token),
    );
    expect(res.status).toBe(409);
    // The schema is unchanged and no link row was created.
    expect((await schemaOf(me.token, bm.id)).metrics).toHaveLength(1);
    const links = (await (await apiGet(`/api/v1/benchmark_metrics?filter[benchmark]=${bm.id}`, bearer(me.token))).json()) as { data: Resource[] };
    expect(links.data).toHaveLength(0);
  });

  it("lists links by benchmark and by metric", async () => {
    const me = await register();
    const bmA = await makeBenchmark(me.token, { key: "a", name: "A", measurement_schema: EMPTY });
    const bmB = await makeBenchmark(me.token, { key: "b", name: "B", measurement_schema: EMPTY });
    const metric = await makeMetric(me.token, { label: "Shared", type: "DECIMAL" });
    await linkMetric(me.token, bmA.id, metric.id);
    await linkMetric(me.token, bmB.id, metric.id);

    const byBench = (await (await apiGet(`/api/v1/benchmark_metrics?filter[benchmark]=${bmA.id}`, bearer(me.token))).json()) as { data: Resource[] };
    expect(byBench.data).toHaveLength(1);
    expect(byBench.data[0].attributes.benchmark).toBe(bmA.id);

    const byMetric = (await (await apiGet(`/api/v1/benchmark_metrics?filter[metric]=${metric.id}`, bearer(me.token))).json()) as { data: Resource[] };
    expect(byMetric.data.map((l) => l.attributes.benchmark).sort()).toEqual([bmA.id, bmB.id].sort());

    // No filter → 404 (must scope).
    expect((await apiGet("/api/v1/benchmark_metrics", bearer(me.token))).status).toBe(404);
  });

  it("unlinks a metric, removing its snapshot from the schema", async () => {
    const me = await register();
    const bm = await makeBenchmark(me.token, { measurement_schema: EMPTY });
    const metric = await makeMetric(me.token, { label: "Temp", type: "DECIMAL" });
    const link = await linkMetric(me.token, bm.id, metric.id);
    expect((await schemaOf(me.token, bm.id)).metrics).toHaveLength(1);

    const del = await apiDelete(`/api/v1/benchmark_metrics/${link.id}`, bearer(me.token));
    expect(del.status).toBe(204);
    const schema = await schemaOf(me.token, bm.id);
    expect(schema.metrics).toEqual([]);
    // The link is gone; the library metric survives.
    expect((await apiGet(`/api/v1/benchmark_metrics?filter[benchmark]=${bm.id}`, bearer(me.token))).status).toBe(200);
    expect((await apiGet(`/api/v1/metrics/${metric.id}`, bearer(me.token))).status).toBe(200);
  });
});

describe("benchmark_metric — post-publish link/unlink", () => {
  it("links and unlinks on a published benchmark, moving the schema snapshot (audited, not frozen)", async () => {
    const me = await register();
    const bm = await makeBenchmark(me.token, { measurement_schema: EMPTY });
    const first = await makeMetric(me.token, { label: "First", type: "DECIMAL" });
    const preLink = await linkMetric(me.token, bm.id, first.id);
    await publish(me.token, me.user_id, bm.id);

    // Linking a new metric post-publish appends its snapshot — a semantic-core change the History
    // records rather than blocks.
    const second = await makeMetric(me.token, { label: "Second", type: "INTEGER" });
    const link = await apiPost(
      "/api/v1/benchmark_metrics",
      { data: { type: "benchmark_metric", attributes: { benchmark: bm.id, metric: second.id } } },
      bearer(me.token),
    );
    expect(link.status).toBe(201);
    expect((await schemaOf(me.token, bm.id)).metrics.map((m) => m.name)).toEqual(["first", "second"]);
    const links = (await (await apiGet(`/api/v1/benchmark_metrics?filter[benchmark]=${bm.id}`, bearer(me.token))).json()) as { data: Resource[] };
    expect(links.data).toHaveLength(2);

    // Unlinking removes the snapshot from the schema the same way → 204.
    const del = await apiDelete(`/api/v1/benchmark_metrics/${preLink.id}`, bearer(me.token));
    expect(del.status).toBe(204);
    expect((await schemaOf(me.token, bm.id)).metrics.map((m) => m.name)).toEqual(["second"]);
  });
});

// The console saves the Details form via full-replace PUT, round-tripping measurement_schema. These
// pin the contract that forces a fresh GET before that PUT: link/unlink move the schema server-side,
// and a stale round-trip silently drops (or resurrects) snapshots.
describe("benchmark_metric — schema round-trip through benchmark PUT", () => {
  const putBody = (attrs: Record<string, unknown>) => ({
    data: { type: "benchmark", attributes: attrs },
  });

  it("a fresh get-mutate-put preserves a just-linked snapshot; a stale body drops it, stranding the link", async () => {
    const me = await register();
    const bm = await makeBenchmark(me.token, { measurement_schema: EMPTY });
    const metric = await makeMetric(me.token, { label: "Throughput", type: "DECIMAL" });
    await linkMetric(me.token, bm.id, metric.id);

    // Fresh round-trip: GET → change a cosmetic field → PUT the whole representation back.
    const fresh = ((await (await apiGet(`/api/v1/benchmarks/${bm.id}`, bearer(me.token))).json()) as { data: Resource }).data.attributes;
    const ok = await apiPut(
      `/api/v1/benchmarks/${bm.id}`,
      putBody({ name: "Renamed", subject_type: fresh.subject_type, measurement_schema: fresh.measurement_schema }),
      bearer(me.token),
    );
    expect(ok.status).toBe(200);
    expect((await schemaOf(me.token, bm.id)).metrics.map((m) => m.name)).toEqual(["throughput"]);

    // A stale body — the schema as loaded BEFORE the link — full-replaces the snapshot away while
    // the link row lives on, orphaned.
    const stale = await apiPut(
      `/api/v1/benchmarks/${bm.id}`,
      putBody({ name: "Renamed", subject_type: fresh.subject_type, measurement_schema: EMPTY }),
      bearer(me.token),
    );
    expect(stale.status).toBe(200);
    expect((await schemaOf(me.token, bm.id)).metrics).toEqual([]);
    const links = (await (await apiGet(`/api/v1/benchmark_metrics?filter[benchmark]=${bm.id}`, bearer(me.token))).json()) as { data: Resource[] };
    expect(links.data).toHaveLength(1);
  });

  it("a stale round-trip after unlink resurrects an orphan schema entry that blocks re-linking", async () => {
    const me = await register();
    const bm = await makeBenchmark(me.token, { measurement_schema: EMPTY });
    const metric = await makeMetric(me.token, { label: "Throughput", type: "DECIMAL" });
    const link = await linkMetric(me.token, bm.id, metric.id);
    const staleSchema = await schemaOf(me.token, bm.id); // a client copy holding the snapshot

    await apiDelete(`/api/v1/benchmark_metrics/${link.id}`, bearer(me.token));
    const put = await apiPut(
      `/api/v1/benchmarks/${bm.id}`,
      putBody({ name: "Renamed", subject_type: bm.attributes.subject_type, measurement_schema: staleSchema }),
      bearer(me.token),
    );
    expect(put.status).toBe(200);

    // The resurrected entry has no link row behind it, and its name now blocks a re-link.
    const relink = await apiPost(
      "/api/v1/benchmark_metrics",
      { data: { type: "benchmark_metric", attributes: { benchmark: bm.id, metric: metric.id } } },
      bearer(me.token),
    );
    expect(relink.status).toBe(409);
  });

  it("post-publish, round-trips, description edits, appends, and removals through PUT all pass", async () => {
    const me = await register();
    const bm = await makeBenchmark(me.token, { measurement_schema: EMPTY });
    const first = await makeMetric(me.token, { label: "First", type: "DECIMAL" });
    await linkMetric(me.token, bm.id, first.id);
    await publish(me.token, me.user_id, bm.id);
    const current = await schemaOf(me.token, bm.id);

    // Round-tripping the schema UNCHANGED (cosmetic rename) saves cleanly.
    const ok = await apiPut(
      `/api/v1/benchmarks/${bm.id}`,
      putBody({ name: "Renamed", subject_type: bm.attributes.subject_type, measurement_schema: current }),
      bearer(me.token),
    );
    expect(ok.status).toBe(200);

    // Description edits inside an existing entry land.
    const described = { ...current, metrics: [{ ...current.metrics[0], description: "Latency, described." }] };
    const cosmetic = await apiPut(
      `/api/v1/benchmarks/${bm.id}`,
      putBody({ name: "Renamed", subject_type: bm.attributes.subject_type, measurement_schema: described }),
      bearer(me.token),
    );
    expect(cosmetic.status).toBe(200);
    expect((await schemaOf(me.token, bm.id)).metrics[0].description).toBe("Latency, described.");

    // APPENDING a new entry via PUT lands too — publishing no longer freezes the metric set.
    const appended = { ...current, metrics: [...current.metrics, { name: "second", type: "INTEGER" }] };
    const append = await apiPut(
      `/api/v1/benchmarks/${bm.id}`,
      putBody({ name: "Renamed", subject_type: bm.attributes.subject_type, measurement_schema: appended }),
      bearer(me.token),
    );
    expect(append.status).toBe(200);
    expect((await schemaOf(me.token, bm.id)).metrics.map((m) => m.name)).toEqual(["first", "second"]);

    // REMOVING entries (a stale pre-link copy) also lands — full-replace semantics apply, which is
    // exactly why the console must GET fresh before PUT: the "first" link row lives on, stranded.
    const removal = await apiPut(
      `/api/v1/benchmarks/${bm.id}`,
      putBody({ name: "Renamed", subject_type: bm.attributes.subject_type, measurement_schema: EMPTY }),
      bearer(me.token),
    );
    expect(removal.status).toBe(200);
    expect((await schemaOf(me.token, bm.id)).metrics).toEqual([]);
  });
});

describe("benchmark_metric — delete guard + authz", () => {
  it("blocks deleting a library metric that is still linked", async () => {
    const me = await register();
    const bm = await makeBenchmark(me.token, { measurement_schema: EMPTY });
    const metric = await makeMetric(me.token, { label: "Linked", type: "DECIMAL" });
    const link = await linkMetric(me.token, bm.id, metric.id);

    expect((await apiDelete(`/api/v1/metrics/${metric.id}`, bearer(me.token))).status).toBe(409);
    // Unlink, then deletion succeeds.
    expect((await apiDelete(`/api/v1/benchmark_metrics/${link.id}`, bearer(me.token))).status).toBe(204);
    expect((await apiDelete(`/api/v1/metrics/${metric.id}`, bearer(me.token))).status).toBe(204);
  });

  it("a viewer cannot link; another account's benchmark is a 404", async () => {
    const me = await register();
    const viewer = await addMember(me.token, me.account_id, "viewer@example.com", "VIEWER");
    const bm = await makeBenchmark(me.token, { measurement_schema: EMPTY });
    const metric = await makeMetric(me.token, { label: "M", type: "DECIMAL" });

    const asViewer = await apiPost(
      "/api/v1/benchmark_metrics",
      { data: { type: "benchmark_metric", attributes: { benchmark: bm.id, metric: metric.id } } },
      bearer(viewer.memberToken),
    );
    expect(asViewer.status).toBe(403);

    const other = await register("stranger@example.com");
    const strangerMetric = await makeMetric(other.token, { label: "S", type: "DECIMAL" });
    const cross = await apiPost(
      "/api/v1/benchmark_metrics",
      { data: { type: "benchmark_metric", attributes: { benchmark: bm.id, metric: strangerMetric.id } } },
      bearer(other.token),
    );
    expect(cross.status).toBe(404); // the benchmark isn't theirs

    // A benchmark-scoped key belongs to the account and may link (mirrors subjects).
    const { key } = await mintKey(me.token, { scope_type: "BENCHMARK", scope_ref: bm.id });
    const scoped = await apiPost(
      "/api/v1/benchmark_metrics",
      { data: { type: "benchmark_metric", attributes: { benchmark: bm.id, metric: metric.id } } },
      bearer(key),
    );
    expect(scoped.status).toBe(201);
  });
});
