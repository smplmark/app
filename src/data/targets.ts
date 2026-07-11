import { ConflictError } from "../errors";
import { orderByClause, type Sort } from "../query/sort";
import type { TargetRow } from "../types";
import { isUniqueViolation, jsonOrNull } from "./d1";

export interface CreateTargetInput {
  account_id: string;
  key: string;
  name: string;
  details: unknown | null;
}

export async function createTarget(
  db: D1Database,
  input: CreateTargetInput,
): Promise<TargetRow> {
  const now = Date.now();
  const row: TargetRow = {
    id: crypto.randomUUID(),
    account_id: input.account_id,
    key: input.key,
    name: input.name,
    details: jsonOrNull(input.details),
    created_at: now,
    updated_at: now,
  };
  try {
    await db
      .prepare(
        "INSERT INTO target (id, account_id, key, name, details, created_at, updated_at) VALUES (?,?,?,?,?,?,?)",
      )
      .bind(row.id, row.account_id, row.key, row.name, row.details, row.created_at, row.updated_at)
      .run();
  } catch (e) {
    if (isUniqueViolation(e)) {
      throw new ConflictError(
        `A target with key ${JSON.stringify(input.key)} already exists in this account.`,
      );
    }
    throw e;
  }
  return row;
}

/** Serves the targets-per-account ceiling check on create. */
export async function countTargetsForAccount(
  db: D1Database,
  accountId: string,
): Promise<number> {
  const r = await db
    .prepare("SELECT COUNT(*) AS n FROM target WHERE account_id = ?")
    .bind(accountId)
    .first<{ n: number }>();
  return r?.n ?? 0;
}

export async function getTargetById(
  db: D1Database,
  id: string,
): Promise<TargetRow | null> {
  return (
    (await db.prepare("SELECT * FROM target WHERE id = ?").bind(id).first<TargetRow>()) ??
    null
  );
}

const TARGET_COLUMNS: Record<string, string> = {
  name: "name",
  key: "key",
  created_at: "created_at",
  updated_at: "updated_at",
};

export interface ListAccountTargetsInput {
  accountId: string;
  filterKey?: string;
  sort: Sort;
  limit: number;
  offset: number;
  includeTotal: boolean;
}

/** All targets an account owns (the top-level Targets list + the pick-or-create picker). */
export async function listAccountTargets(
  db: D1Database,
  input: ListAccountTargetsInput,
): Promise<{ rows: TargetRow[]; total?: number }> {
  const clauses = ["account_id = ?"];
  const binds: unknown[] = [input.accountId];
  if (input.filterKey !== undefined) {
    clauses.push("key = ?");
    binds.push(input.filterKey);
  }
  const where = `WHERE ${clauses.join(" AND ")}`;
  const order = orderByClause(input.sort, (f) => TARGET_COLUMNS[f], "id");
  const rows = (
    await db
      .prepare(`SELECT * FROM target ${where} ${order} LIMIT ? OFFSET ?`)
      .bind(...binds, input.limit, input.offset)
      .all<TargetRow>()
  ).results;

  let total: number | undefined;
  if (input.includeTotal) {
    const r = await db
      .prepare(`SELECT COUNT(*) AS n FROM target ${where}`)
      .bind(...binds)
      .first<{ n: number }>();
    total = r?.n ?? 0;
  }
  return { rows, total };
}

const TARGET_JOIN_COLUMNS: Record<string, string> = {
  name: "target.name",
  key: "target.key",
  created_at: "target.created_at",
  updated_at: "target.updated_at",
};

export interface ListBenchmarkTargetsInput {
  benchmarkId: string;
  filterKey?: string;
  sort: Sort;
  limit: number;
  offset: number;
  includeTotal: boolean;
}

/** The targets linked to a benchmark (via benchmark_target) — the public viewer's target list. */
export async function listTargetsForBenchmark(
  db: D1Database,
  input: ListBenchmarkTargetsInput,
): Promise<{ rows: TargetRow[]; total?: number }> {
  const clauses = ["benchmark_target.benchmark_id = ?"];
  const binds: unknown[] = [input.benchmarkId];
  if (input.filterKey !== undefined) {
    clauses.push("target.key = ?");
    binds.push(input.filterKey);
  }
  const where = `WHERE ${clauses.join(" AND ")}`;
  const join = "FROM target JOIN benchmark_target ON benchmark_target.target_id = target.id";
  const order = orderByClause(input.sort, (f) => TARGET_JOIN_COLUMNS[f], "target.id");
  const rows = (
    await db
      .prepare(`SELECT target.* ${join} ${where} ${order} LIMIT ? OFFSET ?`)
      .bind(...binds, input.limit, input.offset)
      .all<TargetRow>()
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

export interface UpdateTargetInput {
  name: string;
  details: unknown | null;
}

export async function updateTarget(
  db: D1Database,
  id: string,
  input: UpdateTargetInput,
): Promise<TargetRow | null> {
  const existing = await getTargetById(db, id);
  if (!existing) return null;
  const updated: TargetRow = {
    ...existing,
    name: input.name,
    details: jsonOrNull(input.details),
    updated_at: Date.now(),
  };
  await db
    .prepare("UPDATE target SET name=?, details=?, updated_at=? WHERE id=?")
    .bind(updated.name, updated.details, updated.updated_at, id)
    .run();
  return updated;
}

/**
 * Hard-delete an account-owned target: its measurements (across every run that names it), its
 * benchmark links, then the target row. The route guarantees the target is not linked to any
 * non-PRIVATE benchmark, so no published data is destroyed.
 */
export async function deleteTargetCascade(db: D1Database, id: string): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM measurement WHERE target_id = ?").bind(id),
    db.prepare("DELETE FROM benchmark_target WHERE target_id = ?").bind(id),
    db.prepare("DELETE FROM target WHERE id = ?").bind(id),
  ]);
}
