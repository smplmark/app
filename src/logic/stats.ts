// Descriptive statistics over a set of measurements. Aggregation happens in JS (not SQL) for two
// reasons: SQLite/D1 has no native median/percentile, and a benchmark's numbers include DERIVED
// metrics that aren't stored (e.g. the minute-skew = created_at mod 60000) — those must be computed
// per row with the same read-path evaluator the measurement serializer uses, so the summary always
// matches what the measurements table shows. Grouped by subject: the "run, per subject" grain.
import type { AggMeasurementRow } from "../data/measurements";
import { parseMeasurementSchema } from "../schema/measurement_schema";
import type { DerivedDecl, MeasurementSchema } from "../types";
import { computeMetrics } from "./derived";

/** The ten descriptive statistics computed for one metric over a set of measurements. */
export interface MetricStats {
  count: number;
  sum: number;
  min: number;
  max: number;
  avg: number;
  median: number;
  p75: number;
  p90: number;
  p95: number;
  p99: number;
}

export interface SubjectStats {
  /** The subject's public key (matches the `subject` field on a measurement resource). */
  subject: string;
  /** Per-metric statistics, keyed by metric name. A metric appears only if it had ≥1 finite value. */
  metrics: Record<string, MetricStats>;
}

export interface MeasurementStats {
  /** Total measurements aggregated (post-filter, post-cap). */
  measurements: number;
  /** True when the scan hit the row cap, so the figures are over a subset — narrow the timeframe. */
  truncated: boolean;
  subjects: SubjectStats[];
}

/**
 * The p-th quantile (p in [0,1]) of an ascending, non-empty array by R-7 linear interpolation —
 * the definition Excel's PERCENTILE.INC and NumPy's default use, chosen to match the product's
 * Excel-style number formats. `median` is simply percentile(sorted, 0.5).
 */
export function percentile(sorted: number[], p: number): number {
  const n = sorted.length;
  if (n === 1) return sorted[0];
  const rank = p * (n - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (rank - lo) * (sorted[hi] - sorted[lo]);
}

/**
 * Compute the ten statistics over `values`. Non-finite values are skipped; `count` is the number of
 * finite values actually aggregated. Returns null when there is nothing finite to summarize.
 */
export function computeStats(values: number[]): MetricStats | null {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  const count = sorted.length;
  if (count === 0) return null;
  let sum = 0;
  for (const v of sorted) sum += v;
  return {
    count,
    sum,
    min: sorted[0],
    max: sorted[count - 1],
    avg: sum / count,
    median: percentile(sorted, 0.5),
    p75: percentile(sorted, 0.75),
    p90: percentile(sorted, 0.9),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
  };
}

/**
 * Group aggregate rows by subject, computing each measurement's merged (stored + derived) metric bag
 * with `computeMetrics`, then reduce each subject×metric bucket to its statistics. Subjects keep
 * first-seen order; a benchmark's schema is parsed once and cached (compute-on-read is O(rows × derived)).
 *
 * Derived metrics are computed from the LIVE library definition: `liveDerived` maps a benchmark id to
 * the DerivedDecls resolved from its linked FORMULA metrics (loadLiveDerivedByBenchmark). The stored
 * `measurement_schema.derived` snapshot is used only as a fallback for a benchmark absent from the map
 * (i.e. one with no live FORMULA metric). This keeps the summary consistent with what the measurements
 * table shows when an author edits a library metric.
 */
export function summarizeMeasurements(
  rows: AggMeasurementRow[],
  truncated: boolean,
  liveDerived: Map<string, DerivedDecl[]>,
): MeasurementStats {
  const schemaCache = new Map<string, MeasurementSchema>();
  const bySubject = new Map<string, Map<string, number[]>>();
  const order: string[] = [];

  for (const row of rows) {
    let parsed = schemaCache.get(row.measurement_schema);
    if (parsed === undefined) {
      parsed = parseMeasurementSchema(row.measurement_schema);
      schemaCache.set(row.measurement_schema, parsed);
    }
    // Live derived (from the current library metric) wins over the stored snapshot; fall back to the
    // snapshot only when the benchmark has no live FORMULA metric linked.
    const live = liveDerived.get(row.benchmark_id);
    const schema: MeasurementSchema = {
      metrics: parsed.metrics,
      derived: live ?? parsed.derived,
      chart: parsed.chart,
    };
    const merged = computeMetrics(row.metrics, schema, {
      created_at: row.created_at,
      run: { started_at: row.run_started_at, ended_at: row.run_ended_at },
    });
    if (merged === null) continue;

    let metricMap = bySubject.get(row.subject_key);
    if (metricMap === undefined) {
      metricMap = new Map();
      bySubject.set(row.subject_key, metricMap);
      order.push(row.subject_key);
    }
    for (const [name, value] of Object.entries(merged)) {
      if (typeof value === "number" && Number.isFinite(value)) {
        let arr = metricMap.get(name);
        if (arr === undefined) {
          arr = [];
          metricMap.set(name, arr);
        }
        arr.push(value);
      }
    }
  }

  const subjects: SubjectStats[] = order.map((subject) => {
    const metricMap = bySubject.get(subject)!;
    const metrics: Record<string, MetricStats> = {};
    for (const [name, values] of metricMap) {
      // A bucket only exists because ≥1 finite value was pushed into it, so computeStats is non-null.
      metrics[name] = computeStats(values)!;
    }
    return { subject, metrics };
  });

  return { measurements: rows.length, truncated, subjects };
}
