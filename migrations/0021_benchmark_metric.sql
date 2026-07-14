-- 0021 — benchmark_metric: the many-to-many link between a benchmark and a metric from the account's
-- reusable metric library. One row per (benchmark, metric); a surrogate id keeps REST unlink (DELETE
-- /benchmark_metrics/:id) clean, and the unique pair prevents double-linking. Linking a metric snapshots
-- its definition into the benchmark's measurement_schema (a MetricDecl for STORED, a DerivedDecl with the
-- compiled JSON Logic for DERIVED) — that snapshot is what the compute-on-read engine and the publish
-- freeze use; this table records the association and provides the unlink handle.
CREATE TABLE benchmark_metric (
  id           TEXT    PRIMARY KEY,
  benchmark_id TEXT    NOT NULL REFERENCES benchmark (id),
  metric_id    TEXT    NOT NULL REFERENCES metric (id),
  created_at   INTEGER NOT NULL
);
CREATE UNIQUE INDEX benchmark_metric_pair ON benchmark_metric (benchmark_id, metric_id);
CREATE INDEX benchmark_metric_benchmark ON benchmark_metric (benchmark_id);
CREATE INDEX benchmark_metric_metric ON benchmark_metric (metric_id);
