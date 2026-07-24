import { ConflictError } from "../errors";
import { orderByClause, type Sort } from "../query/sort";
import type { AuthContext, RunRow } from "../types";
import { touchBenchmarkStmt } from "./benchmarks";
import { isUniqueViolation, jsonOrNull } from "./d1";

export interface CreateRunInput {
  benchmark_id: string;
  key: string;
  name: string | null;
  details: unknown | null;
  started_at: number | null;
  ended_at: number | null;
}

export async function createRun(
  db: D1Database,
  input: CreateRunInput,
): Promise<RunRow> {
  const now = Date.now();
  const row: RunRow = {
    id: crypto.randomUUID(),
    benchmark_id: input.benchmark_id,
    key: input.key,
    name: input.name,
    details: jsonOrNull(input.details),
    started_at: input.started_at,
    ended_at: input.ended_at,
    invalidated_at: null,
    invalidation_reason: null,
    invalidated_by_user_id: null,
    created_at: now,
    updated_at: now,
  };
  try {
    // Bump the parent benchmark's updated_at in the same batch so its public "last updated" moves.
    await db.batch([
      db
        .prepare(
          "INSERT INTO run (id, benchmark_id, key, name, details, started_at, ended_at, invalidated_at, invalidation_reason, invalidated_by_user_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,NULL,NULL,NULL,?,?)",
        )
        .bind(
          row.id,
          row.benchmark_id,
          row.key,
          row.name,
          row.details,
          row.started_at,
          row.ended_at,
          row.created_at,
          row.updated_at,
        ),
      touchBenchmarkStmt(db, row.benchmark_id, now),
    ]);
  } catch (e) {
    if (isUniqueViolation(e)) {
      throw new ConflictError(
        `A run with key ${JSON.stringify(input.key)} already exists for this benchmark.`,
      );
    }
    throw e;
  }
  return row;
}

/** Serves the runs-per-benchmark ceiling check on create. */
export async function countRunsForBenchmark(
  db: D1Database,
  benchmarkId: string,
): Promise<number> {
  const r = await db
    .prepare("SELECT COUNT(*) AS n FROM run WHERE benchmark_id = ?")
    .bind(benchmarkId)
    .first<{ n: number }>();
  return r?.n ?? 0;
}

export async function getRunById(
  db: D1Database,
  id: string,
): Promise<RunRow | null> {
  return (
    (await db.prepare("SELECT * FROM run WHERE id = ?").bind(id).first<RunRow>()) ?? null
  );
}

/** Resolve a run within a benchmark by its human key (unique per benchmark, per UNIQUE(benchmark_id, key)). */
export async function getRunByBenchmarkKey(
  db: D1Database,
  benchmarkId: string,
  key: string,
): Promise<RunRow | null> {
  return (
    (await db
      .prepare("SELECT * FROM run WHERE benchmark_id = ? AND key = ?")
      .bind(benchmarkId, key)
      .first<RunRow>()) ?? null
  );
}

/**
 * Resolve a world-visible run by its key, with no benchmark context — the anonymous read path, where
 * a bare key can't be scoped to a benchmark. Restricted to runs whose benchmark is PUBLISHED/WITHDRAWN
 * so a private run is never disclosed. Run keys are unique only per benchmark (not per account), so a
 * key shared by two accounts' public runs resolves to one arbitrarily; both are public, so no private
 * data is exposed either way.
 */
export async function getPublicRunByKey(
  db: D1Database,
  key: string,
): Promise<RunRow | null> {
  return (
    (await db
      .prepare(
        "SELECT run.* FROM run" +
          " JOIN benchmark b ON b.id = run.benchmark_id" +
          " WHERE run.key = ? AND b.status IN ('PUBLISHED','WITHDRAWN') LIMIT 1",
      )
      .bind(key)
      .first<RunRow>()) ?? null
  );
}

/**
 * Resolve a run reference (its key, or a raw UUID) for a mutating/ingest caller expected to own it.
 * A raw id is tried first (the legacy-UUID path); otherwise the key is resolved using the caller's
 * effective scope, because run keys are unique only within a benchmark and a bare key needs a
 * benchmark context to disambiguate:
 *  - RUN scope: the one scoped run, and only when its key matches the reference;
 *  - BENCHMARK scope: the run with that key under the scoped benchmark;
 *  - ACCOUNT scope: an account-wide match by key, which is ambiguous (409) if two of the account's
 *    benchmarks share the key.
 * The caller still authorizes the resolved row (covers()), so a cross-account UUID still 404s there.
 */
export async function resolveOwnedRun(
  db: D1Database,
  auth: AuthContext,
  runRef: string,
  keyOnly = false,
): Promise<RunRow | null> {
  // `keyOnly` (the post-cutover measurements-POST mode) skips the legacy raw-UUID path so a run is
  // addressed only by its key, resolved within the caller's scope below.
  if (!keyOnly) {
    const byId = await getRunById(db, runRef);
    if (byId) return byId;
  }
  switch (auth.scope_type) {
    case "RUN": {
      // A RUN-scoped credential always carries its run's id in scope_ref (enforced at mint, per
      // covers()); a stray null would resolve to no run and fall through to null harmlessly.
      const row = await getRunById(db, auth.scope_ref as string);
      return row !== null && row.key === runRef ? row : null;
    }
    case "BENCHMARK":
      // A BENCHMARK-scoped credential always carries its benchmark's id in scope_ref (as above).
      return getRunByBenchmarkKey(db, auth.scope_ref as string, runRef);
    case "ACCOUNT": {
      const rows = (
        await db
          .prepare(
            "SELECT run.* FROM run" +
              " JOIN benchmark b ON b.id = run.benchmark_id" +
              " WHERE b.account_id = ? AND run.key = ? LIMIT 2",
          )
          .bind(auth.account_id, runRef)
          .all<RunRow>()
      ).results;
      if (rows.length === 1) return rows[0];
      if (rows.length >= 2) {
        throw new ConflictError(
          "Ambiguous run key across benchmarks; scope the API key to the benchmark.",
        );
      }
      return null;
    }
  }
}

/**
 * Resolve a run reference (its key, or a raw UUID) for a reader. A raw id first (the legacy-UUID
 * path); then, when the caller is authed, an account-wide match by key (reads may pick any match
 * arbitrarily); otherwise a world-visible run by key (the anonymous/public path). The caller still
 * applies its own visibility rule (covers()/isPublicStatus) to the returned row; this only resolves.
 */
export async function resolveRunForRead(
  db: D1Database,
  auth: AuthContext | null,
  runRef: string,
): Promise<RunRow | null> {
  const byId = await getRunById(db, runRef);
  if (byId) return byId;
  if (auth !== null) {
    return (
      (await db
        .prepare(
          "SELECT run.* FROM run" +
            " JOIN benchmark b ON b.id = run.benchmark_id" +
            " WHERE b.account_id = ? AND run.key = ? LIMIT 1",
        )
        .bind(auth.account_id, runRef)
        .first<RunRow>()) ?? null
    );
  }
  return getPublicRunByKey(db, runRef);
}

/** Is `key` already taken by a run under this benchmark? Backs auto-generated-key uniqueness. */
export async function runKeyExists(
  db: D1Database,
  benchmarkId: string,
  key: string,
): Promise<boolean> {
  const r = await db
    .prepare("SELECT 1 AS x FROM run WHERE benchmark_id = ? AND key = ?")
    .bind(benchmarkId, key)
    .first<{ x: number }>();
  return r !== null;
}

export interface ListRunsInput {
  /** Runs are benchmark-owned; a listing is always scoped to one benchmark. */
  benchmarkId: string;
  filterKey?: string;
  sort: Sort;
  limit: number;
  offset: number;
  includeTotal: boolean;
}

const RUN_COLUMNS: Record<string, string> = {
  key: "key",
  started_at: "started_at",
  created_at: "created_at",
  updated_at: "updated_at",
};

export async function listRuns(
  db: D1Database,
  input: ListRunsInput,
): Promise<{ rows: RunRow[]; total?: number }> {
  const clauses: string[] = [];
  const binds: unknown[] = [];
  clauses.push("benchmark_id = ?");
  binds.push(input.benchmarkId);
  if (input.filterKey !== undefined) {
    clauses.push("key = ?");
    binds.push(input.filterKey);
  }
  const where = `WHERE ${clauses.join(" AND ")}`;
  const order = orderByClause(input.sort, (f) => RUN_COLUMNS[f], "id");
  const rows = (
    await db
      .prepare(`SELECT * FROM run ${where} ${order} LIMIT ? OFFSET ?`)
      .bind(...binds, input.limit, input.offset)
      .all<RunRow>()
  ).results;

  let total: number | undefined;
  if (input.includeTotal) {
    const r = await db
      .prepare(`SELECT COUNT(*) AS n FROM run ${where}`)
      .bind(...binds)
      .first<{ n: number }>();
    total = r?.n ?? 0;
  }
  return { rows, total };
}

export interface UpdateRunInput {
  name: string | null;
  details: unknown | null;
  started_at: number | null;
  ended_at: number | null;
}

export async function updateRun(
  db: D1Database,
  id: string,
  input: UpdateRunInput,
): Promise<RunRow | null> {
  const existing = await getRunById(db, id);
  if (!existing) return null;
  const now = Date.now();
  const updated: RunRow = {
    ...existing,
    name: input.name,
    details: jsonOrNull(input.details),
    started_at: input.started_at,
    ended_at: input.ended_at,
    updated_at: now,
  };
  await db.batch([
    db
      .prepare("UPDATE run SET name=?, details=?, started_at=?, ended_at=?, updated_at=? WHERE id=?")
      .bind(updated.name, updated.details, updated.started_at, updated.ended_at, updated.updated_at, id),
    touchBenchmarkStmt(db, existing.benchmark_id, now),
  ]);
  return updated;
}

/** Stamp ended_at (idempotent-ish; only when currently live) and bump the parent benchmark's
 *  updated_at in the same batch. The route calls this only for a still-live run, so the run UPDATE
 *  always applies here. */
export async function endRun(
  db: D1Database,
  id: string,
  now: number,
  benchmarkId: string,
): Promise<RunRow | null> {
  await db.batch([
    db
      .prepare("UPDATE run SET ended_at=?, updated_at=? WHERE id=? AND ended_at IS NULL")
      .bind(now, now, id),
    touchBenchmarkStmt(db, benchmarkId, now),
  ]);
  return getRunById(db, id);
}

export async function invalidateRun(
  db: D1Database,
  id: string,
  now: number,
  reason: string | null,
  userId: string | null,
  benchmarkId: string,
): Promise<RunRow | null> {
  await db.batch([
    db
      .prepare(
        "UPDATE run SET invalidated_at=?, invalidation_reason=?, invalidated_by_user_id=?, updated_at=? WHERE id=?",
      )
      .bind(now, reason, userId, now, id),
    touchBenchmarkStmt(db, benchmarkId, now),
  ]);
  return getRunById(db, id);
}

export async function deleteRunCascade(
  db: D1Database,
  id: string,
  benchmarkId: string,
): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM measurement WHERE run_id = ?").bind(id),
    // A run-scoped key authorizes nothing once its run is gone, and no list surfaces it — delete it too.
    db.prepare("DELETE FROM api_key WHERE scope_type = 'RUN' AND scope_ref = ?").bind(id),
    db.prepare("DELETE FROM run WHERE id = ?").bind(id),
    // The run is gone but its benchmark survives — bump its "last updated" for the removal.
    touchBenchmarkStmt(db, benchmarkId, Date.now()),
  ]);
}
