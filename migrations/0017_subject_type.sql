-- 0017 — subject_type: a formal schema for subjects. A subject type has a kebab `key` (derived from
-- its name, server-side), a display name, and a `fields` list (JSON) describing the typed attributes
-- a subject of this type carries (name, type, required, and — per type — max_length or options).
-- Account-owned, unique per (account_id, key). Subjects gain a subject_type_id in a later migration.
CREATE TABLE subject_type (
  id          TEXT    PRIMARY KEY,
  account_id  TEXT    NOT NULL REFERENCES account (id),
  key         TEXT    NOT NULL,
  name        TEXT    NOT NULL,
  fields      TEXT    NOT NULL DEFAULT '[]',
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE UNIQUE INDEX subject_type_account_key ON subject_type (account_id, key);
CREATE INDEX subject_type_account ON subject_type (account_id);
