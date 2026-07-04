-- 0007 — terminology: the platform's data points are OBSERVATIONS (the sample → observation
-- rename from the original overhaul), so the benchmark's declaration column follows suit.
-- SQLite RENAME COLUMN is safe here (no CHECK/type change; column references in other tables
-- don't exist for this column).

ALTER TABLE benchmark RENAME COLUMN sample_schema TO observation_schema;
