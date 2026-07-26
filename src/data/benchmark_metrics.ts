// Data-access for the benchmark_metric M:N link. Linking/unlinking is not just a join-row change: it
// also appends/removes the metric's snapshot in the benchmark's measurement_schema. The route computes
// the new schema JSON; this layer persists the join-row change and the schema update ATOMICALLY via
// db.batch so the two never diverge.
//
// NOTE (live compute-on-read): the measurement_schema.derived snapshot written here is RETAINED (for
// schema change-detection / History) but is NO LONGER AUTHORITATIVE for compute. Derived metrics are
// resolved on read from the LIVE `metric` definition via this very benchmark_metric join (see
// src/logic/live_derived.ts `loadLiveDerivedByBenchmark`), so editing a library metric takes effect on
// published benchmarks immediately. The snapshot storage format is unchanged and still written on
// every link/unlink; immutability-via-snapshot is deferred and may be revisited.
import { ConflictError } from "../errors";
import { orderByClause, type Sort } from "../query/sort";
import type { BenchmarkMetricRow } from "../types";
import { isUniqueViolation } from "./d1";

export interface CreateBenchmarkMetricInput {
  benchmark_id: string;
  metric_id: string;
  /** The benchmark's new measurement_schema (metric snapshot appended), serialized. */
  schemaJson: string;
}

/** Insert the link and write the benchmark's updated schema in one transaction. */
export async function createBenchmarkMetricLink(
  db: D1Database,
  input: CreateBenchmarkMetricInput,
): Promise<BenchmarkMetricRow> {
  const now = Date.now();
  const row: BenchmarkMetricRow = {
    id: crypto.randomUUID(),
    benchmark_id: input.benchmark_id,
    metric_id: input.metric_id,
    created_at: now,
  };
  try {
    await db.batch([
      db
        .prepare("INSERT INTO benchmark_metric (id, benchmark_id, metric_id, created_at) VALUES (?,?,?,?)")
        .bind(row.id, row.benchmark_id, row.metric_id, row.created_at),
      // The snapshot is still written (retained for change-detection / History), but reads resolve
      // derived metrics from the live metric via this join — see loadLiveDerivedByBenchmark.
      db
        .prepare("UPDATE benchmark SET measurement_schema = ?, updated_at = ? WHERE id = ?")
        .bind(input.schemaJson, now, input.benchmark_id),
    ]);
  } catch (e) {
    if (isUniqueViolation(e)) {
      throw new ConflictError("This metric is already linked to this benchmark.");
    }
    throw e;
  }
  return row;
}

export async function getBenchmarkMetricById(
  db: D1Database,
  id: string,
): Promise<BenchmarkMetricRow | null> {
  return (
    (await db
      .prepare("SELECT * FROM benchmark_metric WHERE id = ?")
      .bind(id)
      .first<BenchmarkMetricRow>()) ?? null
  );
}

/** Is the metric already linked to the benchmark? (Idempotency / a friendlier pre-check than the pair index.) */
export async function isMetricLinked(
  db: D1Database,
  benchmarkId: string,
  metricId: string,
): Promise<boolean> {
  const r = await db
    .prepare("SELECT 1 AS x FROM benchmark_metric WHERE benchmark_id = ? AND metric_id = ?")
    .bind(benchmarkId, metricId)
    .first<{ x: number }>();
  return r !== null;
}

/** Serves the links-per-benchmark ceiling check on link. */
export async function countLinksForBenchmark(
  db: D1Database,
  benchmarkId: string,
): Promise<number> {
  const r = await db
    .prepare("SELECT COUNT(*) AS n FROM benchmark_metric WHERE benchmark_id = ?")
    .bind(benchmarkId)
    .first<{ n: number }>();
  return r?.n ?? 0;
}

/** How many benchmarks link this metric — guards deletion of a metric that's still in use. */
export async function countBenchmarksForMetric(db: D1Database, metricId: string): Promise<number> {
  const r = await db
    .prepare("SELECT COUNT(*) AS n FROM benchmark_metric WHERE metric_id = ?")
    .bind(metricId)
    .first<{ n: number }>();
  return r?.n ?? 0;
}

const LINK_COLUMNS: Record<string, string> = {
  created_at: "benchmark_metric.created_at",
};

export interface ListBenchmarkMetricsInput {
  benchmarkId?: string;
  metricId?: string;
  sort: Sort;
  limit: number;
  offset: number;
  includeTotal: boolean;
}

/** List the links for a benchmark or for a metric (at least one filter is set by the route). */
export async function listBenchmarkMetrics(
  db: D1Database,
  input: ListBenchmarkMetricsInput,
): Promise<{ rows: BenchmarkMetricRow[]; total?: number }> {
  const clauses: string[] = [];
  const binds: unknown[] = [];
  if (input.benchmarkId !== undefined) {
    clauses.push("benchmark_id = ?");
    binds.push(input.benchmarkId);
  }
  if (input.metricId !== undefined) {
    clauses.push("metric_id = ?");
    binds.push(input.metricId);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const order = orderByClause(input.sort, (f) => LINK_COLUMNS[f], "benchmark_metric.id");
  const rows = (
    await db
      .prepare(`SELECT benchmark_metric.* FROM benchmark_metric ${where} ${order} LIMIT ? OFFSET ?`)
      .bind(...binds, input.limit, input.offset)
      .all<BenchmarkMetricRow>()
  ).results;

  let total: number | undefined;
  if (input.includeTotal) {
    const r = await db
      .prepare(`SELECT COUNT(*) AS n FROM benchmark_metric ${where}`)
      .bind(...binds)
      .first<{ n: number }>();
    total = r?.n ?? 0;
  }
  return { rows, total };
}

/** Unlink a metric and write the benchmark's schema (snapshot removed) in one transaction. */
export async function deleteBenchmarkMetricLink(
  db: D1Database,
  input: { id: string; benchmark_id: string; schemaJson: string },
): Promise<void> {
  const now = Date.now();
  await db.batch([
    db.prepare("DELETE FROM benchmark_metric WHERE id = ?").bind(input.id),
    // The snapshot is still updated (retained for change-detection / History), but reads resolve
    // derived metrics from the live metric via this join — see loadLiveDerivedByBenchmark.
    db
      .prepare("UPDATE benchmark SET measurement_schema = ?, updated_at = ? WHERE id = ?")
      .bind(input.schemaJson, now, input.benchmark_id),
  ]);
}
