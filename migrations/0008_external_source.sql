-- 0008 — external_source: the catalog of third-party sources the ingestion importer republishes
-- benchmark results from. One row per source, rebuilt by every import run — the importer owns this
-- table the same way it owns the system account's benchmarks; there is no API write surface.
-- Drives GET /api/v1/external_sources (the website's data-driven /sources page) and, later, the
-- poller that watches sources for new upstream benchmarks.
CREATE TABLE external_source (
  id              TEXT    PRIMARY KEY,
  key             TEXT    NOT NULL UNIQUE,
  name            TEXT    NOT NULL,
  -- Display copy: what kinds of benchmark results the source publishes.
  description     TEXT,
  url             TEXT    NOT NULL,
  license         TEXT,
  license_url     TEXT,
  benchmark_count INTEGER NOT NULL DEFAULT 0,
  -- When we last retrieved data from the source (the imported archive's pull time, epoch-ms).
  retrieved_at    INTEGER NOT NULL,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
