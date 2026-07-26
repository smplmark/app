-- Per-user, per-account preferences (console theme, and future UI prefs),
-- which stores them as an opaque JSON `settings` bag on the account_user membership row rather than a
-- separate table. NULL until the member saves a preference; the client owns the keys and values.
-- (No data needed preserving at this point in the schema's life.)
ALTER TABLE account_user ADD COLUMN settings TEXT;
