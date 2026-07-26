-- 0028 — per-run ingest quota support: a denormalized measurement counter on run.
--
-- POST /measurements enforces a per-run ceiling (MEASUREMENTS_PER_RUN_CAP in routes/measurements.ts).
-- Counting with COUNT(*) on every ingest would pay a query per write forever; instead the counter is
-- maintained in the same db.batch as each insert/delete (see data/measurements.ts), and enforcement
-- reads it off the run row the ingest path already loads — zero extra queries. Concurrent racing
-- inserts can drift the count by a few; a quota doesn't need exactness.
ALTER TABLE run ADD COLUMN measurement_count INTEGER NOT NULL DEFAULT 0;
UPDATE run SET measurement_count = (SELECT COUNT(*) FROM measurement WHERE measurement.run_id = run.id);
