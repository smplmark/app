import { ConflictError } from "../errors";
import { orderByClause, type Sort } from "../query/sort";
import type { MetricRow, MetricType } from "../types";
import { isUniqueViolation } from "./d1";

export interface CreateMetricInput {
  account_id: string;
  name: string;
  label: string;
  description: string | null;
  type: MetricType;
  unit: string | null;
  format: string | null;
  /** JSON string of a MetricFormula (FORMULA metrics) or null. */
  formula: string | null;
}

export async function createMetric(db: D1Database, input: CreateMetricInput): Promise<MetricRow> {
  const now = Date.now();
  const row: MetricRow = {
    id: crypto.randomUUID(),
    account_id: input.account_id,
    name: input.name,
    label: input.label,
    description: input.description,
    type: input.type,
    unit: input.unit,
    format: input.format,
    formula: input.formula,
    created_at: now,
    updated_at: now,
  };
  try {
    await db
      .prepare(
        "INSERT INTO metric (id, account_id, name, label, description, type, unit, format, formula, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
      )
      .bind(row.id, row.account_id, row.name, row.label, row.description, row.type, row.unit, row.format, row.formula, row.created_at, row.updated_at)
      .run();
  } catch (e) {
    if (isUniqueViolation(e)) {
      throw new ConflictError(`A metric named ${JSON.stringify(input.name)} already exists in this account.`);
    }
    throw e;
  }
  return row;
}

export async function getMetricById(db: D1Database, id: string): Promise<MetricRow | null> {
  return (await db.prepare("SELECT * FROM metric WHERE id = ?").bind(id).first<MetricRow>()) ?? null;
}

/** Look up a metric by (account, name) — used to keep the identifier unique on create. */
export async function getMetricByName(db: D1Database, accountId: string, name: string): Promise<MetricRow | null> {
  return (
    (await db.prepare("SELECT * FROM metric WHERE account_id = ? AND name = ?").bind(accountId, name).first<MetricRow>()) ?? null
  );
}

const METRIC_COLUMNS: Record<string, string> = {
  name: "name",
  label: "label",
  type: "type",
  created_at: "created_at",
  updated_at: "updated_at",
};

export interface ListMetricsInput {
  account_id: string;
  sort: Sort;
  limit: number;
  offset: number;
  includeTotal: boolean;
}

export async function listMetrics(db: D1Database, input: ListMetricsInput): Promise<{ rows: MetricRow[]; total?: number }> {
  const order = orderByClause(input.sort, (f) => METRIC_COLUMNS[f], "id");
  const rows = (
    await db
      .prepare(`SELECT * FROM metric WHERE account_id = ? ${order} LIMIT ? OFFSET ?`)
      .bind(input.account_id, input.limit, input.offset)
      .all<MetricRow>()
  ).results;
  let total: number | undefined;
  if (input.includeTotal) {
    const r = await db.prepare("SELECT COUNT(*) AS n FROM metric WHERE account_id = ?").bind(input.account_id).first<{ n: number }>();
    total = r?.n ?? 0;
  }
  return { rows, total };
}

export async function countMetricsForAccount(db: D1Database, accountId: string): Promise<number> {
  const r = await db.prepare("SELECT COUNT(*) AS n FROM metric WHERE account_id = ?").bind(accountId).first<{ n: number }>();
  return r?.n ?? 0;
}

export interface UpdateMetricInput {
  label: string;
  description: string | null;
  type: MetricType;
  unit: string | null;
  format: string | null;
  formula: string | null;
}

/** Update a metric's label / description / type / unit / format / formula. Its `name` is immutable. */
export async function updateMetric(db: D1Database, id: string, input: UpdateMetricInput): Promise<MetricRow | null> {
  const existing = await getMetricById(db, id);
  if (!existing) return null;
  const updated: MetricRow = {
    ...existing,
    label: input.label,
    description: input.description,
    type: input.type,
    unit: input.unit,
    format: input.format,
    formula: input.formula,
    updated_at: Date.now(),
  };
  await db
    .prepare("UPDATE metric SET label = ?, description = ?, type = ?, unit = ?, format = ?, formula = ?, updated_at = ? WHERE id = ?")
    .bind(updated.label, updated.description, updated.type, updated.unit, updated.format, updated.formula, updated.updated_at, id)
    .run();
  return updated;
}

export async function deleteMetric(db: D1Database, id: string): Promise<void> {
  await db.prepare("DELETE FROM metric WHERE id = ?").bind(id).run();
}
