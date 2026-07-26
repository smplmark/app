-- 0020 — metric: a reusable, account-owned catalogue of metric definitions. Each metric has a
-- snake_case `name` (the key it occupies in a measurement's metrics bag, unique per account), a display
-- `label`, an optional `description`, a semantic `type`, and a `kind` — STORED (a value clients POST)
-- or DERIVED (computed on read from a small, closed set of formulas, held in `formula` JSON). Metrics
-- are linked to benchmarks many-to-many in a later migration; linking snapshots the definition into the
-- benchmark's measurement_schema (which is what the compute-on-read engine and publish-freeze use).
CREATE TABLE metric (
  id          TEXT    PRIMARY KEY,
  account_id  TEXT    NOT NULL REFERENCES account (id),
  name        TEXT    NOT NULL,
  label       TEXT    NOT NULL,
  description TEXT,
  type        TEXT    NOT NULL,
  kind        TEXT    NOT NULL,
  formula     TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE UNIQUE INDEX metric_account_name ON metric (account_id, name);
CREATE INDEX metric_account ON metric (account_id);
