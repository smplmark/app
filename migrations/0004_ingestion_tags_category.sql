-- 0004 — seed-data ingestion groundwork: INGESTED attribution kind, tags, category, and the
-- built-in `system` account.
--
-- Forward-only (0001–0003 are frozen). Adds:
--   • benchmark.published_as_kind widened to allow 'INGESTED' — benchmarks seeded from third-party
--     open-data sources. The frozen attribution_snapshot for that kind carries
--     { source_name, source_url, license, retrieved_at } (retrieved_at epoch-ms, like every stamp).
--   • benchmark.category — one coarse browse bucket per benchmark (the nav rail); tags carry the
--     flexible long tail.
--   • tag + benchmark_tag — free-form curated tags, many-to-many.
--   • the `system` account — owner of all ingested benchmarks. No members, no verified user, so it
--     can never publish through the API; the ingestion importer writes its rows directly.
--
-- SQLite can't ALTER a CHECK constraint, so benchmark is rebuilt. D1 enforces foreign keys per
-- statement (PRAGMA defer_foreign_keys does not span the migration runner's statements), and
-- target/run/observation rows reference benchmark — so the swap must be FK-valid at every statement
-- boundary: park the child chain in plain copies, drop the children (child-side drops never
-- violate), swap benchmark, then recreate and refill the children. Rename-first (the 0002 pattern)
-- is not an option here: renaming a referenced table rewrites the REFERENCES clauses pointing at it.

-- ── Rebuild benchmark: widened published_as_kind CHECK + category ─────────────
CREATE TABLE benchmark_new (
  id                TEXT    PRIMARY KEY,
  account_id        TEXT    NOT NULL REFERENCES account (id),
  key               TEXT    NOT NULL,
  name              TEXT    NOT NULL,
  -- Short tagline. `about` is the long overview; `methodology` the how-it's-produced writeup.
  description       TEXT,
  about             TEXT,
  methodology       TEXT,
  status            TEXT    NOT NULL DEFAULT 'PRIVATE'
                           CHECK (status IN ('PRIVATE', 'PUBLISHED', 'WITHDRAWN')),
  published_at      INTEGER,
  withdrawn_at      INTEGER,
  withdrawal_reason TEXT,
  -- JSON: the metric + derived + chart declaration. Semantic core freezes on publish.
  sample_schema     TEXT    NOT NULL,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  created_by_user_id   TEXT REFERENCES user (id),
  draft                INTEGER NOT NULL DEFAULT 1,
  published_by_user_id TEXT REFERENCES user (id),
  -- PERSONAL → the author; ORGANIZATION → a domain-verified brand; INGESTED → open reference data
  -- seeded by the ingestion importer (never settable through the API).
  published_as_kind    TEXT
                        CHECK (published_as_kind IN ('PERSONAL', 'ORGANIZATION', 'INGESTED')),
  -- Soft pointer (deliberately NO foreign key) — see 0003.
  published_identity_id TEXT,
  -- JSON, written once at publish, never rewritten:
  --   ORGANIZATION → { "name", "logo_url", "verified_domains": [...] }
  --   PERSONAL     → { "display_name", "email_sha256" }
  --   INGESTED     → { "source_name", "source_url", "license", "retrieved_at" }
  attribution_snapshot TEXT,
  -- One coarse browse bucket for the top-level nav rail. Tags are the flexible mechanism.
  category          TEXT    NOT NULL DEFAULT 'OTHER'
                           CHECK (category IN ('HARDWARE', 'DATABASE', 'ML_AI', 'STORAGE', 'NETWORK', 'OTHER'))
);
INSERT INTO benchmark_new (
    id, account_id, key, name, description, about, methodology, status, published_at, withdrawn_at,
    withdrawal_reason, sample_schema, created_at, updated_at, created_by_user_id, draft,
    published_by_user_id, published_as_kind, published_identity_id, attribution_snapshot, category)
  SELECT
    id, account_id, key, name, description, about, methodology, status, published_at, withdrawn_at,
    withdrawal_reason, sample_schema, created_at, updated_at, created_by_user_id, draft,
    published_by_user_id, published_as_kind, published_identity_id, attribution_snapshot, 'OTHER'
  FROM benchmark;

-- Park the child chain (plain copies, no constraints), then drop the originals so nothing
-- references benchmark during the swap.
CREATE TABLE target_copy      AS SELECT * FROM target;
CREATE TABLE run_copy         AS SELECT * FROM run;
CREATE TABLE observation_copy AS SELECT * FROM observation;
DROP TABLE observation;
DROP TABLE run;
DROP TABLE target;
DROP TABLE benchmark;
ALTER TABLE benchmark_new RENAME TO benchmark;
CREATE UNIQUE INDEX benchmark_account_key ON benchmark (account_id, key);
CREATE INDEX benchmark_account ON benchmark (account_id);
CREATE INDEX benchmark_status ON benchmark (status);
-- Serves filter[category] on the public browse list.
CREATE INDEX benchmark_category ON benchmark (category);

-- Recreate the children exactly as 0001 defined them, refill from the copies, drop the copies.
CREATE TABLE target (
  id           TEXT    PRIMARY KEY,
  benchmark_id TEXT    NOT NULL REFERENCES benchmark (id),
  key          TEXT    NOT NULL,
  name         TEXT    NOT NULL,
  details      TEXT,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
INSERT INTO target SELECT * FROM target_copy;
DROP TABLE target_copy;
CREATE UNIQUE INDEX target_benchmark_key ON target (benchmark_id, key);
CREATE INDEX target_benchmark ON target (benchmark_id);

CREATE TABLE run (
  id                    TEXT    PRIMARY KEY,
  target_id             TEXT    NOT NULL REFERENCES target (id),
  key                   TEXT    NOT NULL,
  name                  TEXT,
  details               TEXT,
  -- Origin for relative-time derived metrics (elapsed_ms). Nullable.
  started_at            INTEGER,
  -- NULL ⇒ live (still recording). actions/end stamps it. Surfaced as `live` (no is_ prefix).
  ended_at              INTEGER,
  -- Run-level invalidation is annotation, never removal. Surfaced as `invalidated`.
  invalidated_at        INTEGER,
  invalidation_reason   TEXT,
  invalidated_by_user_id TEXT   REFERENCES user (id),
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL
);
INSERT INTO run SELECT * FROM run_copy;
DROP TABLE run_copy;
CREATE UNIQUE INDEX run_target_key ON run (target_id, key);
CREATE INDEX run_target ON run (target_id);

CREATE TABLE observation (
  -- INTEGER PRIMARY KEY is a rowid alias: DB-assigned, returned as last_row_id. Stringified on wire.
  id         INTEGER PRIMARY KEY,
  run_id     TEXT    NOT NULL REFERENCES run (id),
  -- epoch-ms; server-stamps on ingest if absent (client may supply for historical bulk upload).
  created_at INTEGER NOT NULL,
  metrics    TEXT,
  meta       TEXT,
  -- From CF-Connecting-IP. Write-only: captured on ingest, never surfaced.
  client_ip  TEXT
);
INSERT INTO observation SELECT * FROM observation_copy;
DROP TABLE observation_copy;
-- Load-bearing: serves the chart/range query and keeps run-scoped range reads off a full scan.
CREATE INDEX observation_run_created ON observation (run_id, created_at);

-- ── Tags (free-form, curated; many-to-many with benchmark) ────────────────────
-- Tag keys are lowercase slugs (free-form strings, not SCREAMING_SNAKE_CASE enums). Rows are
-- created on first attach; orphaned tags (no remaining benchmark_tag rows) are garbage and may be
-- pruned — a tag carries no data beyond its key, so recreation is lossless.
CREATE TABLE tag (
  id         TEXT    PRIMARY KEY,
  key        TEXT    NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX tag_key ON tag (key);

CREATE TABLE benchmark_tag (
  benchmark_id TEXT    NOT NULL REFERENCES benchmark (id),
  tag_id       TEXT    NOT NULL REFERENCES tag (id),
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (benchmark_id, tag_id)
);
-- benchmark_id is covered as the leading PK column; tag_id serves filter[tag].
CREATE INDEX benchmark_tag_tag ON benchmark_tag (tag_id);

-- ── The system account ────────────────────────────────────────────────────────
-- Fixed id/key: the ingestion importer scopes its wipe-and-rebuild to account_id = 'acct-system',
-- and a deterministic id keeps local/remote identical. Deliberately no account_user rows — nobody
-- can log into it, and with no verified member it can never publish through the API.
INSERT INTO account (id, key, name, description, url, created_at, allow_personal_publish) VALUES
  ('acct-system', 'system', 'smplmark',
   'Openly licensed benchmark results ingested from third-party sources. Every ingested benchmark credits its source and license, and links back to the original data.',
   NULL, 1783123200000, 0);
