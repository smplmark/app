import { ConflictError } from "../errors";
import { likePattern } from "../query/search";
import { orderByClause, type Sort } from "../query/sort";
import type {
  BenchmarkRow,
  Category,
  PublishedKind,
  ObservationSchema,
  Status,
} from "../types";
import { isUniqueViolation } from "./d1";

export interface CreateBenchmarkInput {
  account_id: string;
  key: string;
  name: string;
  description: string | null;
  about: string | null;
  methodology: string | null;
  observation_schema: ObservationSchema;
  category: Category;
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
    observation_schema: JSON.stringify(input.observation_schema),
    created_by_user_id: input.created_by_user_id,
    draft: 1,
    published_by_user_id: null,
    published_as_kind: null,
    published_identity_id: null,
    attribution_snapshot: null,
    category: input.category,
    // The DB defaults apply on INSERT; the route refreshes search_text once tags are attached.
    search_text: "",
    views_total: 0,
    closed_at: null,
    created_at: now,
    updated_at: now,
  };
  try {
    await db
      .prepare(
        "INSERT INTO benchmark (id, account_id, key, name, description, about, methodology, status, published_at, withdrawn_at, withdrawal_reason, observation_schema, created_by_user_id, draft, published_by_user_id, published_as_kind, published_identity_id, attribution_snapshot, category, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,NULL,NULL,NULL,?,?,?,NULL,NULL,NULL,NULL,?,?,?)",
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
        row.observation_schema,
        row.created_by_user_id,
        row.draft,
        row.category,
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

// The one search_text expression, shared verbatim with migration 0005's backfill and the
// ingestion importer — keep the three in sync.
const SEARCH_TEXT_SQL = `lower(
  coalesce(key, '') || ' ' || coalesce(name, '') || ' ' || coalesce(description, '') || ' ' ||
  coalesce(about, '') || ' ' || coalesce(methodology, '') || ' ' || coalesce(category, '') || ' ' ||
  coalesce((SELECT group_concat(t.key, ' ') FROM benchmark_tag bt JOIN tag t ON t.id = bt.tag_id
            WHERE bt.benchmark_id = benchmark.id), '') || ' ' ||
  coalesce(json_extract(attribution_snapshot, '$.source_name'), '')
)`;

/**
 * Rebuild a benchmark's search_text from its current row + tags. Called after any create/update/
 * tag change — the column is a projection, never authored directly.
 */
export async function refreshBenchmarkSearchText(
  db: D1Database,
  id: string,
): Promise<void> {
  await db
    .prepare(`UPDATE benchmark SET search_text = ${SEARCH_TEXT_SQL} WHERE id = ?`)
    .bind(id)
    .run();
}

/** Serves the benchmarks-per-account ceiling check on create. */
export async function countBenchmarksForAccount(
  db: D1Database,
  accountId: string,
): Promise<number> {
  const r = await db
    .prepare("SELECT COUNT(*) AS n FROM benchmark WHERE account_id = ?")
    .bind(accountId)
    .first<{ n: number }>();
  return r?.n ?? 0;
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
  /** Exact-match on a tag key (normalized slug). */
  tag?: string;
  category?: Category;
  /** filter[search]: every term must appear in search_text (parsed by query/search.ts). */
  searchTerms?: string[];
  sort: Sort;
  limit: number;
  offset: number;
  includeTotal: boolean;
}

const BENCHMARK_COLUMNS: Record<string, string> = {
  name: "name",
  created_at: "created_at",
  updated_at: "updated_at",
  views: "views_total",
};

// Rolling popularity windows (UTC day buckets, inclusive of today).
const VIEW_WINDOW_DAYS: Record<string, number> = {
  views_today: 1,
  views_week: 7,
  views_month: 30,
  views_year: 365,
};

/** The oldest UTC day (YYYY-MM-DD) inside a rolling window ending today. */
function windowCutoffDay(days: number): string {
  return new Date(Date.now() - (days - 1) * 86_400_000).toISOString().slice(0, 10);
}

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
  if (input.category !== undefined) {
    clauses.push("category = ?");
    binds.push(input.category);
  }
  if (input.searchTerms !== undefined) {
    for (const term of input.searchTerms) {
      clauses.push("search_text LIKE ? ESCAPE '\\'");
      binds.push(likePattern(term));
    }
  }
  if (input.tag !== undefined) {
    // EXISTS keeps the outer query join-free (no DISTINCT needed; COUNT stays correct).
    clauses.push(
      "EXISTS (SELECT 1 FROM benchmark_tag JOIN tag ON tag.id = benchmark_tag.tag_id WHERE benchmark_tag.benchmark_id = benchmark.id AND tag.key = ?)",
    );
    binds.push(input.tag);
  }
  return { sql: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "", binds };
}

export async function listBenchmarks(
  db: D1Database,
  input: ListBenchmarksInput,
): Promise<{ rows: BenchmarkRow[]; total?: number }> {
  const where = benchmarkWhere(input);
  // Windowed popularity sorts join the per-day view buckets; everything else orders on a column.
  const windowDays = VIEW_WINDOW_DAYS[input.sort.field];
  let join = "";
  const joinBinds: unknown[] = [];
  let order: string;
  if (windowDays !== undefined) {
    join =
      " LEFT JOIN (SELECT benchmark_id, SUM(views) AS window_views FROM benchmark_view_day WHERE day >= ? GROUP BY benchmark_id) wv ON wv.benchmark_id = benchmark.id";
    joinBinds.push(windowCutoffDay(windowDays));
    order = `ORDER BY coalesce(wv.window_views, 0) ${input.sort.desc ? "DESC" : "ASC"}, benchmark.id`;
  } else {
    order = orderByClause(input.sort, (f) => BENCHMARK_COLUMNS[f], "id");
  }
  const rows = (
    await db
      .prepare(`SELECT benchmark.* FROM benchmark${join} ${where.sql} ${order} LIMIT ? OFFSET ?`)
      .bind(...joinBinds, ...where.binds, input.limit, input.offset)
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
  observation_schema: ObservationSchema;
  /** Browse metadata — editable at any status, like `name`. */
  category: Category;
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
    observation_schema: JSON.stringify(input.observation_schema),
    category: input.category,
    updated_at: Date.now(),
  };
  await db
    .prepare(
      "UPDATE benchmark SET name=?, description=?, about=?, methodology=?, observation_schema=?, category=?, updated_at=? WHERE id=?",
    )
    .bind(
      updated.name,
      updated.description,
      updated.about,
      updated.methodology,
      updated.observation_schema,
      updated.category,
      updated.updated_at,
      id,
    )
    .run();
  return updated;
}

/** Set/clear the reversible "complete" signal (close → now, reopen → null). */
export async function setBenchmarkClosed(
  db: D1Database,
  id: string,
  closedAt: number | null,
): Promise<BenchmarkRow | null> {
  await db
    .prepare("UPDATE benchmark SET closed_at=?, updated_at=? WHERE id=?")
    .bind(closedAt, Date.now(), id)
    .run();
  return getBenchmarkById(db, id);
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
    db.prepare("DELETE FROM benchmark_tag WHERE benchmark_id = ?").bind(id),
    db.prepare("DELETE FROM benchmark WHERE id = ?").bind(id),
  ]);
}
