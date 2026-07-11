import { ConflictError } from "../errors";
import { orderByClause, type Sort } from "../query/sort";
import type { BenchmarkTargetRow } from "../types";
import { isUniqueViolation } from "./d1";

export interface CreateBenchmarkTargetInput {
  benchmark_id: string;
  target_id: string;
}

export async function createBenchmarkTarget(
  db: D1Database,
  input: CreateBenchmarkTargetInput,
): Promise<BenchmarkTargetRow> {
  const now = Date.now();
  const row: BenchmarkTargetRow = {
    id: crypto.randomUUID(),
    benchmark_id: input.benchmark_id,
    target_id: input.target_id,
    created_at: now,
  };
  try {
    await db
      .prepare(
        "INSERT INTO benchmark_target (id, benchmark_id, target_id, created_at) VALUES (?,?,?,?)",
      )
      .bind(row.id, row.benchmark_id, row.target_id, row.created_at)
      .run();
  } catch (e) {
    if (isUniqueViolation(e)) {
      throw new ConflictError("This target is already linked to this benchmark.");
    }
    throw e;
  }
  return row;
}

export async function getBenchmarkTargetById(
  db: D1Database,
  id: string,
): Promise<BenchmarkTargetRow | null> {
  return (
    (await db
      .prepare("SELECT * FROM benchmark_target WHERE id = ?")
      .bind(id)
      .first<BenchmarkTargetRow>()) ?? null
  );
}

/** Is the target a member of the benchmark? Powers the measurement write invariant + link idempotency. */
export async function isTargetLinked(
  db: D1Database,
  benchmarkId: string,
  targetId: string,
): Promise<boolean> {
  const r = await db
    .prepare("SELECT 1 AS x FROM benchmark_target WHERE benchmark_id = ? AND target_id = ?")
    .bind(benchmarkId, targetId)
    .first<{ x: number }>();
  return r !== null;
}

/** Is the target visible to the world — i.e. linked to at least one PUBLISHED/WITHDRAWN benchmark? */
export async function isTargetPublic(db: D1Database, targetId: string): Promise<boolean> {
  const r = await db
    .prepare(
      "SELECT 1 AS x FROM benchmark_target bt JOIN benchmark b ON b.id = bt.benchmark_id" +
        " WHERE bt.target_id = ? AND b.status IN ('PUBLISHED','WITHDRAWN') LIMIT 1",
    )
    .bind(targetId)
    .first<{ x: number }>();
  return r !== null;
}

/** Does the target belong to any benchmark that is not PRIVATE? (Blocks destructive edits/deletes.) */
export async function targetHasNonPrivateBenchmark(
  db: D1Database,
  targetId: string,
): Promise<boolean> {
  const r = await db
    .prepare(
      "SELECT 1 AS x FROM benchmark_target bt JOIN benchmark b ON b.id = bt.benchmark_id" +
        " WHERE bt.target_id = ? AND b.status != 'PRIVATE' LIMIT 1",
    )
    .bind(targetId)
    .first<{ x: number }>();
  return r !== null;
}

/**
 * Is the target linked to any benchmark that is marked ready for publishing (PRIVATE && draft=0)? Its
 * subtree is frozen (§2), so the target's own mutations must be refused too — a target is shared, so
 * the freeze reaches it through any one of its benchmarks.
 */
export async function targetHasFrozenBenchmark(
  db: D1Database,
  targetId: string,
): Promise<boolean> {
  const r = await db
    .prepare(
      "SELECT 1 AS x FROM benchmark_target bt JOIN benchmark b ON b.id = bt.benchmark_id" +
        " WHERE bt.target_id = ? AND b.status = 'PRIVATE' AND b.draft = 0 LIMIT 1",
    )
    .bind(targetId)
    .first<{ x: number }>();
  return r !== null;
}

/** Serves the links-per-benchmark ceiling check on link. */
export async function countLinksForBenchmark(
  db: D1Database,
  benchmarkId: string,
): Promise<number> {
  const r = await db
    .prepare("SELECT COUNT(*) AS n FROM benchmark_target WHERE benchmark_id = ?")
    .bind(benchmarkId)
    .first<{ n: number }>();
  return r?.n ?? 0;
}

const LINK_COLUMNS: Record<string, string> = {
  created_at: "benchmark_target.created_at",
};

export interface ListBenchmarkTargetsInput {
  benchmarkId?: string;
  targetId?: string;
  /** Restrict to links whose benchmark is PUBLISHED/WITHDRAWN — set for an uncovered target scope so
   *  a private benchmark's id is never disclosed through a shared target's link rows. */
  publicOnly?: boolean;
  sort: Sort;
  limit: number;
  offset: number;
  includeTotal: boolean;
}

/** List the links for a benchmark or for a target (at least one filter is set by the route). */
export async function listBenchmarkTargets(
  db: D1Database,
  input: ListBenchmarkTargetsInput,
): Promise<{ rows: BenchmarkTargetRow[]; total?: number }> {
  const clauses: string[] = [];
  const binds: unknown[] = [];
  if (input.benchmarkId !== undefined) {
    clauses.push("benchmark_target.benchmark_id = ?");
    binds.push(input.benchmarkId);
  }
  if (input.targetId !== undefined) {
    clauses.push("benchmark_target.target_id = ?");
    binds.push(input.targetId);
  }
  // Only join the benchmark when we must filter by its status (keeps the common path index-only).
  const join = input.publicOnly
    ? "FROM benchmark_target JOIN benchmark ON benchmark.id = benchmark_target.benchmark_id"
    : "FROM benchmark_target";
  if (input.publicOnly) clauses.push("benchmark.status IN ('PUBLISHED','WITHDRAWN')");
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const order = orderByClause(input.sort, (f) => LINK_COLUMNS[f], "benchmark_target.id");
  const rows = (
    await db
      .prepare(`SELECT benchmark_target.* ${join} ${where} ${order} LIMIT ? OFFSET ?`)
      .bind(...binds, input.limit, input.offset)
      .all<BenchmarkTargetRow>()
  ).results;

  let total: number | undefined;
  if (input.includeTotal) {
    const r = await db
      .prepare(`SELECT COUNT(*) AS n ${join} ${where}`)
      .bind(...binds)
      .first<{ n: number }>();
    total = r?.n ?? 0;
  }
  return { rows, total };
}

/**
 * Unlink a target from a benchmark and delete the measurements that named that target under the
 * benchmark's runs. The route guarantees the benchmark is PRIVATE, so no published data is destroyed.
 * The target row itself survives (it's account-owned and may be linked elsewhere).
 */
export async function deleteBenchmarkTargetCascade(
  db: D1Database,
  link: { id: string; benchmark_id: string; target_id: string },
): Promise<void> {
  await db.batch([
    db
      .prepare(
        "DELETE FROM measurement WHERE target_id = ? AND run_id IN (SELECT id FROM run WHERE benchmark_id = ?)",
      )
      .bind(link.target_id, link.benchmark_id),
    db.prepare("DELETE FROM benchmark_target WHERE id = ?").bind(link.id),
  ]);
}
