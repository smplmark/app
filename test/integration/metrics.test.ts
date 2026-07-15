// Metrics (§ metrics) — CRUD, snake_case name derivation, INTEGER/DECIMAL vs FORMULA + formula → JSON Logic, and authz.
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
  it("derives a snake_case name from the label and round-trips a stored metric", async () => {
    const me = await register();
    const m = await create(me.token, { label: "Throughput (req/s)", type: "INTEGER", unit: "req/s", format: "#,##0" });
    expect(m.attributes.name).toBe("throughput_req_s");
    expect(m.attributes).toMatchObject({ label: "Throughput (req/s)", type: "INTEGER", unit: "req/s", format: "#,##0", formula: null, expr: null });
  });

  it("defaults unit and format to null when omitted", async () => {
    const me = await register();
    const m = await create(me.token, { label: "Score", type: "DECIMAL" });
    expect(m.attributes).toMatchObject({ type: "DECIMAL", unit: null, format: null });
  });

  it("stores FORMULA metrics and compiles their formulas to JSON Logic", async () => {
    const me = await register();
    // Minute-skew is expressible from primitives — `created_at mod 60000` — so no built-in skew op.
    const skewFormula = {
      steps: [{ id: "A", kind: "OP", op: "MOD", a: { kind: "CREATED_AT" }, b: { kind: "NUMBER", value: 60000 } }],
      result: "A",
    };
    const skew = await create(me.token, { label: "Skew", type: "FORMULA", unit: "ms", formula: skewFormula });
    expect(skew.attributes).toMatchObject({ type: "FORMULA", unit: "ms" });
    expect(skew.attributes.formula).toEqual(skewFormula);
    expect(skew.attributes.expr).toEqual({ "%": [{ var: "created_at" }, 60000] });

    // A percentage `100 × (throughput ÷ cores)`: step A divides, step B scales A by 100, result B. A
    // STEP operand is inlined when compiled, and metric operand names are slugified ("Throughput" → …).
    const pct = await create(me.token, {
      name: "efficiency",
      label: "Efficiency",
      type: "FORMULA",
      unit: "%",
      format: "0.0%",
      formula: {
        steps: [
          { id: "A", kind: "OP", op: "DIV", a: { kind: "METRIC", name: "Throughput" }, b: { kind: "METRIC", name: "cores" } },
          { id: "B", kind: "OP", op: "MUL", a: { kind: "NUMBER", value: 100 }, b: { kind: "STEP", step: "A" } },
        ],
        result: "B",
      },
    });
    expect(pct.attributes.name).toBe("efficiency");
    expect(pct.attributes.expr).toEqual({ "*": [100, { "/": [{ var: "metrics.throughput" }, { var: "metrics.cores" }] }] });
  });

  it("suffixes a colliding name and rejects bad input", async () => {
    const me = await register();
    const a = await create(me.token, { label: "Latency", type: "DECIMAL" });
    const b = await create(me.token, { label: "Latency", type: "DECIMAL" });
    expect(a.attributes.name).toBe("latency");
    expect(b.attributes.name).toBe("latency_2");

    // Unknown/legacy type → 400; missing label → 400; FORMULA without a formula → 400; an OP step
    // missing an operand → 400; a STEP operand referencing a later/undefined step → 400; a bad number
    // format → 400; an over-long unit → 400.
    expect((await apiPost("/api/v1/metrics", body({ label: "X", type: "TIMESTAMP" }), bearer(me.token))).status).toBe(400);
    expect((await apiPost("/api/v1/metrics", body({ label: "X", type: "NUMBER" }), bearer(me.token))).status).toBe(400);
    expect((await apiPost("/api/v1/metrics", body({ type: "DECIMAL" }), bearer(me.token))).status).toBe(400);
    expect((await apiPost("/api/v1/metrics", body({ label: "D", type: "FORMULA" }), bearer(me.token))).status).toBe(400);
    expect((await apiPost("/api/v1/metrics", body({ label: "D", type: "FORMULA", formula: { steps: [{ id: "A", kind: "OP", op: "DIV", a: { kind: "METRIC", name: "x" } }] } }), bearer(me.token))).status).toBe(400);
    expect((await apiPost("/api/v1/metrics", body({ label: "D", type: "FORMULA", formula: { steps: [{ id: "A", kind: "OP", op: "ADD", a: { kind: "STEP", step: "B" }, b: { kind: "NUMBER", value: 1 } }] } }), bearer(me.token))).status).toBe(400);
    expect((await apiPost("/api/v1/metrics", body({ label: "D", type: "DECIMAL", format: "#.#.#" }), bearer(me.token))).status).toBe(400);
    expect((await apiPost("/api/v1/metrics", body({ label: "D", type: "DECIMAL", unit: "x".repeat(25) }), bearer(me.token))).status).toBe(400);
  });

  it("lists, gets, updates (name immutable), and deletes", async () => {
    const me = await register();
    const m = await create(me.token, { label: "GPU util", type: "DECIMAL", unit: "%", format: "0.0%" });
    expect(m.attributes.name).toBe("gpu_util");

    const list = (await (await apiGet("/api/v1/metrics", bearer(me.token))).json()) as { data: Resource[] };
    expect(list.data.map((r) => r.attributes.name)).toEqual(["gpu_util"]);
    expect((await apiGet(`/api/v1/metrics/${m.id}`, bearer(me.token))).status).toBe(200);

    // PUT changes label/type/unit/format; a different name in the body is ignored (name is immutable).
    const put = await apiPut(`/api/v1/metrics/${m.id}`, body({ name: "renamed", label: "GPU utilisation", type: "INTEGER", unit: "count", format: "#,##0" }), bearer(me.token));
    expect(put.status).toBe(200);
    const updated = ((await put.json()) as { data: Resource }).data;
    expect(updated.attributes).toMatchObject({ name: "gpu_util", label: "GPU utilisation", type: "INTEGER", unit: "count", format: "#,##0" });

    expect((await apiDelete(`/api/v1/metrics/${m.id}`, bearer(me.token))).status).toBe(204);
    expect((await apiGet(`/api/v1/metrics/${m.id}`, bearer(me.token))).status).toBe(404);
  });

  it("transitions a stored metric to FORMULA and back via PUT", async () => {
    const me = await register();
    const m = await create(me.token, { label: "Ratio", type: "DECIMAL" });

    // DECIMAL → FORMULA requires a formula (absent → 400), then compiles it.
    expect((await apiPut(`/api/v1/metrics/${m.id}`, body({ label: "Ratio", type: "FORMULA" }), bearer(me.token))).status).toBe(400);
    const formula = { steps: [{ id: "A", kind: "OP", op: "ADD", a: { kind: "CREATED_AT" }, b: { kind: "NUMBER", value: 1 } }], result: "A" };
    const toFormula = await apiPut(`/api/v1/metrics/${m.id}`, body({ label: "Ratio", type: "FORMULA", formula }), bearer(me.token));
    expect(toFormula.status).toBe(200);
    const f = ((await toFormula.json()) as { data: Resource }).data;
    expect(f.attributes.type).toBe("FORMULA");
    expect(f.attributes.expr).toEqual({ "+": [{ var: "created_at" }, 1] });

    // FORMULA → INTEGER drops the formula.
    const back = await apiPut(`/api/v1/metrics/${m.id}`, body({ label: "Ratio", type: "INTEGER" }), bearer(me.token));
    expect(back.status).toBe(200);
    expect(((await back.json()) as { data: Resource }).data.attributes).toMatchObject({ type: "INTEGER", formula: null, expr: null });
  });
});

describe("metric authz", () => {
  it("a viewer may read but not create; a benchmark-scoped key cannot manage metrics", async () => {
    const me = await register();
    const viewer = await addMember(me.token, me.account_id, "viewer@example.com", "VIEWER");
    await create(me.token, { label: "Readable", type: "DECIMAL" });

    expect((await apiGet("/api/v1/metrics", bearer(viewer.memberToken))).status).toBe(200);
    expect((await apiPost("/api/v1/metrics", body({ label: "Nope", type: "DECIMAL" }), bearer(viewer.memberToken))).status).toBe(403);

    const bm = await makeBenchmark(me.token);
    const { key: benchKey } = await mintKey(me.token, { scope_type: "BENCHMARK", scope_ref: bm.id });
    expect((await apiGet("/api/v1/metrics", bearer(benchKey))).status).toBe(403);
    expect((await apiPost("/api/v1/metrics", body({ label: "Nope", type: "DECIMAL" }), bearer(benchKey))).status).toBe(403);
  });

  it("isolates tenants (another account's metric is 404)", async () => {
    const me = await register();
    const other = await register("other@example.com");
    const m = await create(me.token, { label: "Mine", type: "DECIMAL" });
    expect((await apiGet(`/api/v1/metrics/${m.id}`, bearer(other.token))).status).toBe(404);
  });
});
