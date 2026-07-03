-- smplmark schema — clean-slate squash (there is no production data yet).
--
-- APPEND-ONLY LINE: this squash is a one-time reset. The moment the first real account exists in
-- production, this file is frozen and every subsequent schema change becomes a new, forward-only
-- migration (0002_*, 0003_*, …) — never edit 0001 again. See README "Schema".
--
-- Conventions (D1/SQLite): types are TEXT / INTEGER / REAL only. Timestamps are INTEGER epoch-ms
-- UTC (emitted ISO-8601 on the wire). UUIDs and enums are TEXT. JSON bags are TEXT. FOREIGN KEY
-- clauses document intent — D1 does not enforce them, so the app layer validates every parent link
-- and all tenant ownership. Enum wire values are SCREAMING_SNAKE_CASE (ADR-014).
--
-- Hierarchy: account (1)->(N) benchmark (1)->(N) target (1)->(N) run (1)->(N) observation.

-- ── Identity & tenancy ──────────────────────────────────────────────────────

CREATE TABLE user (
  id             TEXT    PRIMARY KEY,
  email          TEXT    NOT NULL,
  -- Boolean stored as INTEGER (0/1). Surfaced as `verified` (no is_ prefix).
  email_verified INTEGER NOT NULL DEFAULT 0,
  display_name   TEXT,
  created_at     INTEGER NOT NULL
);
-- Case-insensitive uniqueness (citext-style). NOCASE folds ASCII, which covers email local/domain.
CREATE UNIQUE INDEX user_email ON user (email COLLATE NOCASE);

CREATE TABLE user_identity (
  id               TEXT    PRIMARY KEY,
  user_id          TEXT    NOT NULL REFERENCES user (id),
  provider         TEXT    NOT NULL CHECK (provider IN ('GOOGLE', 'MICROSOFT', 'PASSWORD')),
  -- OIDC subject (`sub`) for GOOGLE/MICROSOFT; NULL for PASSWORD.
  provider_subject TEXT,
  -- PBKDF2 (WebCrypto) hash for PASSWORD; NULL otherwise. Never surfaced.
  password_hash    TEXT,
  created_at       INTEGER NOT NULL
);
-- One identity per (provider, subject) for OIDC. Partial so many PASSWORD rows (NULL subject) don't collide.
CREATE UNIQUE INDEX user_identity_provider_subject
  ON user_identity (provider, provider_subject) WHERE provider_subject IS NOT NULL;
-- At most one PASSWORD identity per user.
CREATE UNIQUE INDEX user_identity_password
  ON user_identity (user_id) WHERE provider = 'PASSWORD';
CREATE INDEX user_identity_user ON user_identity (user_id);

CREATE TABLE account (
  id          TEXT    PRIMARY KEY,
  key         TEXT    NOT NULL,
  name        TEXT    NOT NULL,
  -- Publisher blurb / homepage — surfaced on the public Publisher tab.
  description TEXT,
  url         TEXT,
  created_at  INTEGER NOT NULL
);
CREATE UNIQUE INDEX account_key ON account (key);

-- Join carrying the caller's role in an account. v1 has only OWNER; the CHECK leaves room to grow.
CREATE TABLE account_user (
  account_id TEXT    NOT NULL REFERENCES account (id),
  user_id    TEXT    NOT NULL REFERENCES user (id),
  role       TEXT    NOT NULL DEFAULT 'OWNER' CHECK (role IN ('OWNER')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, user_id)
);
CREATE INDEX account_user_user ON account_user (user_id);

-- Email-verification tokens. Single-use (consumed_at), time-boxed (expires_at). A failed send never
-- wedges signup — the account exists and a fresh token can be re-requested.
CREATE TABLE email_verification (
  id          TEXT    PRIMARY KEY,
  user_id     TEXT    NOT NULL REFERENCES user (id),
  -- SHA-256 hash of the emailed token (the plaintext is never stored).
  token_hash  TEXT    NOT NULL,
  expires_at  INTEGER NOT NULL,
  consumed_at INTEGER,
  created_at  INTEGER NOT NULL
);
CREATE UNIQUE INDEX email_verification_token ON email_verification (token_hash);
CREATE INDEX email_verification_user ON email_verification (user_id);

-- Web-login sessions. JWT session tokens are the credential; the row is an audit/revocation record
-- (jti == id). Hot-path verification is stateless (signature + exp + iss); logout deletes the row.
CREATE TABLE session (
  id         TEXT    PRIMARY KEY,
  user_id    TEXT    NOT NULL REFERENCES user (id),
  account_id TEXT    NOT NULL REFERENCES account (id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX session_user ON session (user_id);

-- ── API keys ────────────────────────────────────────────────────────────────

-- Dual-column storage: key_hash (irreversible, indexed — the only thing the hot path reads) and
-- key_encrypted (AES-GCM under a Worker secret — decrypted only for the reveal endpoint).
CREATE TABLE api_key (
  id                 TEXT    PRIMARY KEY,
  account_id         TEXT    NOT NULL REFERENCES account (id),
  name               TEXT    NOT NULL,
  scope_type         TEXT    NOT NULL CHECK (scope_type IN ('ACCOUNT', 'BENCHMARK', 'RUN')),
  -- id of the scoped benchmark/run; NULL when scope_type = ACCOUNT.
  scope_ref          TEXT,
  key_hash           TEXT    NOT NULL,
  key_encrypted      TEXT    NOT NULL,
  -- 'sm_api_' + a few plaintext chars, for masked display.
  prefix             TEXT    NOT NULL,
  expires_at         INTEGER,
  created_by_user_id TEXT    REFERENCES user (id),
  revoked_at         INTEGER,
  last_used_at       INTEGER,
  created_at         INTEGER NOT NULL
);
CREATE UNIQUE INDEX api_key_hash ON api_key (key_hash);
CREATE INDEX api_key_account ON api_key (account_id);

-- ── Benchmark hierarchy ─────────────────────────────────────────────────────

CREATE TABLE benchmark (
  id                TEXT    PRIMARY KEY,
  account_id        TEXT    NOT NULL REFERENCES account (id),
  key               TEXT    NOT NULL,
  name              TEXT    NOT NULL,
  -- Short tagline. `about` is the long overview; `methodology` the how-it's-produced writeup.
  description       TEXT,
  about             TEXT,
  methodology       TEXT,
  status            TEXT    NOT NULL DEFAULT 'PRIVATE'
                           CHECK (status IN ('PRIVATE', 'PUBLISHED', 'WITHDRAWN')),
  published_at      INTEGER,
  withdrawn_at      INTEGER,
  withdrawal_reason TEXT,
  -- JSON: the metric + derived + chart declaration. Semantic core freezes on publish.
  sample_schema     TEXT    NOT NULL,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);
CREATE UNIQUE INDEX benchmark_account_key ON benchmark (account_id, key);
CREATE INDEX benchmark_account ON benchmark (account_id);
CREATE INDEX benchmark_status ON benchmark (status);

CREATE TABLE target (
  id           TEXT    PRIMARY KEY,
  benchmark_id TEXT    NOT NULL REFERENCES benchmark (id),
  key          TEXT    NOT NULL,
  name         TEXT    NOT NULL,
  details      TEXT,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE UNIQUE INDEX target_benchmark_key ON target (benchmark_id, key);
CREATE INDEX target_benchmark ON target (benchmark_id);

CREATE TABLE run (
  id                    TEXT    PRIMARY KEY,
  target_id             TEXT    NOT NULL REFERENCES target (id),
  key                   TEXT    NOT NULL,
  name                  TEXT,
  details               TEXT,
  -- Origin for relative-time derived metrics (elapsed_ms). Nullable.
  started_at            INTEGER,
  -- NULL ⇒ live (still recording). actions/end stamps it. Surfaced as `live` (no is_ prefix).
  ended_at              INTEGER,
  -- Run-level invalidation is annotation, never removal. Surfaced as `invalidated`.
  invalidated_at        INTEGER,
  invalidation_reason   TEXT,
  invalidated_by_user_id TEXT   REFERENCES user (id),
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL
);
CREATE UNIQUE INDEX run_target_key ON run (target_id, key);
CREATE INDEX run_target ON run (target_id);

CREATE TABLE observation (
  -- INTEGER PRIMARY KEY is a rowid alias: DB-assigned, returned as last_row_id. Stringified on wire.
  id         INTEGER PRIMARY KEY,
  run_id     TEXT    NOT NULL REFERENCES run (id),
  -- epoch-ms; server-stamps on ingest if absent (client may supply for historical bulk upload).
  created_at INTEGER NOT NULL,
  metrics    TEXT,
  meta       TEXT,
  -- From CF-Connecting-IP. Write-only: captured on ingest, never surfaced.
  client_ip  TEXT
);
-- Load-bearing: serves the chart/range query and keeps run-scoped range reads off a full scan.
CREATE INDEX observation_run_created ON observation (run_id, created_at);
