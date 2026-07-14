-- 0013 — account soft-delete. Mark an account deleted (deleted_at) rather than removing the row, so
-- deletion is reversible and auditable. The key unique index becomes partial (live accounts only) so a
-- deleted account frees its key for reuse. Access is blocked at auth, so child data needs no cascade.
-- No data to preserve.
ALTER TABLE account ADD COLUMN deleted_at INTEGER;
DROP INDEX account_key;
CREATE UNIQUE INDEX account_key ON account (key) WHERE deleted_at IS NULL;
