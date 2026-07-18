import { ConflictError } from "../errors";
import { orderByClause, type Sort } from "../query/sort";
import type { BenchmarkSubjectRow } from "../types";
import { isUniqueViolation } from "./d1";

export interface CreateBenchmarkSubjectInput {
  benchmark_id: string;
  subject_id: string;
}

export async function createBenchmarkSubject(
  db: D1Database,
  input: CreateBenchmarkSubjectInput,
): Promise<BenchmarkSubjectRow> {
  const now = Date.now();
  const row: BenchmarkSubjectRow = {
    id: crypto.randomUUID(),
    benchmark_id: input.benchmark_id,
    subject_id: input.subject_id,
    created_at: now,
  };
  try {
    await db
      .prepare(
        "INSERT INTO benchmark_subject (id, benchmark_id, subject_id, created_at) VALUES (?,?,?,?)",
      )
      .bind(row.id, row.benchmark_id, row.subject_id, row.created_at)
      .run();
  } catch (e) {
    if (isUniqueViolation(e)) {
      throw new ConflictError("This subject is already linked to this benchmark.");
    }
    throw e;
  }
  return row;
}

export async function getBenchmarkSubjectById(
  db: D1Database,
  id: string,
): Promise<BenchmarkSubjectRow | null> {
  return (
    (await db
      .prepare("SELECT * FROM benchmark_subject WHERE id = ?")
      .bind(id)
      .first<BenchmarkSubjectRow>()) ?? null
  );
}

/** Is the subject a member of the benchmark? Powers the measurement write invariant + link idempotency. */
export async function isSubjectLinked(
  db: D1Database,
  benchmarkId: string,
  subjectId: string,
): Promise<boolean> {
  const r = await db
    .prepare("SELECT 1 AS x FROM benchmark_subject WHERE benchmark_id = ? AND subject_id = ?")
    .bind(benchmarkId, subjectId)
    .first<{ x: number }>();
  return r !== null;
}

/** Is the subject visible to the world — i.e. linked to at least one PUBLISHED/WITHDRAWN benchmark? */
export async function isSubjectPublic(db: D1Database, subjectId: string): Promise<boolean> {
  const r = await db
    .prepare(
      "SELECT 1 AS x FROM benchmark_subject bt JOIN benchmark b ON b.id = bt.benchmark_id" +
        " WHERE bt.subject_id = ? AND b.status IN ('PUBLISHED','WITHDRAWN') LIMIT 1",
    )
    .bind(subjectId)
    .first<{ x: number }>();
  return r !== null;
}

/** Does the subject belong to any benchmark that is not PRIVATE? (Blocks destructive edits/deletes.) */
export async function subjectHasNonPrivateBenchmark(
  db: D1Database,
  subjectId: string,
): Promise<boolean> {
  const r = await db
    .prepare(
      "SELECT 1 AS x FROM benchmark_subject bt JOIN benchmark b ON b.id = bt.benchmark_id" +
        " WHERE bt.subject_id = ? AND b.status != 'PRIVATE' LIMIT 1",
    )
    .bind(subjectId)
    .first<{ x: number }>();
  return r !== null;
}

/**
 * Is the subject linked to any benchmark that is marked ready for publishing (PRIVATE && draft=0)? Its
 * subtree is frozen (§2), so the subject's own mutations must be refused too — a subject is shared, so
 * the freeze reaches it through any one of its benchmarks.
 */
export async function subjectHasFrozenBenchmark(
  db: D1Database,
  subjectId: string,
): Promise<boolean> {
  const r = await db
    .prepare(
      "SELECT 1 AS x FROM benchmark_subject bt JOIN benchmark b ON b.id = bt.benchmark_id" +
        " WHERE bt.subject_id = ? AND b.status = 'PRIVATE' AND b.draft = 0 LIMIT 1",
    )
    .bind(subjectId)
    .first<{ x: number }>();
  return r !== null;
}

/** Serves the links-per-benchmark ceiling check on link. */
export async function countLinksForBenchmark(
  db: D1Database,
  benchmarkId: string,
): Promise<number> {
  const r = await db
    .prepare("SELECT COUNT(*) AS n FROM benchmark_subject WHERE benchmark_id = ?")
    .bind(benchmarkId)
    .first<{ n: number }>();
  return r?.n ?? 0;
}

const LINK_COLUMNS: Record<string, string> = {
  created_at: "benchmark_subject.created_at",
};

export interface ListBenchmarkSubjectsInput {
  benchmarkId?: string;
  subjectId?: string;
  /** Restrict to links whose benchmark is PUBLISHED/WITHDRAWN — set for an uncovered subject scope so
   *  a private benchmark's id is never disclosed through a shared subject's link rows. */
  publicOnly?: boolean;
  sort: Sort;
  limit: number;
  offset: number;
  includeTotal: boolean;
}

/** List the links for a benchmark or for a subject (at least one filter is set by the route). */
export async function listBenchmarkSubjects(
  db: D1Database,
  input: ListBenchmarkSubjectsInput,
): Promise<{ rows: (BenchmarkSubjectRow & { subject_key: string })[]; total?: number }> {
  const clauses: string[] = [];
  const binds: unknown[] = [];
  if (input.benchmarkId !== undefined) {
    clauses.push("benchmark_subject.benchmark_id = ?");
    binds.push(input.benchmarkId);
  }
  if (input.subjectId !== undefined) {
    clauses.push("benchmark_subject.subject_id = ?");
    binds.push(input.subjectId);
  }
  // Always join the subject to carry its key (the subject's public id, emitted on the link). Join the
  // benchmark only when we must filter by its status.
  const join =
    "FROM benchmark_subject JOIN subject ON subject.id = benchmark_subject.subject_id" +
    (input.publicOnly
      ? " JOIN benchmark ON benchmark.id = benchmark_subject.benchmark_id"
      : "");
  if (input.publicOnly) clauses.push("benchmark.status IN ('PUBLISHED','WITHDRAWN')");
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const order = orderByClause(input.sort, (f) => LINK_COLUMNS[f], "benchmark_subject.id");
  const rows = (
    await db
      .prepare(
        `SELECT benchmark_subject.*, subject.key AS subject_key ${join} ${where} ${order} LIMIT ? OFFSET ?`,
      )
      .bind(...binds, input.limit, input.offset)
      .all<BenchmarkSubjectRow & { subject_key: string }>()
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
 * Unlink a subject from a benchmark and delete the measurements that named that subject under the
 * benchmark's runs. The route guarantees the benchmark is PRIVATE, so no published data is destroyed.
 * The subject row itself survives (it's account-owned and may be linked elsewhere).
 */
export async function deleteBenchmarkSubjectCascade(
  db: D1Database,
  link: { id: string; benchmark_id: string; subject_id: string },
): Promise<void> {
  await db.batch([
    db
      .prepare(
        "DELETE FROM measurement WHERE subject_id = ? AND run_id IN (SELECT id FROM run WHERE benchmark_id = ?)",
      )
      .bind(link.subject_id, link.benchmark_id),
    db.prepare("DELETE FROM benchmark_subject WHERE id = ?").bind(link.id),
  ]);
}
