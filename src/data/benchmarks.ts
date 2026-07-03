import { ConflictError } from "../errors";
import { orderByClause, type Sort } from "../query/sort";
import type { BenchmarkRow, PublishedKind, SampleSchema, Status } from "../types";
import { isUniqueViolation } from "./d1";

export interface CreateBenchmarkInput {
  account_id: string;
  key: string;
  name: string;
  description: string | null;
  about: string | null;
  methodology: string | null;
  sample_schema: SampleSchema;
  /** The creating user, or null if an API key created it. */
  created_by_user_id: string | null;
}

export async function createBenchmark(
  db: D1Database,
  input: CreateBenchmarkInput,
): Promise<BenchmarkRow> {
  const now = Date.now();
  const row: BenchmarkRow = {
    id: crypto.randomUUID(),
    account_id: input.account_id,
    key: input.key,
    name: input.name,
    description: input.description,
    about: input.about,
    methodology: input.methodology,
    status: "PRIVATE",
    published_at: null,
    withdrawn_at: null,
    withdrawal_reason: null,
    sample_schema: JSON.stringify(input.sample_schema),
    created_by_user_id: input.created_by_user_id,
    draft: 1,
    published_by_user_id: null,
    published_as_kind: null,
    published_identity_id: null,
    attribution_snapshot: null,
    created_at: now,
    updated_at: now,
  };
  try {
    await db
      .prepare(
        "INSERT INTO benchmark (id, account_id, key, name, description, about, methodology, status, published_at, withdrawn_at, withdrawal_reason, sample_schema, created_by_user_id, draft, published_by_user_id, published_as_kind, published_identity_id, attribution_snapshot, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,NULL,NULL,NULL,?,?,?,NULL,NULL,NULL,NULL,?,?)",
      )
      .bind(
        row.id,
        row.account_id,
        row.key,
        row.name,
        row.description,
        row.about,
        row.methodology,
        row.status,
        row.sample_schema,
        row.created_by_user_id,
        row.draft,
        row.created_at,
        row.updated_at,
      )
      .run();
  } catch (e) {
    if (isUniqueViolation(e)) {
      throw new ConflictError(
        `A benchmark with key ${JSON.stringify(input.key)} already exists for this account.`,
      );
    }
    throw e;
  }
  return row;
}

export async function getBenchmarkById(
  db: D1Database,
  id: string,
): Promise<BenchmarkRow | null> {
  return (
    (await db
      .prepare("SELECT * FROM benchmark WHERE id = ?")
      .bind(id)
      .first<BenchmarkRow>()) ?? null
  );
}

export interface ListBenchmarksInput {
  /** Restrict to these statuses (e.g. public browse = [PUBLISHED, WITHDRAWN]). */
  statuses?: Status[];
  accountId?: string;
  filterKey?: string;
  sort: Sort;
  limit: number;
  offset: number;
  includeTotal: boolean;
}

const BENCHMARK_COLUMNS: Record<string, string> = {
  name: "name",
  created_at: "created_at",
  updated_at: "updated_at",
};

function benchmarkWhere(input: ListBenchmarksInput): { sql: string; binds: unknown[] } {
  const clauses: string[] = [];
  const binds: unknown[] = [];
  if (input.statuses && input.statuses.length > 0) {
    clauses.push(`status IN (${input.statuses.map(() => "?").join(",")})`);
    binds.push(...input.statuses);
  }
  if (input.accountId !== undefined) {
    clauses.push("account_id = ?");
    binds.push(input.accountId);
  }
  if (input.filterKey !== undefined) {
    clauses.push("key = ?");
    binds.push(input.filterKey);
  }
  return { sql: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "", binds };
}

export async function listBenchmarks(
  db: D1Database,
  input: ListBenchmarksInput,
): Promise<{ rows: BenchmarkRow[]; total?: number }> {
  const where = benchmarkWhere(input);
  const order = orderByClause(input.sort, (f) => BENCHMARK_COLUMNS[f], "id");
  const rows = (
    await db
      .prepare(`SELECT * FROM benchmark ${where.sql} ${order} LIMIT ? OFFSET ?`)
      .bind(...where.binds, input.limit, input.offset)
      .all<BenchmarkRow>()
  ).results;

  let total: number | undefined;
  if (input.includeTotal) {
    const r = await db
      .prepare(`SELECT COUNT(*) AS n FROM benchmark ${where.sql}`)
      .bind(...where.binds)
      .first<{ n: number }>();
    total = r?.n ?? 0;
  }
  return { rows, total };
}

/** Full-replace of the editable content fields. The route enforces the freeze-on-publish rules. */
export interface UpdateBenchmarkInput {
  name: string;
  description: string | null;
  about: string | null;
  methodology: string | null;
  sample_schema: SampleSchema;
}

export async function updateBenchmark(
  db: D1Database,
  id: string,
  input: UpdateBenchmarkInput,
): Promise<BenchmarkRow | null> {
  const existing = await getBenchmarkById(db, id);
  if (!existing) return null;
  const updated: BenchmarkRow = {
    ...existing,
    name: input.name,
    description: input.description,
    about: input.about,
    methodology: input.methodology,
    sample_schema: JSON.stringify(input.sample_schema),
    updated_at: Date.now(),
  };
  await db
    .prepare(
      "UPDATE benchmark SET name=?, description=?, about=?, methodology=?, sample_schema=?, updated_at=? WHERE id=?",
    )
    .bind(
      updated.name,
      updated.description,
      updated.about,
      updated.methodology,
      updated.sample_schema,
      updated.updated_at,
      id,
    )
    .run();
  return updated;
}

/** Flip the draft/ready flag (mark_ready → 0, return_to_draft → 1). */
export async function setBenchmarkDraft(
  db: D1Database,
  id: string,
  draft: number,
): Promise<BenchmarkRow | null> {
  await db
    .prepare("UPDATE benchmark SET draft=?, updated_at=? WHERE id=?")
    .bind(draft, Date.now(), id)
    .run();
  return getBenchmarkById(db, id);
}

/** The attribution frozen at publish (the route captures the snapshot; this persists it). */
export interface PublishAttribution {
  published_by_user_id: string | null;
  published_as_kind: PublishedKind;
  published_identity_id: string | null;
  /** JSON string of an OrgAttributionSnapshot / PersonalAttributionSnapshot. */
  attribution_snapshot: string;
}

export async function publishBenchmark(
  db: D1Database,
  id: string,
  now: number,
  attribution: PublishAttribution,
): Promise<BenchmarkRow | null> {
  await db
    .prepare(
      "UPDATE benchmark SET status='PUBLISHED', published_at=?, published_by_user_id=?, published_as_kind=?, published_identity_id=?, attribution_snapshot=?, updated_at=? WHERE id=?",
    )
    .bind(
      now,
      attribution.published_by_user_id,
      attribution.published_as_kind,
      attribution.published_identity_id,
      attribution.attribution_snapshot,
      now,
      id,
    )
    .run();
  return getBenchmarkById(db, id);
}

export async function withdrawBenchmark(
  db: D1Database,
  id: string,
  now: number,
  reason: string | null,
): Promise<BenchmarkRow | null> {
  await db
    .prepare(
      "UPDATE benchmark SET status='WITHDRAWN', withdrawn_at=?, withdrawal_reason=?, updated_at=? WHERE id=?",
    )
    .bind(now, reason, now, id)
    .run();
  return getBenchmarkById(db, id);
}

/** Hard-delete a PRIVATE benchmark and its whole subtree (the route guarantees PRIVATE). */
export async function deleteBenchmarkCascade(db: D1Database, id: string): Promise<void> {
  await db.batch([
    db
      .prepare(
        "DELETE FROM observation WHERE run_id IN (SELECT run.id FROM run JOIN target ON target.id = run.target_id WHERE target.benchmark_id = ?)",
      )
      .bind(id),
    db
      .prepare(
        "DELETE FROM run WHERE target_id IN (SELECT id FROM target WHERE benchmark_id = ?)",
      )
      .bind(id),
    db.prepare("DELETE FROM target WHERE benchmark_id = ?").bind(id),
    db.prepare("DELETE FROM benchmark WHERE id = ?").bind(id),
  ]);
}
