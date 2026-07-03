import type { DateRange } from "../query/daterange";
import { dateRangePredicate } from "../query/predicates";
import { orderByClause, type Sort } from "../query/sort";

export interface InsertObservationInput {
  run_id: string;
  created_at: number;
  metrics: string | null;
  meta: string | null;
  client_ip: string | null;
}

/** Insert an observation; returns the database-assigned rowid. */
export async function insertObservation(
  db: D1Database,
  input: InsertObservationInput,
): Promise<number> {
  const res = await db
    .prepare(
      "INSERT INTO observation (run_id, created_at, metrics, meta, client_ip) VALUES (?,?,?,?,?)",
    )
    .bind(input.run_id, input.created_at, input.metrics, input.meta, input.client_ip)
    .run();
  return res.meta.last_row_id;
}

/**
 * An observation row for reads, carrying its benchmark's sample_schema and its run's timing context
 * (for compute-on-read of relative-time derived metrics like elapsed_ms).
 */
export interface ObservationListRow {
  id: number;
  run_id: string;
  created_at: number;
  metrics: string | null;
  meta: string | null;
  sample_schema: string;
  run_started_at: number | null;
  run_ended_at: number | null;
}

export interface ObservationScope {
  run?: string;
  target?: string;
  benchmark?: string;
}

export interface ListObservationsInput {
  scope: ObservationScope;
  range?: DateRange;
  sort: Sort;
  limit: number;
  offset: number;
  includeTotal: boolean;
}

const JOINS =
  "FROM observation" +
  " JOIN run ON run.id = observation.run_id" +
  " JOIN target ON target.id = run.target_id" +
  " JOIN benchmark ON benchmark.id = target.benchmark_id";

const OBSERVATION_COLUMNS: Record<string, string> = {
  created_at: "observation.created_at",
};

function buildWhere(input: ListObservationsInput): { sql: string; binds: unknown[] } {
  const clauses: string[] = [];
  const binds: unknown[] = [];

  if (input.range) {
    const pred = dateRangePredicate("observation.created_at", input.range);
    if (pred.sql) {
      clauses.push(pred.sql);
      binds.push(...pred.binds);
    }
  }

  if (input.scope.run !== undefined) {
    clauses.push("observation.run_id = ?");
    binds.push(input.scope.run);
  } else if (input.scope.target !== undefined) {
    clauses.push("target.id = ?");
    binds.push(input.scope.target);
  } else if (input.scope.benchmark !== undefined) {
    clauses.push("benchmark.id = ?");
    binds.push(input.scope.benchmark);
  }

  return { sql: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "", binds };
}

export async function listObservations(
  db: D1Database,
  input: ListObservationsInput,
): Promise<{ rows: ObservationListRow[]; total?: number }> {
  const where = buildWhere(input);
  const order = orderByClause(input.sort, (f) => OBSERVATION_COLUMNS[f], "observation.id");
  const rows = (
    await db
      .prepare(
        `SELECT observation.id AS id, observation.run_id AS run_id, observation.created_at AS created_at,` +
          ` observation.metrics AS metrics, observation.meta AS meta,` +
          ` benchmark.sample_schema AS sample_schema,` +
          ` run.started_at AS run_started_at, run.ended_at AS run_ended_at` +
          ` ${JOINS} ${where.sql} ${order} LIMIT ? OFFSET ?`,
      )
      .bind(...where.binds, input.limit, input.offset)
      .all<ObservationListRow>()
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
