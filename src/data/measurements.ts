import type { DateRange } from "../query/daterange";
import { dateRangePredicate } from "../query/predicates";
import { orderByClause, type Sort } from "../query/sort";
import type { MeasurementRow } from "../types";

export interface InsertMeasurementInput {
  run_id: string;
  subject_id: string;
  created_at: number;
  metrics: string | null;
  meta: string | null;
  client_ip: string | null;
}

/** Does this run carry any measurements? Gates deleting a run of a published benchmark. */
export async function runHasMeasurements(db: D1Database, runId: string): Promise<boolean> {
  const r = await db
    .prepare("SELECT 1 AS x FROM measurement WHERE run_id = ? LIMIT 1")
    .bind(runId)
    .first<{ x: number }>();
  return r !== null;
}

/** Does any run of this benchmark carry a measurement? Gates publishing. */
export async function benchmarkHasMeasurements(
  db: D1Database,
  benchmarkId: string,
): Promise<boolean> {
  const r = await db
    .prepare(
      "SELECT 1 AS x FROM measurement JOIN run ON run.id = measurement.run_id WHERE run.benchmark_id = ? LIMIT 1",
    )
    .bind(benchmarkId)
    .first<{ x: number }>();
  return r !== null;
}

/** Load one measurement by its rowid (for authz + delete + the correction response). Carries the run's
 *  and subject's keys so the serialized `run`/`subject` references are their public ids, not UUIDs. */
export async function getMeasurementById(
  db: D1Database,
  id: number,
): Promise<(MeasurementRow & { subject_key: string; run_key: string }) | null> {
  return (
    (await db
      .prepare(
        "SELECT measurement.*, subject.key AS subject_key, run.key AS run_key FROM measurement" +
          " JOIN subject ON subject.id = measurement.subject_id" +
          " JOIN run ON run.id = measurement.run_id WHERE measurement.id = ?",
      )
      .bind(id)
      .first<MeasurementRow & { subject_key: string; run_key: string }>()) ?? null
  );
}

/** Delete one measurement by its rowid. The route guards that the benchmark is still a draft. */
export async function deleteMeasurement(db: D1Database, id: number): Promise<void> {
  await db.prepare("DELETE FROM measurement WHERE id = ?").bind(id).run();
}

/** Correct a measurement in place (edit-with-audit; the route records before/after). */
export async function updateMeasurement(
  db: D1Database,
  id: number,
  input: { created_at: number; metrics: string | null; meta: string | null },
): Promise<void> {
  await db
    .prepare("UPDATE measurement SET created_at=?, metrics=?, meta=? WHERE id=?")
    .bind(input.created_at, input.metrics, input.meta, id)
    .run();
}

/** Insert a measurement; returns the database-assigned rowid. */
export async function insertMeasurement(
  db: D1Database,
  input: InsertMeasurementInput,
): Promise<number> {
  const res = await db
    .prepare(
      "INSERT INTO measurement (run_id, subject_id, created_at, metrics, meta, client_ip) VALUES (?,?,?,?,?,?)",
    )
    .bind(
      input.run_id,
      input.subject_id,
      input.created_at,
      input.metrics,
      input.meta,
      input.client_ip,
    )
    .run();
  return res.meta.last_row_id;
}

/**
 * A measurement row for reads, carrying its benchmark's measurement_schema and its run's timing
 * context (for compute-on-read of relative-time derived metrics like elapsed_ms).
 */
export interface MeasurementListRow {
  id: number;
  run_id: string;
  subject_id: string;
  /** The subject's human key — the subject's public id on the wire (serialization emits this). */
  subject_key: string;
  /** The run's human key — the run's public id on the wire (serialization emits this). */
  run_key: string;
  /** The owning benchmark's id (run.benchmark_id) — used to resolve LIVE derived metrics per row
   *  (loadLiveDerivedByBenchmark), which supersede the stored measurement_schema.derived snapshot. */
  benchmark_id: string;
  created_at: number;
  metrics: string | null;
  meta: string | null;
  measurement_schema: string;
  run_started_at: number | null;
  run_ended_at: number | null;
}

export interface MeasurementScope {
  run?: string;
  subject?: string;
  benchmark?: string;
  /** For a subject scope with an uncovered caller: restrict to the subject's PUBLISHED/WITHDRAWN
   *  benchmarks, so a private sibling benchmark's measurements never leak (a subject is shared). */
  subjectPublicOnly?: boolean;
}

export interface ListMeasurementsInput {
  scope: MeasurementScope;
  range?: DateRange;
  sort: Sort;
  limit: number;
  offset: number;
  includeTotal: boolean;
}

// A measurement names both its run and its subject directly; the benchmark hangs off the run
// (run.benchmark_id). The subject scope filters measurement.subject_id; the subject JOIN also carries
// subject.key so serialization can emit the subject's public key rather than its internal UUID.
const JOINS =
  "FROM measurement" +
  " JOIN run ON run.id = measurement.run_id" +
  " JOIN benchmark ON benchmark.id = run.benchmark_id" +
  " JOIN subject ON subject.id = measurement.subject_id";

const MEASUREMENT_COLUMNS: Record<string, string> = {
  created_at: "measurement.created_at",
};

function buildScopeWhere(scope: MeasurementScope, range?: DateRange): { sql: string; binds: unknown[] } {
  const clauses: string[] = [];
  const binds: unknown[] = [];

  if (range) {
    const pred = dateRangePredicate("measurement.created_at", range);
    if (pred.sql) {
      clauses.push(pred.sql);
      binds.push(...pred.binds);
    }
  }

  if (scope.run !== undefined) {
    clauses.push("measurement.run_id = ?");
    binds.push(scope.run);
  } else if (scope.subject !== undefined) {
    clauses.push("measurement.subject_id = ?");
    binds.push(scope.subject);
    // A subject spans benchmarks; an uncovered caller only sees measurements under its public ones.
    if (scope.subjectPublicOnly) {
      clauses.push("benchmark.status IN ('PUBLISHED','WITHDRAWN')");
    }
  } else if (scope.benchmark !== undefined) {
    clauses.push("benchmark.id = ?");
    binds.push(scope.benchmark);
  }

  return { sql: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "", binds };
}

export async function listMeasurements(
  db: D1Database,
  input: ListMeasurementsInput,
): Promise<{ rows: MeasurementListRow[]; total?: number }> {
  const where = buildScopeWhere(input.scope, input.range);
  const order = orderByClause(input.sort, (f) => MEASUREMENT_COLUMNS[f], "measurement.id");
  const rows = (
    await db
      .prepare(
        `SELECT measurement.id AS id, measurement.run_id AS run_id, measurement.subject_id AS subject_id,` +
          ` subject.key AS subject_key, run.key AS run_key, run.benchmark_id AS benchmark_id,` +
          ` measurement.created_at AS created_at, measurement.metrics AS metrics, measurement.meta AS meta,` +
          ` benchmark.measurement_schema AS measurement_schema,` +
          ` run.started_at AS run_started_at, run.ended_at AS run_ended_at` +
          ` ${JOINS} ${where.sql} ${order} LIMIT ? OFFSET ?`,
      )
      .bind(...where.binds, input.limit, input.offset)
      .all<MeasurementListRow>()
  ).results;

  let total: number | undefined;
  if (input.includeTotal) {
    const r = await db
      .prepare(`SELECT COUNT(*) AS n ${JOINS} ${where.sql}`)
      .bind(...where.binds)
      .first<{ n: number }>();
    total = r?.n ?? 0;
  }
  return { rows, total };
}

/**
 * A lean measurement projection for aggregate statistics: just what's needed to compute the merged
 * (stored + derived) metric bag per row and group by subject. No id/meta/client_ip — those never
 * enter a summary.
 */
export interface AggMeasurementRow {
  /** The subject's public key — the grouping dimension (matches a measurement's `subject` field). */
  subject_key: string;
  /** The owning benchmark's id (run.benchmark_id) — used to resolve LIVE derived metrics per row
   *  (loadLiveDerivedByBenchmark), which supersede the stored measurement_schema.derived snapshot. */
  benchmark_id: string;
  created_at: number;
  metrics: string | null;
  measurement_schema: string;
  run_started_at: number | null;
  run_ended_at: number | null;
}

export interface AggregateMeasurementsInput {
  scope: MeasurementScope;
  range?: DateRange;
  /** Row-scan ceiling. Beyond this the result is flagged `truncated` (a run is bounded, so this is a
   *  guardrail, not an expected path). */
  cap: number;
}

/**
 * Pull every measurement matching the scope (+ optional timeframe) for a statistics summary — the full
 * filtered set, NOT a page. Fetches one extra row past `cap` to detect truncation without a COUNT.
 */
export async function aggregateMeasurements(
  db: D1Database,
  input: AggregateMeasurementsInput,
): Promise<{ rows: AggMeasurementRow[]; truncated: boolean }> {
  const where = buildScopeWhere(input.scope, input.range);
  const rows = (
    await db
      .prepare(
        `SELECT subject.key AS subject_key, run.benchmark_id AS benchmark_id, measurement.created_at AS created_at,` +
          ` measurement.metrics AS metrics, benchmark.measurement_schema AS measurement_schema,` +
          ` run.started_at AS run_started_at, run.ended_at AS run_ended_at` +
          ` ${JOINS} ${where.sql} LIMIT ?`,
      )
      .bind(...where.binds, input.cap + 1)
      .all<AggMeasurementRow>()
  ).results;

  const truncated = rows.length > input.cap;
  return { rows: truncated ? rows.slice(0, input.cap) : rows, truncated };
}
