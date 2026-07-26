-- 0024 — a benchmark compares like against like: every subject linked to a benchmark must share one
-- subject type. Add the benchmark's `subject_type` (required by the API on create/update; linking a
-- subject of any other type is rejected). Backfill from the first linked subject; a benchmark with no
-- subjects stays NULL until its next edit sets one (the API requires it on PUT).
ALTER TABLE benchmark ADD COLUMN subject_type TEXT REFERENCES subject_type (id);
UPDATE benchmark SET subject_type = (
  SELECT s.subject_type_id
  FROM benchmark_subject bs
  JOIN subject s ON s.id = bs.subject_id
  WHERE bs.benchmark_id = benchmark.id
  ORDER BY bs.created_at
  LIMIT 1
);
