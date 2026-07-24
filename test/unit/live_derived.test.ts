// loadLiveDerivedByBenchmark — resolve a benchmark's derived metrics from the LIVE library `metric`
// definition via the benchmark_metric join (the compute-on-read source that supersedes the stored
// measurement_schema.derived snapshot). Exercises the SQL, formula compilation, cosmetic facets,
// defensive skipping, grouping, and the empty-input short-circuit.
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { createAccount } from "../../src/data/accounts";
import { createBenchmark } from "../../src/data/benchmarks";
import { createMetric } from "../../src/data/metrics";
import { createSubjectType } from "../../src/data/subject_types";
import { loadLiveDerivedByBenchmark } from "../../src/logic/live_derived";
import type { MeasurementSchema } from "../../src/types";

// created_at MOD 3600000 — the fire-skew (mod one hour). Compiles to `{ "%": [{var:created_at}, 3600000] }`.
const SKEW_FORMULA = JSON.stringify({
  steps: [{ id: "A", kind: "OP", op: "MOD", a: { kind: "CREATED_AT" }, b: { kind: "NUMBER", value: 3_600_000 } }],
  result: "A",
});
// metrics.x * 2 — compiles to `{ "*": [{var:metrics.x}, 2] }`.
const DOUBLE_FORMULA = JSON.stringify({
  steps: [{ id: "A", kind: "OP", op: "MUL", a: { kind: "METRIC", name: "x" }, b: { kind: "NUMBER", value: 2 } }],
  result: "A",
});
const EMPTY_SCHEMA: MeasurementSchema = { metrics: [], derived: [] };

// D1 (miniflare) enforces foreign keys, so benchmark_metric needs real benchmark + metric parents.
const TABLES = ["measurement", "run", "subject", "benchmark_metric", "benchmark", "subject_type", "metric", "account"];
beforeEach(async () => {
  for (const t of TABLES) await env.DB.prepare(`DELETE FROM ${t}`).run();
});

/** A fresh account + a subject type + a benchmark (satisfies the benchmark_metric FK). */
async function makeBenchmarkRow(accountId: string, subjectTypeId: string, key: string): Promise<string> {
  const b = await createBenchmark(env.DB, {
    account_id: accountId, key, name: key, description: null, about: null, methodology: null, license: null,
    subject_type: subjectTypeId, measurement_schema: EMPTY_SCHEMA, category: "OTHER", created_by_user_id: null,
  });
  return b.id;
}

async function link(benchmarkId: string, metricId: string, createdAt: number): Promise<void> {
  await env.DB
    .prepare("INSERT INTO benchmark_metric (id, benchmark_id, metric_id, created_at) VALUES (?,?,?,?)")
    .bind(crypto.randomUUID(), benchmarkId, metricId, createdAt)
    .run();
}

describe("loadLiveDerivedByBenchmark", () => {
  it("returns an empty map for empty input (no query issued)", async () => {
    const map = await loadLiveDerivedByBenchmark(env.DB, []);
    expect(map.size).toBe(0);
  });

  it("resolves live FORMULA metrics — compiling expr, carrying cosmetic facets, skipping the rest", async () => {
    const acc = await createAccount(env.DB, { key: `acc-${crypto.randomUUID()}`, name: "Acc" });
    const st = await createSubjectType(env.DB, { account_id: acc.id, key: "st", name: "ST", fields: [] });
    const bench1 = await makeBenchmarkRow(acc.id, st.id, "bench-1");
    const benchEmpty = await makeBenchmarkRow(acc.id, st.id, "bench-empty");

    // A fully-cosmetic FORMULA metric and a bare one (no unit/format/description).
    const skew = await createMetric(env.DB, { account_id: acc.id, name: "skew_ms", label: "Skew", description: "Fire skew", type: "FORMULA", unit: "ms", format: "#,##0", formula: SKEW_FORMULA });
    const doubled = await createMetric(env.DB, { account_id: acc.id, name: "doubled", label: "Doubled", description: null, type: "FORMULA", unit: null, format: null, formula: DOUBLE_FORMULA });
    // A stored (INTEGER) metric — never contributes a derived decl (filtered by the SQL).
    const stored = await createMetric(env.DB, { account_id: acc.id, name: "throughput", label: "Throughput", description: null, type: "INTEGER", unit: "req/s", format: null, formula: null });
    // A FORMULA metric with a null formula — defensively skipped in the loop.
    const broken = await createMetric(env.DB, { account_id: acc.id, name: "broken", label: "Broken", description: null, type: "FORMULA", unit: null, format: null, formula: null });

    // Result order is ORDER BY bm.created_at: skew (t=1) precedes doubled (t=2).
    await link(bench1, doubled.id, 2);
    await link(bench1, skew.id, 1);
    await link(bench1, stored.id, 3);
    await link(bench1, broken.id, 4);

    const map = await loadLiveDerivedByBenchmark(env.DB, [bench1, benchEmpty]);
    // A benchmark with no live FORMULA metric is simply absent → the caller falls back to the snapshot.
    expect([...map.keys()]).toEqual([bench1]);
    expect(map.get(bench1)).toEqual([
      { name: "skew_ms", expr: { "%": [{ var: "created_at" }, 3_600_000] }, unit: "ms", format: "#,##0", description: "Fire skew" },
      { name: "doubled", expr: { "*": [{ var: "metrics.x" }, 2] } },
    ]);
  });

  it("groups derived metrics by benchmark id", async () => {
    const acc = await createAccount(env.DB, { key: `acc-${crypto.randomUUID()}`, name: "Acc" });
    const st = await createSubjectType(env.DB, { account_id: acc.id, key: "st", name: "ST", fields: [] });
    const bench1 = await makeBenchmarkRow(acc.id, st.id, "bench-1");
    const bench2 = await makeBenchmarkRow(acc.id, st.id, "bench-2");
    const m = await createMetric(env.DB, { account_id: acc.id, name: "skew_ms", label: "Skew", description: null, type: "FORMULA", unit: null, format: null, formula: SKEW_FORMULA });
    await link(bench1, m.id, 1);
    await link(bench2, m.id, 1);
    const map = await loadLiveDerivedByBenchmark(env.DB, [bench1, bench2]);
    expect(map.get(bench1)).toHaveLength(1);
    expect(map.get(bench2)).toHaveLength(1);
  });
});
