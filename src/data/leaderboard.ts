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

interface Clause {
  sql: string;
  binds: unknown[];
}

/** The free-text search predicate (AND of terms over name + details), or null when empty. */
function searchClause(search: string | undefined): Clause | null {
  const clauses: string[] = [];
  const binds: unknown[] = [];
  for (const term of parseSearchQuery(search ?? "")) {
    const like = `%${likePattern(term.toLowerCase())}%`;
    clauses.push("(lower(target.name) LIKE ? ESCAPE '\\' OR lower(target.details) LIKE ? ESCAPE '\\')");
    binds.push(like, like);
  }
  return clauses.length ? { sql: clauses.join(" AND "), binds } : null;
}

/** One `json_extract(details,'$.field') IN (…)` predicate per actively-filtered facet field. */
function facetClauses(facetFilters: Record<string, string[]>): { field: string; clause: Clause }[] {
  const out: { field: string; clause: Clause }[] = [];
  for (const [field, values] of Object.entries(facetFilters)) {
    if (values.length === 0) continue;
    assertSafeKey(field);
    const placeholders = values.map(() => "?").join(",");
    out.push({ field, clause: { sql: `json_extract(target.details, '$.${field}') IN (${placeholders})`, binds: [...values] } });
  }
  return out;
}

export async function benchmarkLeaderboard(
  db: D1Database,
  input: LeaderboardInput,
): Promise<LeaderboardResult> {
  assertSafeKey(input.sortField);
  const search = searchClause(input.search);
  const facets = facetClauses(input.facetFilters);
  const activeFields = facets.map((f) => f.field);

  // A WHERE built from search + every facet filter, optionally with one facet's own filter removed
  // (that "excludeField" pass is what makes a facet's counts DISJUNCTIVE — it can still show the
  // other values you could add within that same facet).
  const whereFor = (excludeField?: string): Clause => {
    const parts: Clause[] = [];
    if (search) parts.push(search);
    for (const f of facets) if (f.field !== excludeField) parts.push(f.clause);
    return {
      sql: parts.length ? `AND ${parts.map((p) => p.sql).join(" AND ")}` : "",
      binds: parts.flatMap((p) => p.binds),
    };
  };

  const full = whereFor();
  const dir = input.sortDesc ? "DESC" : "ASC";
  // json_extract yields NULL for a target missing the sort metric; SQLite orders NULL first, so for
  // DESC (the common "highest first") the metric-less rows land last, as a reader expects.
  const orderExpr = `CAST(json_extract(rep.metrics, '$.${input.sortField}') AS REAL)`;
  const FROM = "FROM target JOIN rep ON rep.target_id = target.id AND rep.rn = 1";

  const rowsSql =
    `${REP_CTE} SELECT target.id AS target_id, target.key AS key, target.name AS name,` +
    ` target.details AS details, rep.metrics AS metrics, rep.observed_at AS observed_at` +
    ` ${FROM} WHERE 1=1 ${full.sql} ORDER BY ${orderExpr} ${dir}, target.id ${dir} LIMIT ? OFFSET ?`;
  const countSql = `${REP_CTE} SELECT COUNT(*) AS n ${FROM} WHERE 1=1 ${full.sql}`;

  // Base facet pass: every (field, value) count over the full filter, in one json_each sweep. This
  // gives the correct counts for every UNfiltered facet; actively-filtered facets are overridden
  // below by their own disjunctive pass. (Scalar detail values only — json_each 'type' filter.)
  const baseFacetSql =
    `${REP_CTE} SELECT je.key AS field, je.value AS value, COUNT(*) AS n` +
    ` ${FROM}, json_each(target.details) je WHERE je.type IN ('text','integer','real') ${full.sql}` +
    ` GROUP BY je.key, je.value`;

  // One extra pass per actively-filtered facet: count its values with its OWN filter dropped.
  const perFacet = facets.map((f) => {
    const w = whereFor(f.field);
    return db
      .prepare(
        `${REP_CTE} SELECT json_extract(target.details, '$.${f.field}') AS value, COUNT(*) AS n` +
          ` ${FROM} WHERE json_extract(target.details, '$.${f.field}') IS NOT NULL ${w.sql}` +
          ` GROUP BY value`,
      )
      .bind(input.benchmarkId, ...w.binds);
  });

  // Everything in one D1 round-trip: rows + count + base facets + (one per active facet).
  const results = await db.batch([
    db.prepare(rowsSql).bind(input.benchmarkId, ...full.binds, input.limit, input.offset),
    db.prepare(countSql).bind(input.benchmarkId, ...full.binds),
    db.prepare(baseFacetSql).bind(input.benchmarkId, ...full.binds),
    ...perFacet,
  ]);

  const rows = (results[0].results ?? []) as unknown as LeaderboardRow[];
  const total = ((results[1].results?.[0] as { n?: number } | undefined)?.n ?? 0) as number;
  const baseFacetRows = (results[2].results ?? []) as unknown as { field: string; value: unknown; n: number }[];
  const disjunctive = new Map<string, { value: unknown; n: number }[]>();
  activeFields.forEach((field, i) => {
    disjunctive.set(field, (results[3 + i].results ?? []) as unknown as { value: unknown; n: number }[]);
  });

  return { rows, total, facets: buildFacets(baseFacetRows, disjunctive, new Set(activeFields)) };
}

/**
 * Assemble the facet list. Unfiltered fields take their counts from the base pass; each actively-
 * filtered field is overridden with its disjunctive pass (its own filter removed), so its other
 * values stay visible for OR-selection. Actively-filtered fields are always shown (so they can be
 * un-selected) even if they'd otherwise be dropped as single-valued or fall past the field cap.
 */
function buildFacets(
  baseRows: { field: string; value: unknown; n: number }[],
  disjunctive: Map<string, { value: unknown; n: number }[]>,
  activeFields: Set<string>,
): LeaderboardFacet[] {
  const byField = new Map<string, { value: string; count: number }[]>();
  const add = (field: string, value: unknown, count: number) => {
    if (value === null || value === undefined) return;
    const list = byField.get(field) ?? [];
    list.push({ value: String(value), count });
    byField.set(field, list);
  };
  for (const r of baseRows) if (!activeFields.has(r.field)) add(r.field, r.value, r.n);
  for (const [field, vals] of disjunctive) for (const v of vals) add(field, v.value, v.n);

  const facets: LeaderboardFacet[] = [];
  for (const [field, values] of byField) {
    if (values.length < 2 && !activeFields.has(field)) continue; // not a useful filter
    values.sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
    facets.push({
      field,
      values: values.slice(0, MAX_FACET_VALUES),
      truncated: values.length > MAX_FACET_VALUES,
    });
  }
  // Most-populated first, but never drop an actively-filtered facet when trimming to the field cap.
  facets.sort((a, b) => b.values.length - a.values.length || a.field.localeCompare(b.field));
  const kept = facets.filter((f) => activeFields.has(f.field));
  for (const f of facets) {
    if (kept.length >= MAX_FACET_FIELDS) break;
    if (!activeFields.has(f.field)) kept.push(f);
  }
  // Restore the population order for the final list.
  kept.sort((a, b) => b.values.length - a.values.length || a.field.localeCompare(b.field));
  return kept;
}
