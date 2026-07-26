-- 0012 — terminology: finish the observation→measurement rename. Migration 0009 renamed the data
-- points (observation → measurement); this renames the benchmark column that describes them,
-- observation_schema → measurement_schema, so no "observation" vocabulary remains. No data to preserve.
ALTER TABLE benchmark RENAME COLUMN observation_schema TO measurement_schema;
