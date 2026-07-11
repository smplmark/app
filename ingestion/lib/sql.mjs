// @ts-check
// Archive → SQL. Pure string building (no D1 binding, no fs) so every statement the importer will
// run is unit-testable. Two products: the scoped wipe of every ingested benchmark, and chunked
// INSERTs for a set of adapted benchmark trees.
//
// Invariants:
//   • Each source publishes under its own account (id `acct-<publisher-slug>`, key the slug),
//     created idempotently with INSERT OR IGNORE — a re-ingest never recreates or clobbers it, so
//     a person from the source can claim the account later and keep their edits. Benchmark keys are
//     therefore unique per publisher (the DB's (account_id, key) index), and the id folds the slug
//     in (`ing-<slug>-<key>`) so two publishers may share a key without colliding.
//   • The wipe is scoped by published_as_kind = 'INGESTED' — a bottom-up cascade (D1 enforces the
//     logical FKs), NEVER a table truncate. Real accounts, publisher accounts, and any
//     human-authored benchmark are untouchable.
//   • Ingested benchmarks are born PUBLISHED and CLOSED with published_as_kind = 'INGESTED' and a
//     frozen attribution snapshot; there is no API path that writes that kind. Closed because every
//     ingested benchmark is a point-in-time snapshot of an external source — smplmark receives no
//     continuous feed for it, so nothing new is ever appended (a re-import rebuilds it wholesale).
//   • Ids are deterministic functions of the keys, so re-importing the same archive produces
//     byte-identical SQL (reviewable diffs, stable cross-run references).
//   • Every statement stays under D1's ~100 KB statement cap via row- and byte-bounded chunking.

import { LIMITS } from "./limits.mjs";

// The legacy shared owner. No longer created or written; the wipe prunes it if it is left orphaned
// by the transition from single-account to per-publisher ownership.
export const SYSTEM_ACCOUNT_ID = "acct-system";

/** Deterministic account id for a publisher slug. @param {string} slug */
export function publisherAccountId(slug) {
  return `acct-${slug}`;
}

/**
 * Display strings over the platform limit are clamped with an ellipsis (identity keys are never
 * clamped — an over-long key throws instead, since truncation could silently merge two keys).
 * @param {string | null | undefined} value
 * @param {number} max
 * @param {{ clamped: number }} counter
 */
function clamp(value, max, counter) {
  if (typeof value !== "string" || value.length <= max) return value;
  counter.clamped += 1;
  return value.slice(0, max - 1) + "…";
}

/** @param {string} key @param {string} what */
function assertKeyLength(key, what) {
  if (key.length > LIMITS.keyLength) {
    throw new Error(`${what} key exceeds ${LIMITS.keyLength} chars: ${key}`);
  }
}

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
 * The scoped destructive wipe: delete every ingested benchmark's subtree, child-first, then prune
 * orphaned tags (tags carry no data beyond their key; recreation is lossless). Publisher accounts
 * are left intact — they are claimable and outlive any single import — but the legacy shared
 * `acct-system` owner is dropped once the transition has left it owning nothing.
 * benchmark_view_day is deliberately NOT wiped — benchmark ids are deterministic, so view history
 * survives a re-ingest and buildInsertSql recomputes views_total from it (stale buckets for
 * benchmarks that disappear for good are pruned there too).
 * @returns {string[]}
 */
export function buildWipeSql() {
  const owned = `SELECT id FROM benchmark WHERE published_as_kind = 'INGESTED'`;
  // Ingested targets are account-owned (not benchmark children), but their ids are deterministic
  // (`ing-<slug>-t-<key>`), so they're identified by the same `ing-%` convention the view-day prune
  // uses. Drop everything that references them (measurements, links) before the target rows, and the
  // links/measurements of any ingested benchmark's runs, child-first for the per-statement FK check.
  return [
    `DELETE FROM measurement WHERE run_id IN (SELECT id FROM run WHERE benchmark_id IN (${owned})) OR target_id LIKE 'ing-%'`,
    `DELETE FROM benchmark_target WHERE benchmark_id IN (${owned}) OR target_id LIKE 'ing-%'`,
    `DELETE FROM run WHERE benchmark_id IN (${owned})`,
    `DELETE FROM target WHERE id LIKE 'ing-%'`,
    `DELETE FROM benchmark_tag WHERE benchmark_id IN (${owned})`,
    `DELETE FROM benchmark WHERE published_as_kind = 'INGESTED'`,
    `DELETE FROM tag WHERE id NOT IN (SELECT DISTINCT tag_id FROM benchmark_tag)`,
    `DELETE FROM account WHERE id = ${q(SYSTEM_ACCOUNT_ID)} AND NOT EXISTS (SELECT 1 FROM benchmark WHERE account_id = ${q(SYSTEM_ACCOUNT_ID)})`,
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
 * buildWipeSql). Idempotently asserts one publisher account per source (INSERT OR IGNORE, so a
 * claimed account is never clobbered) before the benchmarks that hang off it, keeping the importer
 * standalone-safe on a freshly wiped local DB.
 * @param {ImportEntry[]} entries
 * @returns {{ statements: string[], counts: Record<string, number> }}
 */
export function buildInsertSql(entries) {
  const statements = [];
  const counts = { accounts: 0, benchmarks: 0, targets: 0, benchmark_targets: 0, runs: 0, measurements: 0, tag_links: 0, sources: 0, clamped: 0 };
  if (entries.length > LIMITS.benchmarksPerAccount) {
    throw new Error(
      `${entries.length} benchmarks exceeds the platform limit of ${LIMITS.benchmarksPerAccount} per account (see src/limits.ts) — tighten the adapters' curation caps`,
    );
  }

  // One account per source, plus the external-source catalog — both keyed off the distinct sources
  // in this import. The account is idempotent (INSERT OR IGNORE on the deterministic id) so a
  // re-ingest picks up new benchmarks without recreating or clobbering a possibly-claimed account;
  // the catalog is rebuilt wholesale like the benchmark subtree. All timestamps are the archive's
  // retrieved_at, keeping the SQL deterministic.
  statements.push("DELETE FROM external_source");
  const bySource = new Map();
  for (const { source, retrievedAt } of entries) {
    const seen = bySource.get(source.key);
    if (seen) seen.count += 1;
    else bySource.set(source.key, { source, retrievedAt, count: 1 });
  }
  for (const { source, retrievedAt, count } of bySource.values()) {
    statements.push(
      `INSERT OR IGNORE INTO account (id, key, name, description, url, created_at, allow_personal_publish) VALUES (${q(publisherAccountId(source.publisher.slug))}, ${q(source.publisher.slug)}, ${q(source.publisher.name)}, ${q(source.description ?? null)}, ${q(source.url)}, ${n(retrievedAt)}, 0)`,
    );
    counts.accounts += 1;
    statements.push(
      `INSERT INTO external_source (id, key, name, description, url, license, license_url, benchmark_count, retrieved_at, created_at, updated_at) VALUES (${q(`src-${source.key}`)}, ${q(source.key)}, ${q(source.name)}, ${q(source.description ?? null)}, ${q(source.url)}, ${q(source.license ?? null)}, ${q(source.licenseUrl ?? null)}, ${count}, ${n(retrievedAt)}, ${n(retrievedAt)}, ${n(retrievedAt)})`,
    );
    counts.sources += 1;
  }

  const benchRows = [];
  const targetRows = [];
  const benchmarkTargetRows = [];
  const runRows = [];
  const measurementRows = [];
  const tagStatements = [];
  const seenBenchKeys = new Set();

  // Per-source (= per-account) target state, persisted across the source's benchmarks:
  //   • dedupToTarget maps a stable dedup identity → the one target row shared for it, so the same
  //     real target measured under several of a source's benchmarks becomes ONE account-owned row
  //     linked many times (M:N). The identity is the adapter's source_external_id when present;
  //     otherwise the target is scoped to its benchmark (no cross-benchmark dedup — Mike's rule).
  //   • usedKeys enforces the account-unique key: two *different* targets that slugify the same are
  //     suffixed (-2, -3, …), since keys are now unique per account, not per benchmark.
  const targetStateBySource = new Map();
  /** @param {string} sourceKey */
  function targetState(sourceKey) {
    let s = targetStateBySource.get(sourceKey);
    if (!s) {
      s = { dedupToTarget: new Map(), usedKeys: new Set() };
      targetStateBySource.set(sourceKey, s);
    }
    return s;
  }
  const linkedPairs = new Set();

  for (const { benchmark: b, source, retrievedAt } of entries) {
    const slug = source.publisher.slug;
    // Keys are unique per publisher, not globally — dedup within the owning account, and fold the
    // slug into the id so two publishers may share a key without colliding.
    const dedupKey = `${slug} ${b.key}`;
    if (seenBenchKeys.has(dedupKey)) throw new Error(`duplicate benchmark key for publisher ${slug}: ${b.key}`);
    seenBenchKeys.add(dedupKey);
    assertKeyLength(b.key, "benchmark");
    if (b.targets.length > LIMITS.targetsPerBenchmark) {
      throw new Error(
        `${b.key}: ${b.targets.length} targets exceeds the platform limit of ${LIMITS.targetsPerBenchmark} (see src/limits.ts) — tighten the adapter's curation cap`,
      );
    }
    if (b.runs.length > LIMITS.runsPerBenchmark) {
      throw new Error(
        `${b.key}: ${b.runs.length} runs exceeds the platform limit of ${LIMITS.runsPerBenchmark} (see src/limits.ts)`,
      );
    }
    const bid = `ing-${slug}-${b.key}`;
    const attribution = JSON.stringify({
      source_name: source.name,
      source_url: source.url,
      license: source.license,
      retrieved_at: retrievedAt,
    });
    benchRows.push(
      `(${q(bid)}, ${q(publisherAccountId(slug))}, ${q(b.key)}, ${q(clamp(b.name, LIMITS.nameLength, counts))}, ${q(clamp(b.description, LIMITS.descriptionLength, counts))}, ${q(clamp(b.about, LIMITS.longTextLength, counts))}, ${q(clamp(b.methodology, LIMITS.longTextLength, counts))}, 'PUBLISHED', ${n(b.published_at ?? retrievedAt)}, NULL, NULL, ${q(JSON.stringify(b.observationSchema))}, ${n(retrievedAt)}, ${n(retrievedAt)}, NULL, 0, NULL, 'INGESTED', NULL, ${q(attribution)}, ${q(b.category)}, ${n(retrievedAt)})`,
    );
    counts.benchmarks += 1;

    for (const tag of b.tags) {
      tagStatements.push(
        `INSERT OR IGNORE INTO tag (id, key, created_at) VALUES (${q(`ing-tag-${tag}`)}, ${q(tag)}, ${n(retrievedAt)})`,
        `INSERT OR IGNORE INTO benchmark_tag (benchmark_id, tag_id, created_at) SELECT ${q(bid)}, id, ${n(retrievedAt)} FROM tag WHERE key = ${q(tag)}`,
      );
      counts.tag_links += 1;
    }

    // Targets are account-owned and linked into the benchmark (M:N). A benchmark-local key resolves
    // (via localKeyToTid) to the shared/account-scoped target id — dedup by source_external_id may
    // fold two local keys onto one row. The account-unique stored key is suffixed on collision.
    const st = targetState(source.key);
    const localKeyToTid = new Map();
    const localKeys = new Set();
    for (const t of b.targets) {
      if (localKeys.has(t.key)) throw new Error(`duplicate target key in ${b.key}: ${t.key}`);
      localKeys.add(t.key);
      assertKeyLength(t.key, `${b.key} target`);
      const dedupId =
        t.source_external_id !== undefined && t.source_external_id !== null
          ? `ext:${t.source_external_id}`
          : `bench:${b.key} ${t.key}`;
      let entry = st.dedupToTarget.get(dedupId);
      if (entry === undefined) {
        // A new distinct target: give it an account-unique key (suffix if a different target already
        // took the slug), then a deterministic account-scoped id.
        let key = t.key;
        if (st.usedKeys.has(key)) {
          let i = 2;
          while (st.usedKeys.has(`${key}-${i}`)) i += 1;
          key = `${key}-${i}`;
        }
        assertKeyLength(key, `${b.key} target (account-unique)`);
        st.usedKeys.add(key);
        if (st.usedKeys.size > LIMITS.targetsPerAccount) {
          throw new Error(
            `${slug}: more than ${LIMITS.targetsPerAccount} distinct targets (see src/limits.ts)`,
          );
        }
        const tid = `ing-${slug}-t-${key}`;
        targetRows.push(
          `(${q(tid)}, ${q(publisherAccountId(slug))}, ${q(key)}, ${q(clamp(t.name, LIMITS.nameLength, counts))}, ${q(t.details === undefined ? null : JSON.stringify(t.details))}, ${n(retrievedAt)}, ${n(retrievedAt)})`,
        );
        counts.targets += 1;
        entry = { id: tid };
        st.dedupToTarget.set(dedupId, entry);
      }
      localKeyToTid.set(t.key, entry.id);
      // Link the (possibly shared) target into this benchmark exactly once.
      const pair = `${bid} ${entry.id}`;
      if (!linkedPairs.has(pair)) {
        linkedPairs.add(pair);
        benchmarkTargetRows.push(
          `(${q(`${bid}-bt-${entry.id}`)}, ${q(bid)}, ${q(entry.id)}, ${n(retrievedAt)})`,
        );
        counts.benchmark_targets += 1;
      }
    }

    const runKeys = new Set();
    for (const r of b.runs) {
      if (runKeys.has(r.key)) throw new Error(`duplicate run key in ${b.key}: ${r.key}`);
      runKeys.add(r.key);
      assertKeyLength(r.key, `${b.key} run`);
      const rid = `${bid}-r-${r.key}`;
      runRows.push(
        `(${q(rid)}, ${q(bid)}, ${q(r.key)}, ${q(clamp(r.name ?? null, LIMITS.nameLength, counts))}, ${q(r.details === undefined ? null : JSON.stringify(r.details))}, ${n(r.started_at ?? null)}, ${n(r.ended_at ?? retrievedAt)}, NULL, NULL, NULL, ${n(retrievedAt)}, ${n(retrievedAt)})`,
      );
      counts.runs += 1;
    }

    // A measurement names a (run, target) pair. The run must be this benchmark's; the target key is
    // the benchmark-local handle, resolved to the shared/account-scoped target id via localKeyToTid.
    // Repeated (run, target) pairs are allowed on purpose — a run can measure the same target more
    // than once (the measurement table has no unique constraint), e.g. AMLB's per-fold results.
    for (const m of b.measurements) {
      if (!runKeys.has(m.run_key)) {
        throw new Error(`measurement in ${b.key} references unknown run ${JSON.stringify(m.run_key)}`);
      }
      const tid = localKeyToTid.get(m.target_key);
      if (tid === undefined) {
        throw new Error(`measurement in ${b.key} references unknown target ${JSON.stringify(m.target_key)}`);
      }
      const rid = `${bid}-r-${m.run_key}`;
      measurementRows.push(
        `(${q(rid)}, ${q(tid)}, ${n(m.created_at)}, ${q(JSON.stringify(m.metrics))}, ${q(m.meta === undefined ? null : JSON.stringify(m.meta))}, NULL)`,
      );
      counts.measurements += 1;
    }
  }

  statements.push(
    ...chunkInsert(
      "INSERT INTO benchmark (id, account_id, key, name, description, about, methodology, status, published_at, withdrawn_at, withdrawal_reason, observation_schema, created_at, updated_at, created_by_user_id, draft, published_by_user_id, published_as_kind, published_identity_id, attribution_snapshot, category, closed_at) VALUES",
      benchRows,
    ),
    ...tagStatements,
    ...chunkInsert(
      "INSERT INTO target (id, account_id, key, name, details, created_at, updated_at) VALUES",
      targetRows,
    ),
    ...chunkInsert(
      "INSERT INTO benchmark_target (id, benchmark_id, target_id, created_at) VALUES",
      benchmarkTargetRows,
    ),
    ...chunkInsert(
      "INSERT INTO run (id, benchmark_id, key, name, details, started_at, ended_at, invalidated_at, invalidation_reason, invalidated_by_user_id, created_at, updated_at) VALUES",
      runRows,
    ),
    ...chunkInsert(
      "INSERT INTO measurement (run_id, target_id, created_at, metrics, meta, client_ip) VALUES",
      measurementRows,
    ),
    // Rebuild the search index for the ingested scope (same expression as migration 0005 /
    // src/data/benchmarks.ts — keep the three in sync).
    `UPDATE benchmark SET search_text = lower(
  coalesce(key, '') || ' ' || coalesce(name, '') || ' ' || coalesce(description, '') || ' ' ||
  coalesce(about, '') || ' ' || coalesce(methodology, '') || ' ' || coalesce(category, '') || ' ' ||
  coalesce((SELECT group_concat(t.key, ' ') FROM benchmark_tag bt JOIN tag t ON t.id = bt.tag_id
            WHERE bt.benchmark_id = benchmark.id), '') || ' ' ||
  coalesce(json_extract(attribution_snapshot, '$.source_name'), '')
) WHERE published_as_kind = 'INGESTED'`,
    // Popularity survives the wipe-and-rebuild: ids are deterministic, so the untouched per-day
    // view buckets still apply — recompute the all-time counter from them, then drop buckets for
    // ingested benchmarks that no longer exist (source removed for good).
    `UPDATE benchmark SET views_total = coalesce((SELECT SUM(views) FROM benchmark_view_day WHERE benchmark_id = benchmark.id), 0) WHERE published_as_kind = 'INGESTED'`,
    `DELETE FROM benchmark_view_day WHERE benchmark_id LIKE 'ing-%' AND benchmark_id NOT IN (SELECT id FROM benchmark)`,
  );

  return { statements, counts };
}
