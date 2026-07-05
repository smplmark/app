// The benchmark leaderboard read: a paginated, server-sorted, server-filtered projection of a
// benchmark's targets, each joined to its representative (latest) observation's metrics. This is
// what lets the viewer slice a 10k+ target benchmark (e.g. SPEC CPU2017) without shipping every row
// to the browser — sort by any declared metric, filter by free text or by a `details` facet, and
// get value→count facets computed over the current filter in the same round-trip.
import { BadRequestError } from "../errors";
import { likePattern, parseSearchQuery } from "../query/search";

/** A JSON-path key we interpolate into json_extract must be a plain identifier (no injection). */
const SAFE_KEY = /^[A-Za-z0-9_]+$/;

export interface LeaderboardInput {
  benchmarkId: string;
  /** A declared metric name to sort by; the route validates it against the benchmark's schema. */
  sortField: string;
  sortDesc: boolean;
  /** Free-text terms AND-ed across target name + details. */
  search?: string;
  /** facet field → the allowed values (OR within a field, AND across fields). */
  facetFilters: Record<string, string[]>;
  limit: number;
  offset: number;
}

export interface LeaderboardRow {
  target_id: string;
  key: string;
  name: string;
  details: string | null;
  metrics: string | null;
  observed_at: number | null;
}

export interface LeaderboardFacet {
  field: string;
  values: { value: string; count: number }[];
  truncated: boolean;
}

export interface LeaderboardResult {
  rows: LeaderboardRow[];
  total: number;
  facets: LeaderboardFacet[];
}

// A details field is offered as a facet when it has between 2 and this many distinct values; a
// higher-cardinality field (e.g. core counts) would be noise as checkbox filters.
const MAX_FACET_VALUES = 60;
const MAX_FACET_FIELDS = 12;

/** Latest observation per target within the benchmark → one representative metrics row per target. */
const REP_CTE =
  "WITH rep AS (" +
  " SELECT r.target_id AS target_id, o.metrics AS metrics, o.created_at AS observed_at," +
  "  ROW_NUMBER() OVER (PARTITION BY r.target_id ORDER BY o.created_at DESC, o.id DESC) AS rn" +
  " FROM observation o" +
  " JOIN run r ON r.id = o.run_id" +
  " JOIN target t ON t.id = r.target_id" +
  " WHERE t.benchmark_id = ?" +
  ")";

function assertSafeKey(key: string): void {
  if (!SAFE_KEY.test(key)) {
    throw new BadRequestError(`invalid field name ${JSON.stringify(key)}.`);
  }
}

/**
 * Build the shared WHERE (search + facet filters) and its binds. The rep CTE already scopes to the
 * benchmark, so the outer query needs no benchmark predicate.
 */
function buildFilters(input: LeaderboardInput): { sql: string; binds: unknown[] } {
  const clauses: string[] = [];
  const binds: unknown[] = [];

  for (const term of parseSearchQuery(input.search ?? "")) {
    const like = `%${likePattern(term.toLowerCase())}%`;
    // Match the visible name or any value in the details JSON (stored as text).
    clauses.push("(lower(target.name) LIKE ? ESCAPE '\\' OR lower(target.details) LIKE ? ESCAPE '\\')");
    binds.push(like, like);
  }

  for (const [field, values] of Object.entries(input.facetFilters)) {
    if (values.length === 0) continue;
    assertSafeKey(field);
    const placeholders = values.map(() => "?").join(",");
    clauses.push(`json_extract(target.details, '$.${field}') IN (${placeholders})`);
    binds.push(...values);
  }

  return { sql: clauses.length ? `AND ${clauses.join(" AND ")}` : "", binds };
}

export async function benchmarkLeaderboard(
  db: D1Database,
  input: LeaderboardInput,
): Promise<LeaderboardResult> {
  assertSafeKey(input.sortField);
  const filters = buildFilters(input);
  const dir = input.sortDesc ? "DESC" : "ASC";
  // json_extract yields NULL for a target missing the sort metric; SQLite orders NULL first, so for
  // DESC (the common "highest first") the metric-less rows land last, as a reader expects.
  const orderExpr = `CAST(json_extract(rep.metrics, '$.${input.sortField}') AS REAL)`;

  const rowsSql =
    `${REP_CTE} SELECT target.id AS target_id, target.key AS key, target.name AS name,` +
    ` target.details AS details, rep.metrics AS metrics, rep.observed_at AS observed_at` +
    ` FROM target JOIN rep ON rep.target_id = target.id AND rep.rn = 1` +
    ` WHERE 1=1 ${filters.sql}` +
    ` ORDER BY ${orderExpr} ${dir}, target.id ${dir} LIMIT ? OFFSET ?`;

  const countSql =
    `${REP_CTE} SELECT COUNT(*) AS n` +
    ` FROM target JOIN rep ON rep.target_id = target.id AND rep.rn = 1` +
    ` WHERE 1=1 ${filters.sql}`;

  // Every (field, value) count over the filtered set in one pass; JS groups + trims to facetable
  // fields. Numeric/text scalar detail values only (json_each 'type' filter excludes nested objects).
  const facetSql =
    `${REP_CTE} SELECT je.key AS field, je.value AS value, COUNT(*) AS n` +
    ` FROM target JOIN rep ON rep.target_id = target.id AND rep.rn = 1, json_each(target.details) je` +
    ` WHERE je.type IN ('text','integer','real') ${filters.sql}` +
    ` GROUP BY je.key, je.value`;

  const [rowsRes, countRes, facetRes] = await db.batch([
    db.prepare(rowsSql).bind(input.benchmarkId, ...filters.binds, input.limit, input.offset),
    db.prepare(countSql).bind(input.benchmarkId, ...filters.binds),
    db.prepare(facetSql).bind(input.benchmarkId, ...filters.binds),
  ]);

  const rows = (rowsRes.results ?? []) as unknown as LeaderboardRow[];
  const total = ((countRes.results?.[0] as { n?: number } | undefined)?.n ?? 0) as number;
  const facets = buildFacets(
    (facetRes.results ?? []) as unknown as { field: string; value: unknown; n: number }[],
  );
  return { rows, total, facets };
}

/** Group the flat (field,value,count) rows into facets, dropping degenerate/high-cardinality ones. */
function buildFacets(
  rows: { field: string; value: unknown; n: number }[],
): LeaderboardFacet[] {
  const byField = new Map<string, { value: string; count: number }[]>();
  for (const r of rows) {
    if (r.value === null || r.value === undefined) continue;
    const list = byField.get(r.field) ?? [];
    list.push({ value: String(r.value), count: r.n });
    byField.set(r.field, list);
  }

  const facets: LeaderboardFacet[] = [];
  for (const [field, values] of byField) {
    if (values.length < 2) continue; // a single-value field is not a useful filter
    values.sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
    facets.push({
      field,
      values: values.slice(0, MAX_FACET_VALUES),
      truncated: values.length > MAX_FACET_VALUES,
    });
  }
  // Show the most-populated facets first; bound how many we return.
  facets.sort((a, b) => b.values.length - a.values.length || a.field.localeCompare(b.field));
  return facets.slice(0, MAX_FACET_FIELDS);
}
