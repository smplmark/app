-- 0005 — free-text search + view-based popularity.
--
-- Forward-only (0001–0004 are frozen). Adds:
--   • benchmark.search_text — the deliberately low-tech search index: one lowercased TEXT column
--     concatenating key, name, description, about, methodology, category, tag keys, and (for
--     ingested benchmarks) the attribution source name. filter[search] runs AND-ed case-insensitive
--     substring matches against it. Rebuilt by the app layer on create/update/tag change, by the
--     importer at ingest, and backfilled here.
--   • benchmark.views_total — all-time view count (the popularity beacon increments it).
--   • benchmark_view_day — per-UTC-day view buckets; rolling-window popularity sorts
--     (today / week / month / year) SUM over day >= cutoff. Never pruned by time — all-time is
--     recoverable from the buckets, and the ingestion importer recomputes views_total from them so
--     re-ingesting (same deterministic benchmark ids) never resets popularity.

ALTER TABLE benchmark ADD COLUMN search_text TEXT NOT NULL DEFAULT '';
ALTER TABLE benchmark ADD COLUMN views_total INTEGER NOT NULL DEFAULT 0;

-- Backfill: the same expression src/data/benchmarks.ts (refreshBenchmarkSearchText) and the
-- ingestion importer use — keep the three in sync.
UPDATE benchmark SET search_text = lower(
  coalesce(key, '') || ' ' || coalesce(name, '') || ' ' || coalesce(description, '') || ' ' ||
  coalesce(about, '') || ' ' || coalesce(methodology, '') || ' ' || coalesce(category, '') || ' ' ||
  coalesce((SELECT group_concat(t.key, ' ') FROM benchmark_tag bt JOIN tag t ON t.id = bt.tag_id
            WHERE bt.benchmark_id = benchmark.id), '') || ' ' ||
  coalesce(json_extract(attribution_snapshot, '$.source_name'), '')
);

CREATE TABLE benchmark_view_day (
  -- Deliberately a SOFT pointer (no foreign key), like benchmark.published_identity_id: view
  -- history must OUTLIVE its benchmark row across the ingestion importer's wipe-and-rebuild
  -- (D1 enforces FKs, so a real reference would abort the wipe). The importer prunes buckets
  -- whose ingested benchmark is gone for good.
  benchmark_id TEXT    NOT NULL,
  -- UTC day, 'YYYY-MM-DD'.
  day          TEXT    NOT NULL,
  views        INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (benchmark_id, day)
);
-- The rolling-window popularity sort scans by day cutoff.
CREATE INDEX benchmark_view_day_day ON benchmark_view_day (day);
