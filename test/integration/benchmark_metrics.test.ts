// Benchmark ↔ metric M:N link — snapshot-on-link into the benchmark's measurement_schema, the
// append-only publish freeze, list scoping, and the "can't delete a linked metric" guard.
import { beforeEach, describe, expect, it } from "vitest";
import {
  apiDelete,
  apiGet,
  apiPost,
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
  it("links a STORED metric, appending a MetricDecl to the schema", async () => {
    const me = await register();
    const bm = await makeBenchmark(me.token, { measurement_schema: EMPTY });
    const metric = await makeMetric(me.token, { label: "Throughput (req/s)", type: "COUNT", description: "Requests per second" });

    const link = await linkMetric(me.token, bm.id, metric.id);
    expect(link.attributes).toMatchObject({ benchmark: bm.id, metric: metric.id });

    const schema = await schemaOf(me.token, bm.id);
    expect(schema.metrics).toEqual([{ name: "throughput_req_s", type: "COUNT", description: "Requests per second" }]);
    expect(schema.derived).toEqual([]);
  });

  it("links a DERIVED metric, appending a DerivedDecl with the compiled expression", async () => {
    const me = await register();
    const bm = await makeBenchmark(me.token, { measurement_schema: EMPTY });
    const metric = await makeMetric(me.token, {
      label: "Skew",
      type: "DURATION_MS",
      kind: "DERIVED",
      // Minute-skew from primitives: created_at mod 60000.
      formula: {
        steps: [{ id: "A", kind: "OP", op: "MOD", a: { kind: "CREATED_AT" }, b: { kind: "NUMBER", value: 60000 } }],
        result: "A",
      },
    });

    await linkMetric(me.token, bm.id, metric.id);
    const schema = await schemaOf(me.token, bm.id);
    expect(schema.metrics).toEqual([]);
    expect(schema.derived).toEqual([{ name: "skew", expr: { "%": [{ var: "created_at" }, 60000] } }]);
  });

  it("rejects a double-link and a foreign-account metric", async () => {
    const me = await register();
    const other = await register("other@example.com");
    const bm = await makeBenchmark(me.token, { measurement_schema: EMPTY });
    const metric = await makeMetric(me.token, { label: "Latency", type: "DURATION_MS" });
    await linkMetric(me.token, bm.id, metric.id);

    // Double-link → 409.
    const dup = await apiPost(
      "/api/v1/benchmark_metrics",
      { data: { type: "benchmark_metric", attributes: { benchmark: bm.id, metric: metric.id } } },
      bearer(me.token),
    );
    expect(dup.status).toBe(409);

    // Foreign-account metric → 409 (indistinguishable from missing).
    const foreign = await makeMetric(other.token, { label: "Foreign", type: "NUMBER" });
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
      measurement_schema: { metrics: [{ name: "latency", type: "DURATION_MS" }], derived: [] },
    });
    const metric = await makeMetric(me.token, { label: "Latency", type: "DURATION_MS" });
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
    const metric = await makeMetric(me.token, { label: "Shared", type: "NUMBER" });
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
    const metric = await makeMetric(me.token, { label: "Temp", type: "NUMBER" });
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

describe("benchmark_metric — publish freeze", () => {
  it("allows linking (append) on a published benchmark but forbids unlinking", async () => {
    const me = await register();
    const bm = await makeBenchmark(me.token, { measurement_schema: EMPTY });
    const first = await makeMetric(me.token, { label: "First", type: "NUMBER" });
    const preLink = await linkMetric(me.token, bm.id, first.id);
    await publish(me.token, me.user_id, bm.id);

    // Linking a NEW metric after publish is an append → allowed.
    const second = await makeMetric(me.token, { label: "Second", type: "COUNT" });
    const link = await apiPost(
      "/api/v1/benchmark_metrics",
      { data: { type: "benchmark_metric", attributes: { benchmark: bm.id, metric: second.id } } },
      bearer(me.token),
    );
    expect(link.status).toBe(201);
    expect((await schemaOf(me.token, bm.id)).metrics.map((m) => m.name).sort()).toEqual(["first", "second"]);

    // Unlinking removes a frozen entry → 409.
    const del = await apiDelete(`/api/v1/benchmark_metrics/${preLink.id}`, bearer(me.token));
    expect(del.status).toBe(409);
  });
});

describe("benchmark_metric — delete guard + authz", () => {
  it("blocks deleting a library metric that is still linked", async () => {
    const me = await register();
    const bm = await makeBenchmark(me.token, { measurement_schema: EMPTY });
    const metric = await makeMetric(me.token, { label: "Linked", type: "NUMBER" });
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
    const metric = await makeMetric(me.token, { label: "M", type: "NUMBER" });

    const asViewer = await apiPost(
      "/api/v1/benchmark_metrics",
      { data: { type: "benchmark_metric", attributes: { benchmark: bm.id, metric: metric.id } } },
      bearer(viewer.memberToken),
    );
    expect(asViewer.status).toBe(403);

    const other = await register("stranger@example.com");
    const strangerMetric = await makeMetric(other.token, { label: "S", type: "NUMBER" });
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
