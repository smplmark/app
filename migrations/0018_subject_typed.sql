-- 0018 — subjects become typed. Every subject now picks a subject_type; its `details` column holds the
-- typed field values (keyed by field key), validated against that type at write time. subject_type_id
-- is app-required on create; at the DB level it's a nullable FK (SQLite can't ADD a NOT NULL column
-- without a default). The subject subtree is disposable, so we clear it here to guarantee no typeless
-- rows survive the change — ingested data is rebuilt (with types) by the importer.
DELETE FROM measurement;
DELETE FROM benchmark_subject;
DELETE FROM subject;

ALTER TABLE subject ADD COLUMN subject_type_id TEXT REFERENCES subject_type (id);
CREATE INDEX subject_subject_type ON subject (subject_type_id);
