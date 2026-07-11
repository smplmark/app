-- 0010 — make `target` an account-owned entity and introduce a `benchmark_target` join, so a target
-- can belong to many benchmarks (M:N). Forward-only (0001–0009 are frozen).
--
-- Before: target was a benchmark child (target.benchmark_id, UNIQUE(benchmark_id, key)) — a target
-- existed only inside one benchmark. After: a target belongs to an ACCOUNT (the publisher/tenant) and
-- is reusable across that account's benchmarks; the many-to-many link lives in `benchmark_target`.
-- Runs stay benchmark-scoped; a `measurement` still names both its run and its target directly, and a
-- target's membership in the run's benchmark is validated through `benchmark_target` at write time
-- (D1 can't enforce that cross-pair rule; the app layer does — same no-leak invariant as everywhere).
--
-- `target.closed_at` is dropped: a shared target is an identity, not a per-benchmark lifecycle object.
-- The publisher's "complete" signal lives at the benchmark (`benchmark.closed_at`) and run
-- (`run.ended_at`) levels, which already gate new measurements.
--
-- There is no production data to preserve (ingested data is rebuildable; no first-party benchmark
-- exists yet), so this is a DROP + RECREATE + re-ingest, NOT a data-preserving backfill. D1 enforces
-- FKs per statement, so drop the leaf (measurement) before target, and recreate parents before
-- children. account/user/benchmark/run/tag/benchmark_tag/… are untouched.

-- Leaf first: measurement references target, so it goes before target is dropped.
DROP TABLE measurement;

-- target loses benchmark_id + closed_at, gains account_id; uniqueness moves to (account_id, key).
DROP TABLE target;
CREATE TABLE target (
  id         TEXT    PRIMARY KEY,
  account_id TEXT    NOT NULL REFERENCES account (id),
  key        TEXT    NOT NULL,
  name       TEXT    NOT NULL,
  details    TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX target_account_key ON target (account_id, key);
CREATE INDEX target_account ON target (account_id);

-- The many-to-many link. One row per (benchmark, target); a surrogate id makes REST unlink (DELETE
-- /benchmark_targets/:id) clean, while the unique pair prevents double-linking.
CREATE TABLE benchmark_target (
  id           TEXT    PRIMARY KEY,
  benchmark_id TEXT    NOT NULL REFERENCES benchmark (id),
  target_id    TEXT    NOT NULL REFERENCES target (id),
  created_at   INTEGER NOT NULL
);
CREATE UNIQUE INDEX benchmark_target_pair ON benchmark_target (benchmark_id, target_id);
CREATE INDEX benchmark_target_benchmark ON benchmark_target (benchmark_id);
CREATE INDEX benchmark_target_target ON benchmark_target (target_id);

-- Clear runs too (their measurements are gone) so re-ingest starts from a clean occasion slate.
DELETE FROM run;

-- measurement is unchanged in shape — recreated empty for re-ingest.
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
