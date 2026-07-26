-- 0027 — rename takedown_request → issue. The operator-report feature was rebranded "issue": the
-- table, its index, and the API resource type all drop the "takedown" name. Data is preserved —
-- RENAME TO keeps every row, the embedded CHECK constraint, and the column layout intact; only the
-- benchmark-correlated index is dropped and recreated under the new name (SQLite/D1 cannot rename an
-- index in place). No data migration is needed.
ALTER TABLE takedown_request RENAME TO issue;

DROP INDEX idx_takedown_request_benchmark;
CREATE INDEX idx_issue_benchmark ON issue (benchmark_id);
