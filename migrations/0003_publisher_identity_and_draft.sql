-- 0003 — publisher identity, domain verification, and the draft/publish workflow.
--
-- Forward-only (0001 + 0002 are frozen). Adds:
--   • publisher_identity   — organization "brands" a benchmark can be published under.
--   • publisher_domain     — TXT-verified domains owned by an identity (1:many).
--   • account.allow_personal_publish — gates the direct personal self-publish shortcut.
--   • benchmark.{created_by_user_id, draft, published_by_user_id, published_as_kind,
--       published_identity_id, attribution_snapshot} — authorship, the draft/ready lock, and the
--       frozen-at-publish attribution snapshot.
--
-- Three separate concepts, never collapsed: a user is *real* (verified email), a domain is *verified*
-- (TXT proof), a benchmark is *attributed* at publish (personal → the author; organization → a brand).
-- The public record is frozen: attribution_snapshot is written once at publish and never rewritten,
-- so a later domain lapse or identity deletion never strips a benchmark's historical badge.

-- ── Publisher identities (organization brands) ───────────────────────────────
-- Personal attribution needs no row here — it is just the author user. This table is org identities.
CREATE TABLE publisher_identity (
  id         TEXT    PRIMARY KEY,
  account_id TEXT    NOT NULL REFERENCES account (id),
  key        TEXT    NOT NULL,             -- human handle, unique within the account
  name       TEXT    NOT NULL,             -- display brand name, e.g. "Microsoft"
  logo_url   TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX publisher_identity_account_key ON publisher_identity (account_id, key);
CREATE INDEX publisher_identity_account ON publisher_identity (account_id);

-- ── Publisher domains (TXT-verified, 1:many under an identity) ────────────────
-- An identity is publishable while it has >=1 domain in VERIFIED state. The verification_token is a
-- PUBLIC challenge the user adds to their DNS as a TXT record — it is not a secret, so it is stored in
-- plaintext and surfaced (unlike API keys / invite tokens, which are hashed). There is deliberately NO
-- global uniqueness on `domain`: two legitimate accounts (e.g. two teams at one company) may both
-- verify the same domain.
CREATE TABLE publisher_domain (
  id                    TEXT    PRIMARY KEY,
  account_id            TEXT    NOT NULL REFERENCES account (id),
  publisher_identity_id TEXT    NOT NULL REFERENCES publisher_identity (id),
  domain                TEXT    NOT NULL,  -- registrable domain, matched exactly (no subdomain inference)
  verification_token    TEXT    NOT NULL,  -- "smplmark-verify=<random>" — added to DNS as a TXT record
  status                TEXT    NOT NULL DEFAULT 'PENDING'
                          CHECK (status IN ('PENDING', 'VERIFIED', 'LAPSED')),
  verified_at           INTEGER,
  last_checked_at       INTEGER,
  created_at            INTEGER NOT NULL
);
CREATE UNIQUE INDEX publisher_domain_identity_domain ON publisher_domain (publisher_identity_id, domain);
CREATE INDEX publisher_domain_account ON publisher_domain (account_id);
CREATE INDEX publisher_domain_status ON publisher_domain (status); -- the periodic re-check sweep

-- ── account: the personal-publish opt-in ─────────────────────────────────────
-- Off by default: a fresh account routes publishing through an admin until an admin opts in. This
-- gates only the direct personal self-publish shortcut; it never enables org attribution.
ALTER TABLE account ADD COLUMN allow_personal_publish INTEGER NOT NULL DEFAULT 0;

-- ── benchmark: authorship, the draft/ready lock, and frozen attribution ──────
-- created_by_user_id is NULL when an API key created the benchmark. draft=1 means "still cooking"
-- (fully editable); draft=0 means "marked ready" (subtree locked, awaiting publish). A benchmark
-- cannot be published while draft=1.
ALTER TABLE benchmark ADD COLUMN created_by_user_id   TEXT REFERENCES user (id);
ALTER TABLE benchmark ADD COLUMN draft                INTEGER NOT NULL DEFAULT 1;
ALTER TABLE benchmark ADD COLUMN published_by_user_id TEXT REFERENCES user (id);
ALTER TABLE benchmark ADD COLUMN published_as_kind    TEXT
                        CHECK (published_as_kind IN ('PERSONAL', 'ORGANIZATION'));
-- published_identity_id is a SOFT pointer (deliberately NO foreign key): an org identity may be
-- deleted while a benchmark published under it still exists. The rendered badge comes from the frozen
-- attribution_snapshot, not a live lookup, so deletion only affects future publishes.
ALTER TABLE benchmark ADD COLUMN published_identity_id TEXT;
-- JSON, written once at publish, never rewritten:
--   ORGANIZATION → { "name", "logo_url", "verified_domains": [...] }
--   PERSONAL     → { "display_name", "email_sha256" }
ALTER TABLE benchmark ADD COLUMN attribution_snapshot TEXT;
