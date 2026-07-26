-- 0023 — unify a metric's `type` and `kind` into a single `type`: INTEGER | DECIMAL | FORMULA. The two
-- facets never varied independently in practice — "stored integer / stored decimal / computed from a
-- formula" is one question — and a formula's display precision is already owned by `format`, so the
-- separate STORED/DERIVED kind carries no information the type can't. Forward-only.
UPDATE metric SET type = 'FORMULA' WHERE kind = 'DERIVED';
ALTER TABLE metric DROP COLUMN kind;
