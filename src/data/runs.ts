import { ConflictError } from "../errors";
import { orderByClause, type Sort } from "../query/sort";
import type { RunRow } from "../types";
import { isUniqueViolation, jsonOrNull } from "./d1";

export interface CreateRunInput {
  target_id: string;
  key: string;
  name: string | null;
  details: unknown | null;
  started_at: number | null;
}

export async function createRun(
  db: D1Database,
  input: CreateRunInput,
): Promise<RunRow> {
  const now = Date.now();
  const row: RunRow = {
    id: crypto.randomUUID(),
    target_id: input.target_id,
    key: input.key,
    name: input.name,
    details: jsonOrNull(input.details),
    started_at: input.started_at,
    ended_at: null,
    invalidated_at: null,
    invalidation_reason: null,
    invalidated_by_user_id: null,
    created_at: now,
    updated_at: now,
  };
  try {
    await db
      .prepare(
        "INSERT INTO run (id, target_id, key, name, details, started_at, ended_at, invalidated_at, invalidation_reason, invalidated_by_user_id, created_at, updated_at) VALUES (?,?,?,?,?,?,NULL,NULL,NULL,NULL,?,?)",
      )
      .bind(
        row.id,
        row.target_id,
        row.key,
        row.name,
        row.details,
        row.started_at,
        row.created_at,
        row.updated_at,
      )
      .run();
  } catch (e) {
    if (isUniqueViolation(e)) {
      throw new ConflictError(
        `A run with key ${JSON.stringify(input.key)} already exists for this target.`,
      );
    }
    throw e;
  }
  return row;
}

export async function getRunById(
  db: D1Database,
  id: string,
): Promise<RunRow | null> {
  return (
    (await db.prepare("SELECT * FROM run WHERE id = ?").bind(id).first<RunRow>()) ?? null
  );
}

export interface ListRunsInput {
  targetId: string;
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
  const clauses = ["target_id = ?"];
  const binds: unknown[] = [input.targetId];
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
}

export async function updateRun(
  db: D1Database,
  id: string,
  input: UpdateRunInput,
): Promise<RunRow | null> {
  const existing = await getRunById(db, id);
  if (!existing) return null;
  const updated: RunRow = {
    ...existing,
    name: input.name,
    details: jsonOrNull(input.details),
    started_at: input.started_at,
    updated_at: Date.now(),
  };
  await db
    .prepare("UPDATE run SET name=?, details=?, started_at=?, updated_at=? WHERE id=?")
    .bind(updated.name, updated.details, updated.started_at, updated.updated_at, id)
    .run();
  return updated;
}

/** Stamp ended_at (idempotent-ish; only when currently live). */
export async function endRun(
  db: D1Database,
  id: string,
  now: number,
): Promise<RunRow | null> {
  await db
    .prepare("UPDATE run SET ended_at=?, updated_at=? WHERE id=? AND ended_at IS NULL")
    .bind(now, now, id)
    .run();
  return getRunById(db, id);
}

export async function invalidateRun(
  db: D1Database,
  id: string,
  now: number,
  reason: string | null,
  userId: string | null,
): Promise<RunRow | null> {
  await db
    .prepare(
      "UPDATE run SET invalidated_at=?, invalidation_reason=?, invalidated_by_user_id=?, updated_at=? WHERE id=?",
    )
    .bind(now, reason, userId, now, id)
    .run();
  return getRunById(db, id);
}

export async function deleteRunCascade(db: D1Database, id: string): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM observation WHERE run_id = ?").bind(id),
    db.prepare("DELETE FROM run WHERE id = ?").bind(id),
  ]);
}
