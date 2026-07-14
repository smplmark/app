-- 0019: reshape subject_type field definitions (key→name identifier, name→label display, +description).
-- The subject_type.fields JSON changes property names, so a type stored under the old shape can't be
-- read by the new code. The schema (columns) is unchanged; only the JSON payload shape moves. Data is
-- disposable (smplmark has no customers) — clear the subject subtree child-first for the per-statement
-- FK check and let it be recreated (the ingestion importer regenerates its data; users recreate types).
DELETE FROM measurement;
DELETE FROM benchmark_subject;
DELETE FROM subject;
DELETE FROM subject_type;
