-- 0002 — account management: multi-role memberships + invitations.
--
-- Forward-only (0001 is frozen). Widens account_user.role from the single-value 'OWNER' CHECK to the
-- four smplkit roles (VIEWER < MEMBER < ADMIN < OWNER) and adds the invitation table. SQLite can't
-- ALTER a CHECK constraint, so account_user is rebuilt (12-step table copy). Existing memberships
-- (all 'OWNER') carry over unchanged. See src/authz/index.ts for the role predicates.

-- ── Rebuild account_user with the widened role CHECK ─────────────────────────
ALTER TABLE account_user RENAME TO account_user_old;

CREATE TABLE account_user (
  account_id TEXT    NOT NULL REFERENCES account (id),
  user_id    TEXT    NOT NULL REFERENCES user (id),
  -- VIEWER (read) < MEMBER (write resources) < ADMIN (manage users/keys/settings) < OWNER (delete account).
  role       TEXT    NOT NULL DEFAULT 'MEMBER' CHECK (role IN ('OWNER', 'ADMIN', 'MEMBER', 'VIEWER')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, user_id)
);
INSERT INTO account_user (account_id, user_id, role, created_at)
  SELECT account_id, user_id, role, created_at FROM account_user_old;
DROP TABLE account_user_old;
CREATE INDEX account_user_user ON account_user (user_id);

-- ── Invitations ──────────────────────────────────────────────────────────────
-- An admin invites an email at a role. The emailed link carries a single-use token; only its SHA-256
-- hash is stored (plaintext lives only in the email + the create/resend response). Accepting adds an
-- account_user membership. OWNER is never invitable — an account has exactly one owner (its creator).
CREATE TABLE invitation (
  id                 TEXT    PRIMARY KEY,
  account_id         TEXT    NOT NULL REFERENCES account (id),
  email              TEXT    NOT NULL,
  role               TEXT    NOT NULL CHECK (role IN ('ADMIN', 'MEMBER', 'VIEWER')),
  -- SHA-256 of the emailed token (the plaintext is never stored). Rotated on resend.
  token_hash         TEXT    NOT NULL,
  status             TEXT    NOT NULL DEFAULT 'PENDING'
                            CHECK (status IN ('PENDING', 'ACCEPTED', 'REVOKED', 'EXPIRED')),
  invited_by_user_id TEXT    REFERENCES user (id),
  expires_at         INTEGER NOT NULL,
  accepted_at        INTEGER,
  created_at         INTEGER NOT NULL
);
CREATE UNIQUE INDEX invitation_token ON invitation (token_hash);
CREATE INDEX invitation_account ON invitation (account_id);
-- Case-insensitive email lookup for the "one pending invite per email+account" guard.
CREATE INDEX invitation_email ON invitation (account_id, email COLLATE NOCASE);
