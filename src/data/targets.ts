import { ConflictError } from "../errors";
import { orderByClause, type Sort } from "../query/sort";
import type { TargetRow } from "../types";
import { isUniqueViolation, jsonOrNull } from "./d1";

export interface CreateTargetInput {
  benchmark_id: string;
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
    benchmark_id: input.benchmark_id,
    key: input.key,
    name: input.name,
    details: jsonOrNull(input.details),
    created_at: now,
    updated_at: now,
  };
  try {
    await db
      .prepare(
        "INSERT INTO target (id, benchmark_id, key, name, details, created_at, updated_at) VALUES (?,?,?,?,?,?,?)",
      )
      .bind(row.id, row.benchmark_id, row.key, row.name, row.details, row.created_at, row.updated_at)
      .run();
  } catch (e) {
    if (isUniqueViolation(e)) {
      throw new ConflictError(
        `A target with key ${JSON.stringify(input.key)} already exists for this benchmark.`,
      );
    }
    throw e;
  }
  return row;
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

export interface ListTargetsInput {
  benchmarkId: string;
  filterKey?: string;
  sort: Sort;
  limit: number;
  offset: number;
  includeTotal: boolean;
}

const TARGET_COLUMNS: Record<string, string> = {
  name: "name",
  key: "key",
  created_at: "created_at",
  updated_at: "updated_at",
};

export async function listTargets(
  db: D1Database,
  input: ListTargetsInput,
): Promise<{ rows: TargetRow[]; total?: number }> {
  const clauses = ["benchmark_id = ?"];
  const binds: unknown[] = [input.benchmarkId];
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

/** Hard-delete a target and its subtree (the route guarantees the benchmark is PRIVATE). */
export async function deleteTargetCascade(db: D1Database, id: string): Promise<void> {
  await db.batch([
    db
      .prepare(
        "DELETE FROM observation WHERE run_id IN (SELECT id FROM run WHERE target_id = ?)",
      )
      .bind(id),
    db.prepare("DELETE FROM run WHERE target_id = ?").bind(id),
    db.prepare("DELETE FROM target WHERE id = ?").bind(id),
  ]);
}
