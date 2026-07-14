import { ConflictError } from "../errors";
import { orderByClause, type Sort } from "../query/sort";
import type { SubjectRow } from "../types";
import { isUniqueViolation, jsonOrNull } from "./d1";

export interface CreateSubjectInput {
  account_id: string;
  subject_type_id: string;
  key: string;
  name: string;
  details: unknown | null;
}

export async function createSubject(
  db: D1Database,
  input: CreateSubjectInput,
): Promise<SubjectRow> {
  const now = Date.now();
  const row: SubjectRow = {
    id: crypto.randomUUID(),
    account_id: input.account_id,
    subject_type_id: input.subject_type_id,
    key: input.key,
    name: input.name,
    details: jsonOrNull(input.details),
    created_at: now,
    updated_at: now,
  };
  try {
    await db
      .prepare(
        "INSERT INTO subject (id, account_id, subject_type_id, key, name, details, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
      )
      .bind(row.id, row.account_id, row.subject_type_id, row.key, row.name, row.details, row.created_at, row.updated_at)
      .run();
  } catch (e) {
    if (isUniqueViolation(e)) {
      throw new ConflictError(
        `A subject with key ${JSON.stringify(input.key)} already exists in this account.`,
      );
    }
    throw e;
  }
  return row;
}

/** Is `key` already taken by a subject in this account? Backs auto-generated-key uniqueness. */
export async function subjectKeyExists(
  db: D1Database,
  accountId: string,
  key: string,
): Promise<boolean> {
  const r = await db
    .prepare("SELECT 1 AS x FROM subject WHERE account_id = ? AND key = ?")
    .bind(accountId, key)
    .first<{ x: number }>();
  return r !== null;
}

/** Serves the subjects-per-account ceiling check on create. */
export async function countSubjectsForAccount(
  db: D1Database,
  accountId: string,
): Promise<number> {
  const r = await db
    .prepare("SELECT COUNT(*) AS n FROM subject WHERE account_id = ?")
    .bind(accountId)
    .first<{ n: number }>();
  return r?.n ?? 0;
}

export async function getSubjectById(
  db: D1Database,
  id: string,
): Promise<SubjectRow | null> {
  return (
    (await db.prepare("SELECT * FROM subject WHERE id = ?").bind(id).first<SubjectRow>()) ??
    null
  );
}

const SUBJECT_COLUMNS: Record<string, string> = {
  name: "name",
  key: "key",
  created_at: "created_at",
  updated_at: "updated_at",
};

export interface ListAccountSubjectsInput {
  accountId: string;
  filterKey?: string;
  filterSubjectTypeId?: string;
  sort: Sort;
  limit: number;
  offset: number;
  includeTotal: boolean;
}

/** All subjects an account owns (the top-level Subjects list + the pick-or-create picker). */
export async function listAccountSubjects(
  db: D1Database,
  input: ListAccountSubjectsInput,
): Promise<{ rows: SubjectRow[]; total?: number }> {
  const clauses = ["account_id = ?"];
  const binds: unknown[] = [input.accountId];
  if (input.filterKey !== undefined) {
    clauses.push("key = ?");
    binds.push(input.filterKey);
  }
  if (input.filterSubjectTypeId !== undefined) {
    clauses.push("subject_type_id = ?");
    binds.push(input.filterSubjectTypeId);
  }
  const where = `WHERE ${clauses.join(" AND ")}`;
  const order = orderByClause(input.sort, (f) => SUBJECT_COLUMNS[f], "id");
  const rows = (
    await db
      .prepare(`SELECT * FROM subject ${where} ${order} LIMIT ? OFFSET ?`)
      .bind(...binds, input.limit, input.offset)
      .all<SubjectRow>()
  ).results;

  let total: number | undefined;
  if (input.includeTotal) {
    const r = await db
      .prepare(`SELECT COUNT(*) AS n FROM subject ${where}`)
      .bind(...binds)
      .first<{ n: number }>();
    total = r?.n ?? 0;
  }
  return { rows, total };
}

const SUBJECT_JOIN_COLUMNS: Record<string, string> = {
  name: "subject.name",
  key: "subject.key",
  created_at: "subject.created_at",
  updated_at: "subject.updated_at",
};

export interface ListBenchmarkSubjectsInput {
  benchmarkId: string;
  filterKey?: string;
  sort: Sort;
  limit: number;
  offset: number;
  includeTotal: boolean;
}

/** The subjects linked to a benchmark (via benchmark_subject) — the public viewer's subject list. */
export async function listSubjectsForBenchmark(
  db: D1Database,
  input: ListBenchmarkSubjectsInput,
): Promise<{ rows: SubjectRow[]; total?: number }> {
  const clauses = ["benchmark_subject.benchmark_id = ?"];
  const binds: unknown[] = [input.benchmarkId];
  if (input.filterKey !== undefined) {
    clauses.push("subject.key = ?");
    binds.push(input.filterKey);
  }
  const where = `WHERE ${clauses.join(" AND ")}`;
  const join = "FROM subject JOIN benchmark_subject ON benchmark_subject.subject_id = subject.id";
  const order = orderByClause(input.sort, (f) => SUBJECT_JOIN_COLUMNS[f], "subject.id");
  const rows = (
    await db
      .prepare(`SELECT subject.* ${join} ${where} ${order} LIMIT ? OFFSET ?`)
      .bind(...binds, input.limit, input.offset)
      .all<SubjectRow>()
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

export interface UpdateSubjectInput {
  name: string;
  details: unknown | null;
}

export async function updateSubject(
  db: D1Database,
  id: string,
  input: UpdateSubjectInput,
): Promise<SubjectRow | null> {
  const existing = await getSubjectById(db, id);
  if (!existing) return null;
  const updated: SubjectRow = {
    ...existing,
    name: input.name,
    details: jsonOrNull(input.details),
    updated_at: Date.now(),
  };
  await db
    .prepare("UPDATE subject SET name=?, details=?, updated_at=? WHERE id=?")
    .bind(updated.name, updated.details, updated.updated_at, id)
    .run();
  return updated;
}

/**
 * Hard-delete an account-owned subject: its measurements (across every run that names it), its
 * benchmark links, then the subject row. The route guarantees the subject is not linked to any
 * non-PRIVATE benchmark, so no published data is destroyed.
 */
export async function deleteSubjectCascade(db: D1Database, id: string): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM measurement WHERE subject_id = ?").bind(id),
    db.prepare("DELETE FROM benchmark_subject WHERE subject_id = ?").bind(id),
    db.prepare("DELETE FROM subject WHERE id = ?").bind(id),
  ]);
}
