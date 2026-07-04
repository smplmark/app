// @ts-check
// Archive → SQL. Pure string building (no D1 binding, no fs) so every statement the importer will
// run is unit-testable. Two products: the scoped wipe of everything the system account owns, and
// chunked INSERTs for a set of adapted benchmark trees.
//
// Invariants:
//   • The wipe is scoped by account_id = SYSTEM_ACCOUNT_ID — a bottom-up cascade (D1 enforces the
//     logical FKs), NEVER a table truncate. Real accounts and their benchmarks are untouchable.
//   • Ingested benchmarks are born PUBLISHED with published_as_kind = 'INGESTED' and a frozen
//     attribution snapshot; there is no API path that writes that kind.
//   • Ids are deterministic functions of the keys, so re-importing the same archive produces
//     byte-identical SQL (reviewable diffs, stable cross-run references).
//   • Every statement stays under D1's ~100 KB statement cap via row- and byte-bounded chunking.

export const SYSTEM_ACCOUNT_ID = "acct-system";

/**
 * SQL string literal (single-quote doubling); null/undefined → NULL.
 * @param {unknown} value
 */
export function q(value) {
  if (value === null || value === undefined) return "NULL";
  return `'${String(value).replace(/'/g, "''")}'`;
}

/**
 * SQL number literal; rejects non-finite values loudly rather than emitting garbage.
 * @param {unknown} value
 */
export function n(value) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`not a finite number: ${String(value)}`);
  }
  return String(value);
}

/**
 * The scoped destructive wipe: delete the system account's entire benchmark subtree, child-first,
 * then prune orphaned tags (tags carry no data beyond their key; recreation is lossless).
 * @returns {string[]}
 */
export function buildWipeSql() {
  const owned = `SELECT id FROM benchmark WHERE account_id = ${q(SYSTEM_ACCOUNT_ID)}`;
  return [
    `DELETE FROM observation WHERE run_id IN (SELECT run.id FROM run JOIN target ON target.id = run.target_id WHERE target.benchmark_id IN (${owned}))`,
    `DELETE FROM run WHERE target_id IN (SELECT id FROM target WHERE benchmark_id IN (${owned}))`,
    `DELETE FROM target WHERE benchmark_id IN (${owned})`,
    `DELETE FROM benchmark_tag WHERE benchmark_id IN (${owned})`,
    `DELETE FROM benchmark WHERE account_id = ${q(SYSTEM_ACCOUNT_ID)}`,
    `DELETE FROM tag WHERE id NOT IN (SELECT DISTINCT tag_id FROM benchmark_tag)`,
  ];
}

const MAX_ROWS_PER_INSERT = 80;
const MAX_BYTES_PER_STATEMENT = 80_000;

/**
 * Multi-row INSERT chunked by row count and statement size.
 * @param {string} head e.g. "INSERT INTO target (…) VALUES"
 * @param {string[]} rows "(…)" tuples
 * @returns {string[]}
 */
function chunkInsert(head, rows) {
  const statements = [];
  let batch = [];
  let bytes = head.length;
  for (const row of rows) {
    if (batch.length > 0 && (batch.length >= MAX_ROWS_PER_INSERT || bytes + row.length > MAX_BYTES_PER_STATEMENT)) {
      statements.push(`${head}\n${batch.join(",\n")}`);
      batch = [];
      bytes = head.length;
    }
    batch.push(row);
    bytes += row.length + 2;
  }
  if (batch.length > 0) statements.push(`${head}\n${batch.join(",\n")}`);
  return statements;
}

/**
 * @typedef {import("./model.mjs").IngestBenchmark} IngestBenchmark
 * @typedef {import("./model.mjs").SourceMeta} SourceMeta
 *
 * @typedef {Object} ImportEntry
 * @property {IngestBenchmark} benchmark
 * @property {SourceMeta} source
 * @property {number} retrievedAt epoch-ms from the source archive's manifest
 */

/**
 * Build the INSERT statements for a set of adapted benchmarks (no wipe — compose with
 * buildWipeSql). Also re-asserts the system account so the importer is standalone-safe on a
 * freshly wiped local DB.
 * @param {ImportEntry[]} entries
 * @returns {{ statements: string[], counts: Record<string, number> }}
 */
export function buildInsertSql(entries) {
  const statements = [];
  const counts = { benchmarks: 0, targets: 0, runs: 0, observations: 0, tag_links: 0 };

  statements.push(
    `INSERT OR IGNORE INTO account (id, key, name, description, url, created_at, allow_personal_publish) VALUES (${q(SYSTEM_ACCOUNT_ID)}, 'system', 'smplmark', 'Openly licensed benchmark results ingested from third-party sources. Every ingested benchmark credits its source and license, and links back to the original data.', NULL, 1783123200000, 0)`,
  );

  const benchRows = [];
  const targetRows = [];
  const runRows = [];
  const obsRows = [];
  const tagStatements = [];
  const seenBenchKeys = new Set();

  for (const { benchmark: b, source, retrievedAt } of entries) {
    if (seenBenchKeys.has(b.key)) throw new Error(`duplicate benchmark key: ${b.key}`);
    seenBenchKeys.add(b.key);
    const bid = `ing-${b.key}`;
    const attribution = JSON.stringify({
      source_name: source.name,
      source_url: source.url,
      license: source.license,
      retrieved_at: retrievedAt,
    });
    benchRows.push(
      `(${q(bid)}, ${q(SYSTEM_ACCOUNT_ID)}, ${q(b.key)}, ${q(b.name)}, ${q(b.description)}, ${q(b.about)}, ${q(b.methodology)}, 'PUBLISHED', ${n(retrievedAt)}, NULL, NULL, ${q(JSON.stringify(b.sampleSchema))}, ${n(retrievedAt)}, ${n(retrievedAt)}, NULL, 0, NULL, 'INGESTED', NULL, ${q(attribution)}, ${q(b.category)})`,
    );
    counts.benchmarks += 1;

    for (const tag of b.tags) {
      tagStatements.push(
        `INSERT OR IGNORE INTO tag (id, key, created_at) VALUES (${q(`ing-tag-${tag}`)}, ${q(tag)}, ${n(retrievedAt)})`,
        `INSERT OR IGNORE INTO benchmark_tag (benchmark_id, tag_id, created_at) SELECT ${q(bid)}, id, ${n(retrievedAt)} FROM tag WHERE key = ${q(tag)}`,
      );
      counts.tag_links += 1;
    }

    const seenTargetKeys = new Set();
    for (const t of b.targets) {
      if (seenTargetKeys.has(t.key)) throw new Error(`duplicate target key in ${b.key}: ${t.key}`);
      seenTargetKeys.add(t.key);
      const tid = `${bid}-t-${t.key}`;
      targetRows.push(
        `(${q(tid)}, ${q(bid)}, ${q(t.key)}, ${q(t.name)}, ${q(t.details === undefined ? null : JSON.stringify(t.details))}, ${n(retrievedAt)}, ${n(retrievedAt)})`,
      );
      counts.targets += 1;

      const seenRunKeys = new Set();
      for (const r of t.runs) {
        if (seenRunKeys.has(r.key)) throw new Error(`duplicate run key in ${b.key}/${t.key}: ${r.key}`);
        seenRunKeys.add(r.key);
        const rid = `${tid}-r-${r.key}`;
        runRows.push(
          `(${q(rid)}, ${q(tid)}, ${q(r.key)}, ${q(r.name ?? null)}, ${q(r.details === undefined ? null : JSON.stringify(r.details))}, ${n(r.started_at ?? null)}, ${n(r.ended_at ?? retrievedAt)}, NULL, NULL, NULL, ${n(retrievedAt)}, ${n(retrievedAt)})`,
        );
        counts.runs += 1;

        for (const o of r.observations) {
          obsRows.push(
            `(${q(rid)}, ${n(o.created_at)}, ${q(JSON.stringify(o.metrics))}, ${q(o.meta === undefined ? null : JSON.stringify(o.meta))}, NULL)`,
          );
          counts.observations += 1;
        }
      }
    }
  }

  statements.push(
    ...chunkInsert(
      "INSERT INTO benchmark (id, account_id, key, name, description, about, methodology, status, published_at, withdrawn_at, withdrawal_reason, sample_schema, created_at, updated_at, created_by_user_id, draft, published_by_user_id, published_as_kind, published_identity_id, attribution_snapshot, category) VALUES",
      benchRows,
    ),
    ...tagStatements,
    ...chunkInsert(
      "INSERT INTO target (id, benchmark_id, key, name, details, created_at, updated_at) VALUES",
      targetRows,
    ),
    ...chunkInsert(
      "INSERT INTO run (id, target_id, key, name, details, started_at, ended_at, invalidated_at, invalidation_reason, invalidated_by_user_id, created_at, updated_at) VALUES",
      runRows,
    ),
    ...chunkInsert(
      "INSERT INTO observation (run_id, created_at, metrics, meta, client_ip) VALUES",
      obsRows,
    ),
  );

  return { statements, counts };
}
