-- 0016 — rename `target` → `subject` (terminology only; the entity is unchanged). In a measurement
-- product, "target" reads as a goal/threshold you aim for; "subject" (as in "subject under test")
-- names the thing being measured without that ambiguity. RENAME preserves data; modern SQLite also
-- rewrites the foreign-key references in benchmark_subject/measurement to point at `subject`.

ALTER TABLE target RENAME TO subject;
ALTER TABLE benchmark_target RENAME TO benchmark_subject;
ALTER TABLE benchmark_subject RENAME COLUMN target_id TO subject_id;
ALTER TABLE measurement RENAME COLUMN target_id TO subject_id;

-- RENAME keeps the old index names; recreate them with subject-based names.
DROP INDEX IF EXISTS target_account_key;
DROP INDEX IF EXISTS target_account;
CREATE UNIQUE INDEX subject_account_key ON subject (account_id, key);
CREATE INDEX subject_account ON subject (account_id);

DROP INDEX IF EXISTS benchmark_target_pair;
DROP INDEX IF EXISTS benchmark_target_benchmark;
DROP INDEX IF EXISTS benchmark_target_target;
CREATE UNIQUE INDEX benchmark_subject_pair ON benchmark_subject (benchmark_id, subject_id);
CREATE INDEX benchmark_subject_benchmark ON benchmark_subject (benchmark_id);
CREATE INDEX benchmark_subject_subject ON benchmark_subject (subject_id);

DROP INDEX IF EXISTS measurement_target_created;
DROP INDEX IF EXISTS measurement_run_target;
CREATE INDEX measurement_subject_created ON measurement (subject_id, created_at);
CREATE INDEX measurement_run_subject ON measurement (run_id, subject_id);
