-- 0022 — decompose a metric's conflated `type` into three orthogonal facets. All metrics are numeric
-- measurements, so `type` narrows to the numeric kind (INTEGER | DECIMAL); the old values that really
-- encoded a unit or a display convention move to the new `unit` (what's measured — a display label like
-- `ms`, `bytes`, `req/s`, `%`) and `format` (an Excel-style number pattern like `#,##0.00`, `0.0%`)
-- columns. Both new columns are cosmetic and nullable. Forward-only; maps the old enum in place.
ALTER TABLE metric ADD COLUMN unit   TEXT;
ALTER TABLE metric ADD COLUMN format TEXT;

-- Derive unit/format from the old conflated type BEFORE remapping type.
UPDATE metric SET unit = 'ms'    WHERE type = 'DURATION_MS';
UPDATE metric SET unit = 'bytes' WHERE type = 'BYTES';
UPDATE metric SET unit = '%'     WHERE type = 'PERCENT';

-- Narrow type to the numeric kind. COUNT and BYTES are whole numbers; the rest are continuous.
UPDATE metric SET type = 'INTEGER' WHERE type IN ('COUNT', 'BYTES');
UPDATE metric SET type = 'DECIMAL' WHERE type IN ('NUMBER', 'DURATION_MS', 'PERCENT');
