-- 0009 — re-parent `run` from `target` to `benchmark`, and rename `observation` → `measurement`
-- (adding `target_id`). Forward-only (0001–0008 are frozen).
--
-- A run is a measurement occasion that spans whatever targets have measurements in it: a comparative
-- sweep is one run over many targets; independent targets are runs that each hold one target's
-- measurements. So `run` now hangs off the benchmark, and a `measurement` names BOTH the run (the
-- occasion) and the target (the thing measured) — both benchmark children.
--
-- There is no production data to preserve for this subtree (ingested data is rebuildable; no
-- first-party benchmark exists yet), so this is a DROP + RECREATE + re-ingest, NOT a data-preserving
-- backfill. D1 enforces FKs per statement (defer_foreign_keys does not span the migration runner's
-- statement boundaries), so drop the leaf before its parent and recreate parents before children.
-- account/user/account_user/api_key/user_identity/session/email_verification/invitation/
-- publisher_identity/publisher_domain/benchmark/tag/benchmark_tag/benchmark_view_day/external_source
-- are ALL untouched — only run, observation→measurement, and target's rows change.

-- Leaf first: drop the old observation table (replaced by measurement with a target_id column).
DROP TABLE observation;

-- Re-parent run: target_id → benchmark_id; unique key moves from (target_id, key) to (benchmark_id, key).
DROP TABLE run;
CREATE TABLE run (
  id                     TEXT    PRIMARY KEY,
  benchmark_id           TEXT    NOT NULL REFERENCES benchmark (id),
  key                    TEXT    NOT NULL,
  name                   TEXT,
  details                TEXT,
  started_at             INTEGER,
  ended_at               INTEGER,
  invalidated_at         INTEGER,
  invalidation_reason    TEXT,
  invalidated_by_user_id TEXT    REFERENCES user (id),
  created_at             INTEGER NOT NULL,
  updated_at             INTEGER NOT NULL
);
CREATE UNIQUE INDEX run_benchmark_key ON run (benchmark_id, key);
CREATE INDEX run_benchmark ON run (benchmark_id);

-- target keeps its structure (already benchmark-owned); only its rows are cleared for re-ingest.
DELETE FROM target;

-- measurement (renamed observation) names both the run and the target. id is the DB-assigned rowid.
CREATE TABLE measurement (
  id         INTEGER PRIMARY KEY,
  run_id     TEXT    NOT NULL REFERENCES run (id),
  target_id  TEXT    NOT NULL REFERENCES target (id),
  created_at INTEGER NOT NULL,
  metrics    TEXT,
  meta       TEXT,
  client_ip  TEXT
);
CREATE INDEX measurement_run_created ON measurement (run_id, created_at);
CREATE INDEX measurement_target_created ON measurement (target_id, created_at);
CREATE INDEX measurement_run_target ON measurement (run_id, target_id);
