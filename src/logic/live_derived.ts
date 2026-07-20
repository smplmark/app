// Live derived-metric resolution (compute-on-read from the LIVE library definition).
//
// A benchmark's `measurement_schema.derived` array is a SNAPSHOT copied from the library `metric` at
// link time (see src/schema/metric.ts `metricSnapshot` and src/data/benchmark_metrics.ts). That
// snapshot is still written and retained (for schema change-detection / History), but it is no longer
// authoritative for compute: the read path resolves derived metrics from the LIVE metric definition
// via the `benchmark_metric` join, so an author who edits a library metric's formula/unit/format/
// description sees it reflected on published benchmarks immediately. Immutability-via-snapshot is
// deferred and may be revisited.
//
// This helper loads, for a set of benchmarks, the live FORMULA metrics linked to each — compiling each
// metric's stored formula to the JSON Logic `expr` the compute-on-read engine (src/logic/derived.ts)
// evaluates. Read sites substitute the returned list for `schema.derived`, falling back to the stored
// snapshot only when a benchmark has no live FORMULA metrics linked.
import { metricExprToJsonLogic, parseStoredFormula } from "../schema/metric";
import type { DerivedDecl } from "../types";

interface LiveDerivedRow {
  benchmark_id: string;
  name: string;
  formula: string | null;
  unit: string | null;
  format: string | null;
  description: string | null;
}

/**
 * For each benchmark id, the list of DerivedDecls resolved from its LIVE, linked FORMULA metrics —
 * each `expr` compiled fresh from the current library `metric.formula`. Ordered by link creation then
 * metric name (a stable, snapshot-like order). Benchmarks with no live FORMULA metric are simply
 * absent from the map, so callers fall back to the stored `measurement_schema.derived` snapshot.
 * Empty input → empty Map (no query issued).
 */
export async function loadLiveDerivedByBenchmark(
  db: D1Database,
  benchmarkIds: string[],
): Promise<Map<string, DerivedDecl[]>> {
  const map = new Map<string, DerivedDecl[]>();
  if (benchmarkIds.length === 0) return map;

  const placeholders = benchmarkIds.map(() => "?").join(",");
  const rows = (
    await db
      .prepare(
        `SELECT bm.benchmark_id AS benchmark_id, m.name AS name, m.formula AS formula,` +
          ` m.unit AS unit, m.format AS format, m.description AS description` +
          ` FROM benchmark_metric bm JOIN metric m ON m.id = bm.metric_id` +
          ` WHERE bm.benchmark_id IN (${placeholders}) AND m.type = 'FORMULA'` +
          ` ORDER BY bm.created_at, m.name`,
      )
      .bind(...benchmarkIds)
      .all<LiveDerivedRow>()
  ).results;

  for (const row of rows) {
    const formula = parseStoredFormula(row.formula);
    if (formula === null) continue; // defensive: a null/unparseable formula contributes no derived metric
    const decl: DerivedDecl = { name: row.name, expr: metricExprToJsonLogic(formula) };
    if (row.unit) decl.unit = row.unit;
    if (row.format) decl.format = row.format;
    if (row.description) decl.description = row.description;
    let list = map.get(row.benchmark_id);
    if (list === undefined) {
      list = [];
      map.set(row.benchmark_id, list);
    }
    list.push(decl);
  }
  return map;
}
