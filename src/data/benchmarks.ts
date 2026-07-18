import { ConflictError } from "../errors";
import { likePattern } from "../query/search";
import { orderByClause, type Sort } from "../query/sort";
import type {
  BenchmarkRow,
  Category,
  PublishedKind,
  MeasurementSchema,
  Status,
} from "../types";
import { isUniqueViolation } from "./d1";

/**
 * A benchmark row plus its owning account's key — the publisher slug that forms the first path
 * segment of its public URL (`/{publisher_slug}/{key}`) — and the referenced subject type's public
 * key (`subject_type_key`), the wire reference emitted by serializeBenchmark. Read paths resolve both
 * (a JOIN for a single row, batched over the list) so the API never leaks the internal account id or
 * subject_type UUID as the only handle. `subject_type_key` is null when the benchmark has no subject
 * type (nullable at the DB level; see 0024) or its referenced type row is missing; the raw
 * subject_type UUID stays on the row for authz/FK use, only serialization reads the key.
 */
export type BenchmarkRowWithPublisher = BenchmarkRow & {
  publisher_slug: string;
  subject_type_key: string | null;
};

/**
 * The URL slug for a benchmark's public path (`/{publisher_slug}/{key}`). An ORGANIZATION publish is
 * addressed by the verified domain it was published under — read from the frozen attribution snapshot
 * so the slug survives a later domain lapse or identity deletion — while every other benchmark is
 * addressed by its owning account's key.
 */
function publisherSlugFor(
  row: Pick<BenchmarkRow, "published_as_kind" | "attribution_snapshot">,
  accountKey: string,
): string {
  if (row.published_as_kind === "ORGANIZATION" && row.attribution_snapshot) {
    try {
      const domain = (JSON.parse(row.attribution_snapshot) as { domain?: unknown }).domain;
      if (typeof domain === "string" && domain) return domain;
    } catch {
      /* malformed snapshot — fall through to the account key */
    }
  }
  return accountKey;
}

/**
 * Stamp each row with its publisher slug, resolving the owning account's key in one batched lookup
 * over the distinct account ids (a public list spans many publishers). Mirrors the tags-batching
 * pattern and keeps the list query free of an account JOIN, which would make `key`/`name`/`created_at`
 * ambiguous in the shared WHERE/ORDER builders. Org publishes then override the slug with their
 * verified domain (see publisherSlugFor).
 */
async function attachPublisherSlug<
  T extends Pick<BenchmarkRow, "account_id" | "published_as_kind" | "attribution_snapshot">,
>(
  db: D1Database,
  rows: T[],
): Promise<(T & { publisher_slug: string })[]> {
  const ids = [...new Set(rows.map((r) => r.account_id))];
  const keyById = new Map<string, string>();
  if (ids.length > 0) {
    const res = await db
      .prepare(`SELECT id, key FROM account WHERE id IN (${ids.map(() => "?").join(",")})`)
      .bind(...ids)
      .all<{ id: string; key: string }>();
    for (const a of res.results) keyById.set(a.id, a.key);
  }
  return rows.map((r) => ({ ...r, publisher_slug: publisherSlugFor(r, keyById.get(r.account_id) ?? "") }));
}

export interface CreateBenchmarkInput {
  account_id: string;
  key: string;
  name: string;
  description: string | null;
  about: string | null;
  methodology: string | null;
  /** The subject_type every linked subject must conform to. */
  subject_type: string;
  measurement_schema: MeasurementSchema;
  category: Category;
  /** The creating user, or null if an API key created it. */
  created_by_user_id: string | null;
}

export async function createBenchmark(
  db: D1Database,
  input: CreateBenchmarkInput,
): Promise<BenchmarkRowWithPublisher> {
  const now = Date.now();
  const row: BenchmarkRow = {
    id: crypto.randomUUID(),
    account_id: input.account_id,
    key: input.key,
    name: input.name,
    description: input.description,
    about: input.about,
    methodology: input.methodology,
    subject_type: input.subject_type,
    status: "PRIVATE",
    published_at: null,
    withdrawn_at: null,
    withdrawal_reason: null,
    measurement_schema: JSON.stringify(input.measurement_schema),
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
        "INSERT INTO benchmark (id, account_id, key, name, description, about, methodology, subject_type, status, published_at, withdrawn_at, withdrawal_reason, measurement_schema, created_by_user_id, draft, published_by_user_id, published_as_kind, published_identity_id, attribution_snapshot, category, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,NULL,NULL,NULL,?,?,?,NULL,NULL,NULL,NULL,?,?,?)",
      )
      .bind(
        row.id,
        row.account_id,
        row.key,
        row.name,
        row.description,
        row.about,
        row.methodology,
        row.subject_type,
        row.status,
        row.measurement_schema,
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
  // Round out the in-memory row with the owning account's key and the subject type's key so it
  // serializes like the read paths. The account is guaranteed to exist (the INSERT's FK would have
  // failed otherwise); the subject type was validated by the route, so its key resolves too.
  const acct = await db
    .prepare("SELECT key FROM account WHERE id = ?")
    .bind(input.account_id)
    .first<{ key: string }>();
  const st = await db
    .prepare("SELECT key FROM subject_type WHERE id = ?")
    .bind(input.subject_type)
    .first<{ key: string }>();
  return { ...row, publisher_slug: acct?.key ?? "", subject_type_key: st?.key ?? null };
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

/** Is `key` already taken by a benchmark in this account? Backs auto-generated-key uniqueness. */
export async function benchmarkKeyExists(
  db: D1Database,
  accountId: string,
  key: string,
): Promise<boolean> {
  const r = await db
    .prepare("SELECT 1 AS x FROM benchmark WHERE account_id = ? AND key = ?")
    .bind(accountId, key)
    .first<{ x: number }>();
  return r !== null;
}

export async function getBenchmarkById(
  db: D1Database,
  id: string,
): Promise<BenchmarkRowWithPublisher | null> {
  const row = await db
    .prepare(
      "SELECT benchmark.*, account.key AS publisher_slug, st.key AS subject_type_key FROM benchmark JOIN account ON account.id = benchmark.account_id LEFT JOIN subject_type st ON st.id = benchmark.subject_type WHERE benchmark.id = ?",
    )
    .bind(id)
    .first<BenchmarkRowWithPublisher>();
  if (row === null) return null;
  // The JOIN resolves the owning account's key; org publishes override it with their verified domain.
  return { ...row, publisher_slug: publisherSlugFor(row, row.publisher_slug) };
}

export interface ListBenchmarksInput {
  /** Restrict to these statuses (e.g. public browse = [PUBLISHED, WITHDRAWN]). */
  statuses?: Status[];
  accountId?: string;
  /** filter[publisher]: the owning account's key (URL slug), e.g. "stanford-helm". */
  publisherSlug?: string;
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

// Qualified with the `benchmark.` table alias: the list query joins subject_type (which shares column
// names like key/name/account_id/created_at), so a bare name would be ambiguous.
const BENCHMARK_COLUMNS: Record<string, string> = {
  name: "benchmark.name",
  created_at: "benchmark.created_at",
  updated_at: "benchmark.updated_at",
  // NULL for never-published rows; SQLite sorts NULL smallest, so -published_at puts them last.
  published_at: "benchmark.published_at",
  views: "benchmark.views_total",
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
    // Qualified: the list query joins subject_type, which also has an account_id (the COUNT query has
    // no join, but benchmark.account_id is valid there too).
    clauses.push("benchmark.account_id = ?");
    binds.push(input.accountId);
  }
  if (input.publisherSlug !== undefined) {
    // Slug → owner via a subquery (no account JOIN, so the outer query's bare `key`/`created_at` stay
    // benchmark-scoped). Match the owning account's key (personal/default addressing) OR, for an
    // organization publish, its verified attribution domain — so `/{org-domain}/{key}` resolves too.
    // An unknown slug simply matches nothing.
    clauses.push(
      "(benchmark.account_id IN (SELECT id FROM account WHERE key = ?)" +
        " OR (published_as_kind = 'ORGANIZATION' AND json_extract(attribution_snapshot, '$.domain') = ?))",
    );
    binds.push(input.publisherSlug, input.publisherSlug);
  }
  if (input.filterKey !== undefined) {
    // Qualified: subject_type also has a `key` column once the list query joins it.
    clauses.push("benchmark.key = ?");
    binds.push(input.filterKey);
  }
  if (input.category !== undefined) {
    clauses.push("category = ?");
    binds.push(input.category);
  }
  if (input.searchTerms !== undefined) {
    for (const term of input.searchTerms) {
      // Each term matches the benchmark's own text OR any of its linked subjects' name/key, so
      // searching a model or system (e.g. "llama 3") surfaces the benchmark that contains it —
      // subjects aren't in search_text. EXISTS short-circuits through the benchmark_subject join and
      // keeps the outer query join-free so COUNT stays correct.
      clauses.push(
        "(search_text LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM benchmark_subject bt JOIN subject ON subject.id = bt.subject_id WHERE bt.benchmark_id = benchmark.id AND (lower(subject.name) LIKE ? ESCAPE '\\' OR lower(subject.key) LIKE ? ESCAPE '\\')))",
      );
      binds.push(likePattern(term), likePattern(term), likePattern(term));
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
): Promise<{ rows: BenchmarkRowWithPublisher[]; total?: number }> {
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
    order = orderByClause(input.sort, (f) => BENCHMARK_COLUMNS[f], "benchmark.id");
  }
  // LEFT JOIN subject_type so every list row carries its subject type's public key (nullable — an
  // untyped benchmark or a missing type row yields null). `benchmark.*` keeps the row shape intact.
  const rawRows = (
    await db
      .prepare(
        `SELECT benchmark.*, st.key AS subject_type_key FROM benchmark LEFT JOIN subject_type st ON st.id = benchmark.subject_type${join} ${where.sql} ${order} LIMIT ? OFFSET ?`,
      )
      .bind(...joinBinds, ...where.binds, input.limit, input.offset)
      .all<BenchmarkRow & { subject_type_key: string | null }>()
  ).results;
  const rows = await attachPublisherSlug(db, rawRows);

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
  /** The subject_type every linked subject must conform to. */
  subject_type: string;
  measurement_schema: MeasurementSchema;
  /** Browse metadata — editable at any status, like `name`. */
  category: Category;
}

export async function updateBenchmark(
  db: D1Database,
  id: string,
  input: UpdateBenchmarkInput,
): Promise<BenchmarkRowWithPublisher | null> {
  const existing = await getBenchmarkById(db, id);
  if (!existing) return null;
  // The subject type may change on update, so re-resolve its key (the route validated the ref).
  const st = await db
    .prepare("SELECT key FROM subject_type WHERE id = ?")
    .bind(input.subject_type)
    .first<{ key: string }>();
  const updated: BenchmarkRowWithPublisher = {
    ...existing,
    name: input.name,
    description: input.description,
    about: input.about,
    methodology: input.methodology,
    subject_type: input.subject_type,
    subject_type_key: st?.key ?? null,
    measurement_schema: JSON.stringify(input.measurement_schema),
    category: input.category,
    updated_at: Date.now(),
  };
  await db
    .prepare(
      "UPDATE benchmark SET name=?, description=?, about=?, methodology=?, subject_type=?, measurement_schema=?, category=?, updated_at=? WHERE id=?",
    )
    .bind(
      updated.name,
      updated.description,
      updated.about,
      updated.methodology,
      updated.subject_type,
      updated.measurement_schema,
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
): Promise<BenchmarkRowWithPublisher | null> {
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
): Promise<BenchmarkRowWithPublisher | null> {
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
): Promise<BenchmarkRowWithPublisher | null> {
  await db
    .prepare(
      "UPDATE benchmark SET status='PUBLISHED', draft=0, published_at=?, published_by_user_id=?, published_as_kind=?, published_identity_id=?, attribution_snapshot=?, updated_at=? WHERE id=?",
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
): Promise<BenchmarkRowWithPublisher | null> {
  await db
    .prepare(
      "UPDATE benchmark SET status='WITHDRAWN', withdrawn_at=?, withdrawal_reason=?, updated_at=? WHERE id=?",
    )
    .bind(now, reason, now, id)
    .run();
  return getBenchmarkById(db, id);
}

/**
 * Hard-delete a benchmark and its whole subtree. Two callers: the publisher's DELETE (the route
 * guarantees PRIVATE) and the operator-only takedown (any status). Subjects are NOT deleted — they
 * are account-owned and may be linked to other benchmarks; only this benchmark's links (and the
 * measurements under its runs) go away. Scoped API keys authorize nothing once their subtree is
 * gone, and metric links must not orphan (a dangling link makes its metric permanently
 * undeletable), so both are cleaned up here too.
 */
export async function deleteBenchmarkCascade(db: D1Database, id: string): Promise<void> {
  await db.batch([
    db
      .prepare(
        "DELETE FROM measurement WHERE run_id IN (SELECT id FROM run WHERE benchmark_id = ?)",
      )
      .bind(id),
    db
      .prepare(
        "DELETE FROM api_key WHERE scope_type = 'RUN' AND scope_ref IN (SELECT id FROM run WHERE benchmark_id = ?)",
      )
      .bind(id),
    db.prepare("DELETE FROM run WHERE benchmark_id = ?").bind(id),
    db.prepare("DELETE FROM benchmark_subject WHERE benchmark_id = ?").bind(id),
    db.prepare("DELETE FROM benchmark_metric WHERE benchmark_id = ?").bind(id),
    db.prepare("DELETE FROM benchmark_tag WHERE benchmark_id = ?").bind(id),
    db.prepare("DELETE FROM api_key WHERE scope_type = 'BENCHMARK' AND scope_ref = ?").bind(id),
    db.prepare("DELETE FROM benchmark WHERE id = ?").bind(id),
  ]);
}
