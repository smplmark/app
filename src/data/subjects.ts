import { ConflictError } from "../errors";
import { orderByClause, type Sort } from "../query/sort";
import type { SubjectRow } from "../types";
import { touchBenchmarksForSubjectStmt } from "./benchmarks";
import { isUniqueViolation, jsonOrNull } from "./d1";

/**
 * A subject row carrying its subject_type's public key (the wire reference emitted by serializeSubject),
 * resolved via a LEFT JOIN on subject_type. `subject_type_key` is null when the subject is untyped
 * (subject.subject_type_id is nullable, see 0018) or the referenced type row is missing. The internal
 * subject_type_id UUID stays on the row for authz/FK use; only serialization reads subject_type_key.
 */
export type SubjectRowWithType = SubjectRow & { subject_type_key: string | null };

// Every subject SELECT that feeds serializeSubject joins the subject type so the row carries its key.
const SUBJECT_TYPE_JOIN =
  "LEFT JOIN subject_type st ON st.id = subject.subject_type_id";
const SUBJECT_SELECT = `SELECT subject.*, st.key AS subject_type_key FROM subject ${SUBJECT_TYPE_JOIN}`;

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
): Promise<SubjectRowWithType | null> {
  return (
    (await db
      .prepare(`${SUBJECT_SELECT} WHERE subject.id = ?`)
      .bind(id)
      .first<SubjectRowWithType>()) ?? null
  );
}

/** Resolve an account's subject by its human key (unique per account, per the target_account_key index). */
export async function getSubjectByKey(
  db: D1Database,
  accountId: string,
  key: string,
): Promise<SubjectRowWithType | null> {
  return (
    (await db
      .prepare(`${SUBJECT_SELECT} WHERE subject.account_id = ? AND subject.key = ?`)
      .bind(accountId, key)
      .first<SubjectRowWithType>()) ?? null
  );
}

/**
 * Resolve a world-visible subject by its key, with no account context — the anonymous read path,
 * where a bare key can't be scoped to an account. Restricted to subjects linked to at least one
 * PUBLISHED/WITHDRAWN benchmark so a private subject is never disclosed. Keys are unique per account,
 * so a key shared by two accounts' public subjects resolves to one arbitrarily; both are public, so
 * no private data is exposed either way.
 */
export async function getPublicSubjectByKey(
  db: D1Database,
  key: string,
): Promise<SubjectRowWithType | null> {
  return (
    (await db
      .prepare(
        "SELECT subject.*, st.key AS subject_type_key FROM subject" +
          " JOIN benchmark_subject bs ON bs.subject_id = subject.id" +
          " JOIN benchmark b ON b.id = bs.benchmark_id" +
          ` ${SUBJECT_TYPE_JOIN}` +
          " WHERE subject.key = ? AND b.status IN ('PUBLISHED','WITHDRAWN') LIMIT 1",
      )
      .bind(key)
      .first<SubjectRowWithType>()) ?? null
  );
}

/**
 * Resolve a subject reference for a mutating caller who is expected to own it: the account's key
 * first, then (unless `keyOnly`) the raw UUID (the legacy path). The caller still authorizes the
 * resolved row (covers()/account check); this only turns a wire reference into a row. `keyOnly` is the
 * post-cutover mode used by the measurements POST, which accepts only the subject's key.
 */
export async function resolveOwnedSubject(
  db: D1Database,
  accountId: string,
  idOrKey: string,
  keyOnly = false,
): Promise<SubjectRowWithType | null> {
  const byKey = await getSubjectByKey(db, accountId, idOrKey);
  return byKey ?? (keyOnly ? null : await getSubjectById(db, idOrKey));
}

/**
 * Resolve a subject reference (its public key, or a raw UUID) for a reader. The caller's own subject
 * by key (when authed), then the raw id, then a world-visible subject by key (the anonymous/public
 * path). The caller still applies the visibility rule to the returned row; this only resolves.
 */
export async function resolveSubjectForRead(
  db: D1Database,
  accountId: string | null,
  idOrKey: string,
): Promise<SubjectRowWithType | null> {
  if (accountId !== null) {
    const owned = await getSubjectByKey(db, accountId, idOrKey);
    if (owned) return owned;
  }
  return (await getSubjectById(db, idOrKey)) ?? (await getPublicSubjectByKey(db, idOrKey));
}

// Columns are qualified with the `subject.` table alias because every subject query now joins
// subject_type (which shares column names like key/name/account_id/created_at), so a bare name is ambiguous.
const SUBJECT_JOIN_COLUMNS: Record<string, string> = {
  name: "subject.name",
  key: "subject.key",
  created_at: "subject.created_at",
  updated_at: "subject.updated_at",
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
): Promise<{ rows: SubjectRowWithType[]; total?: number }> {
  const clauses = ["subject.account_id = ?"];
  const binds: unknown[] = [input.accountId];
  if (input.filterKey !== undefined) {
    clauses.push("subject.key = ?");
    binds.push(input.filterKey);
  }
  if (input.filterSubjectTypeId !== undefined) {
    clauses.push("subject.subject_type_id = ?");
    binds.push(input.filterSubjectTypeId);
  }
  const where = `WHERE ${clauses.join(" AND ")}`;
  const order = orderByClause(input.sort, (f) => SUBJECT_JOIN_COLUMNS[f], "subject.id");
  const rows = (
    await db
      .prepare(`${SUBJECT_SELECT} ${where} ${order} LIMIT ? OFFSET ?`)
      .bind(...binds, input.limit, input.offset)
      .all<SubjectRowWithType>()
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
): Promise<{ rows: SubjectRowWithType[]; total?: number }> {
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
      .prepare(
        `SELECT subject.*, st.key AS subject_type_key ${join} ${SUBJECT_TYPE_JOIN} ${where} ${order} LIMIT ? OFFSET ?`,
      )
      .bind(...binds, input.limit, input.offset)
      .all<SubjectRowWithType>()
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
): Promise<SubjectRowWithType | null> {
  const existing = await getSubjectById(db, id);
  if (!existing) return null;
  const now = Date.now();
  const updated: SubjectRowWithType = {
    ...existing,
    name: input.name,
    details: jsonOrNull(input.details),
    updated_at: now,
  };
  // A subject is M:N with benchmarks, so its rename/details edit has no single owning benchmark — bump
  // the "last updated" of EVERY benchmark it's linked to, in the same batch. See the completion note:
  // this is a product judgment (does editing a subject "update" every benchmark referencing it?).
  await db.batch([
    db
      .prepare("UPDATE subject SET name=?, details=?, updated_at=? WHERE id=?")
      .bind(updated.name, updated.details, updated.updated_at, id),
    touchBenchmarksForSubjectStmt(db, id, now),
  ]);
  return updated;
}

/**
 * Hard-delete an account-owned subject: its measurements (across every run that names it), its
 * benchmark links, then the subject row. The route guarantees the subject is not linked to any
 * non-PRIVATE benchmark, so no published data is destroyed.
 */
export async function deleteSubjectCascade(db: D1Database, id: string): Promise<void> {
  await db.batch([
    // Bump every linked benchmark's updated_at FIRST — after the benchmark_subject rows are deleted the
    // subquery would find none. (The route only permits deleting a subject with no non-PRIVATE
    // benchmark, so in practice this touches draft benchmarks; kept for consistency with the rename.)
    touchBenchmarksForSubjectStmt(db, id, Date.now()),
    db.prepare("DELETE FROM measurement WHERE subject_id = ?").bind(id),
    db.prepare("DELETE FROM benchmark_subject WHERE subject_id = ?").bind(id),
    db.prepare("DELETE FROM subject WHERE id = ?").bind(id),
  ]);
}
