import { ConflictError } from "../errors";
import { orderByClause, type Sort } from "../query/sort";
import type { SubjectFieldDef, SubjectTypeRow } from "../types";
import { isUniqueViolation } from "./d1";

export interface CreateSubjectTypeInput {
  account_id: string;
  key: string;
  name: string;
  fields: SubjectFieldDef[];
}

export async function createSubjectType(
  db: D1Database,
  input: CreateSubjectTypeInput,
): Promise<SubjectTypeRow> {
  const now = Date.now();
  const row: SubjectTypeRow = {
    id: crypto.randomUUID(),
    account_id: input.account_id,
    key: input.key,
    name: input.name,
    fields: JSON.stringify(input.fields),
    created_at: now,
    updated_at: now,
  };
  try {
    await db
      .prepare(
        "INSERT INTO subject_type (id, account_id, key, name, fields, created_at, updated_at) VALUES (?,?,?,?,?,?,?)",
      )
      .bind(row.id, row.account_id, row.key, row.name, row.fields, row.created_at, row.updated_at)
      .run();
  } catch (e) {
    if (isUniqueViolation(e)) {
      throw new ConflictError(
        `A subject type with key ${JSON.stringify(input.key)} already exists in this account.`,
      );
    }
    throw e;
  }
  return row;
}

export async function getSubjectTypeById(db: D1Database, id: string): Promise<SubjectTypeRow | null> {
  return (
    (await db.prepare("SELECT * FROM subject_type WHERE id = ?").bind(id).first<SubjectTypeRow>()) ?? null
  );
}

/** Look up a subject type by (account, key) — used for server-side key derivation on create. */
export async function getSubjectTypeByKey(
  db: D1Database,
  accountId: string,
  key: string,
): Promise<SubjectTypeRow | null> {
  return (
    (await db
      .prepare("SELECT * FROM subject_type WHERE account_id = ? AND key = ?")
      .bind(accountId, key)
      .first<SubjectTypeRow>()) ?? null
  );
}

const SUBJECT_TYPE_COLUMNS: Record<string, string> = {
  name: "name",
  key: "key",
  created_at: "created_at",
  updated_at: "updated_at",
};

export interface ListSubjectTypesInput {
  account_id: string;
  sort: Sort;
  limit: number;
  offset: number;
  includeTotal: boolean;
}

export async function listSubjectTypes(
  db: D1Database,
  input: ListSubjectTypesInput,
): Promise<{ rows: SubjectTypeRow[]; total?: number }> {
  const order = orderByClause(input.sort, (f) => SUBJECT_TYPE_COLUMNS[f], "id");
  const rows = (
    await db
      .prepare(`SELECT * FROM subject_type WHERE account_id = ? ${order} LIMIT ? OFFSET ?`)
      .bind(input.account_id, input.limit, input.offset)
      .all<SubjectTypeRow>()
  ).results;
  let total: number | undefined;
  if (input.includeTotal) {
    const r = await db
      .prepare("SELECT COUNT(*) AS n FROM subject_type WHERE account_id = ?")
      .bind(input.account_id)
      .first<{ n: number }>();
    total = r?.n ?? 0;
  }
  return { rows, total };
}

export async function countSubjectTypesForAccount(db: D1Database, accountId: string): Promise<number> {
  const r = await db
    .prepare("SELECT COUNT(*) AS n FROM subject_type WHERE account_id = ?")
    .bind(accountId)
    .first<{ n: number }>();
  return r?.n ?? 0;
}

export interface UpdateSubjectTypeInput {
  name: string;
  fields: SubjectFieldDef[];
}

/** Update a subject type's name + fields. Its `key` is immutable (set from the initial name). */
export async function updateSubjectType(
  db: D1Database,
  id: string,
  input: UpdateSubjectTypeInput,
): Promise<SubjectTypeRow | null> {
  const existing = await getSubjectTypeById(db, id);
  if (!existing) return null;
  const updated: SubjectTypeRow = {
    ...existing,
    name: input.name,
    fields: JSON.stringify(input.fields),
    updated_at: Date.now(),
  };
  await db
    .prepare("UPDATE subject_type SET name = ?, fields = ?, updated_at = ? WHERE id = ?")
    .bind(updated.name, updated.fields, updated.updated_at, id)
    .run();
  return updated;
}

/** How many subjects currently use this type — a type in use can't be deleted. */
export async function countSubjectsOfType(db: D1Database, subjectTypeId: string): Promise<number> {
  const r = await db
    .prepare("SELECT COUNT(*) AS n FROM subject WHERE subject_type_id = ?")
    .bind(subjectTypeId)
    .first<{ n: number }>();
  return r?.n ?? 0;
}

/** How many benchmarks pin this subject type (benchmark.subject_type — see 0024). */
export async function countBenchmarksOfType(db: D1Database, subjectTypeId: string): Promise<number> {
  const r = await db
    .prepare("SELECT COUNT(*) AS n FROM benchmark WHERE subject_type = ?")
    .bind(subjectTypeId)
    .first<{ n: number }>();
  return r?.n ?? 0;
}

export async function deleteSubjectType(db: D1Database, id: string): Promise<void> {
  await db.prepare("DELETE FROM subject_type WHERE id = ?").bind(id).run();
}
