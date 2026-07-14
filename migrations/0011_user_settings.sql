-- Per-user, per-account preferences (console theme, and future UI prefs), mirroring the smplkit app,
-- which stores them as an opaque JSON `settings` bag on the account_user membership row rather than a
-- separate table. NULL until the member saves a preference; the client owns the keys and values.
-- (There is no production data to preserve — smplmark has no customers yet.)
ALTER TABLE account_user ADD COLUMN settings TEXT;
