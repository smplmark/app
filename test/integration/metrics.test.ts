// Metrics (§ metrics) — CRUD, snake_case name derivation, STORED vs DERIVED + formula → JSON Logic, and authz.
import { beforeEach, describe, expect, it } from "vitest";
import {
  addMember,
  apiDelete,
  apiGet,
  apiPost,
  apiPut,
  bearer,
  makeBenchmark,
  mintKey,
  register,
  resetDb,
  type Resource,
} from "./helpers";

beforeEach(resetDb);

const body = (attrs: Record<string, unknown>) => ({ data: { type: "metric", attributes: attrs } });

async function create(token: string, attrs: Record<string, unknown>): Promise<Resource> {
  const res = await apiPost("/api/v1/metrics", body(attrs), bearer(token));
  expect(res.status).toBe(201);
  return ((await res.json()) as { data: Resource }).data;
}

describe("metric CRUD + name derivation", () => {
  it("derives a snake_case name from the label and round-trips a STORED metric", async () => {
    const me = await register();
    const m = await create(me.token, { label: "Throughput (req/s)", type: "COUNT" });
    expect(m.attributes.name).toBe("throughput_req_s");
    expect(m.attributes).toMatchObject({ label: "Throughput (req/s)", type: "COUNT", kind: "STORED", formula: null, expr: null });
  });

  it("stores DERIVED metrics and compiles their formulas to JSON Logic", async () => {
    const me = await register();
    const skew = await create(me.token, { label: "Skew", type: "DURATION_MS", kind: "DERIVED", formula: { op: "SKEW_MS" } });
    expect(skew.attributes.kind).toBe("DERIVED");
    expect(skew.attributes.formula).toEqual({ op: "SKEW_MS" });
    expect(skew.attributes.expr).toEqual({ minute_offset_ms: [{ var: "created_at" }] });

    const pct = await create(me.token, {
      name: "efficiency",
      label: "Efficiency",
      type: "PERCENT",
      kind: "DERIVED",
      formula: { op: "PERCENT", a: "Throughput", b: "cores" },
    });
    expect(pct.attributes.name).toBe("efficiency");
    // Operand metric names are slugified too ("Throughput" → "throughput").
    expect(pct.attributes.expr).toEqual({ "*": [100, { "/": [{ var: "metrics.throughput" }, { var: "metrics.cores" }] }] });
  });

  it("suffixes a colliding name and rejects bad input", async () => {
    const me = await register();
    const a = await create(me.token, { label: "Latency", type: "DURATION_MS" });
    const b = await create(me.token, { label: "Latency", type: "DURATION_MS" });
    expect(a.attributes.name).toBe("latency");
    expect(b.attributes.name).toBe("latency_2");

    // Unknown type → 400; missing label → 400; DERIVED without a formula → 400; binary op missing operands → 400.
    expect((await apiPost("/api/v1/metrics", body({ label: "X", type: "TIMESTAMP" }), bearer(me.token))).status).toBe(400);
    expect((await apiPost("/api/v1/metrics", body({ type: "NUMBER" }), bearer(me.token))).status).toBe(400);
    expect((await apiPost("/api/v1/metrics", body({ label: "D", type: "NUMBER", kind: "DERIVED" }), bearer(me.token))).status).toBe(400);
    expect((await apiPost("/api/v1/metrics", body({ label: "D", type: "NUMBER", kind: "DERIVED", formula: { op: "RATIO", a: "x" } }), bearer(me.token))).status).toBe(400);
  });

  it("lists, gets, updates (name immutable), and deletes", async () => {
    const me = await register();
    const m = await create(me.token, { label: "GPU util", type: "PERCENT" });
    expect(m.attributes.name).toBe("gpu_util");

    const list = (await (await apiGet("/api/v1/metrics", bearer(me.token))).json()) as { data: Resource[] };
    expect(list.data.map((r) => r.attributes.name)).toEqual(["gpu_util"]);
    expect((await apiGet(`/api/v1/metrics/${m.id}`, bearer(me.token))).status).toBe(200);

    // PUT changes label/type; a different name in the body is ignored (name is immutable).
    const put = await apiPut(`/api/v1/metrics/${m.id}`, body({ name: "renamed", label: "GPU utilisation", type: "NUMBER" }), bearer(me.token));
    expect(put.status).toBe(200);
    const updated = ((await put.json()) as { data: Resource }).data;
    expect(updated.attributes).toMatchObject({ name: "gpu_util", label: "GPU utilisation", type: "NUMBER" });

    expect((await apiDelete(`/api/v1/metrics/${m.id}`, bearer(me.token))).status).toBe(204);
    expect((await apiGet(`/api/v1/metrics/${m.id}`, bearer(me.token))).status).toBe(404);
  });
});

describe("metric authz", () => {
  it("a viewer may read but not create; a benchmark-scoped key cannot manage metrics", async () => {
    const me = await register();
    const viewer = await addMember(me.token, me.account_id, "viewer@example.com", "VIEWER");
    await create(me.token, { label: "Readable", type: "NUMBER" });

    expect((await apiGet("/api/v1/metrics", bearer(viewer.memberToken))).status).toBe(200);
    expect((await apiPost("/api/v1/metrics", body({ label: "Nope", type: "NUMBER" }), bearer(viewer.memberToken))).status).toBe(403);

    const bm = await makeBenchmark(me.token);
    const { key: benchKey } = await mintKey(me.token, { scope_type: "BENCHMARK", scope_ref: bm.id });
    expect((await apiGet("/api/v1/metrics", bearer(benchKey))).status).toBe(403);
    expect((await apiPost("/api/v1/metrics", body({ label: "Nope", type: "NUMBER" }), bearer(benchKey))).status).toBe(403);
  });

  it("isolates tenants (another account's metric is 404)", async () => {
    const me = await register();
    const other = await register("other@example.com");
    const m = await create(me.token, { label: "Mine", type: "NUMBER" });
    expect((await apiGet(`/api/v1/metrics/${m.id}`, bearer(other.token))).status).toBe(404);
  });
});
