-- 0006 — the "closed" lifecycle signal for continuous publishing.
--
-- Forward-only (0001–0005 are frozen). Published benchmarks are append-only but OPEN by default:
-- new targets, runs, and observations may always be added. Closing is the publisher's explicit
-- "this is complete" signal — a closed target accepts no new runs/observations, a closed benchmark
-- accepts nothing new anywhere beneath it. Closing is REVERSIBLE (author or admin): it is a
-- lifecycle signal, not a credibility invariant — the credibility guarantees remain structural
-- (append-only history, invalidation-not-removal), and observation timestamps make any
-- close/reopen/append sequence inherently visible.
--
-- Runs need no new column: ended_at already is the run-level close (and ingestion now enforces it).

ALTER TABLE benchmark ADD COLUMN closed_at INTEGER;
ALTER TABLE target   ADD COLUMN closed_at INTEGER;
