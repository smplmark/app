-- 0014 — publisher = domain. A publisher is literally a verified domain — no free-text name/logo, so a
-- user can't verify a throwaway domain and then impersonate "Microsoft" with any name+logo they like.
-- Replace publisher_identity (1) + publisher_domain (N) with a single `publisher` table that IS a
-- domain. Frozen ORG attribution snapshots on already-published benchmarks are not migrated (disposable
-- data, no customers). Drop the child table first (FK order).
DROP TABLE publisher_domain;
DROP TABLE publisher_identity;

CREATE TABLE publisher (
  id                 TEXT    PRIMARY KEY,
  account_id         TEXT    NOT NULL REFERENCES account (id),
  domain             TEXT    NOT NULL,
  status             TEXT    NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'VERIFIED', 'LAPSED')),
  -- The TXT record value the owner adds to DNS to prove control. Public (it goes in DNS) → plaintext.
  verification_token TEXT    NOT NULL,
  verified_at        INTEGER,
  last_checked_at    INTEGER,
  -- Displayed icon for this publisher: a domain-initial monogram, or the domain's own favicon.
  icon               TEXT    NOT NULL DEFAULT 'monogram' CHECK (icon IN ('monogram', 'favicon')),
  created_at         INTEGER NOT NULL
);
-- One publisher per (account, domain).
CREATE UNIQUE INDEX publisher_account_domain ON publisher (account_id, domain);
CREATE INDEX publisher_account ON publisher (account_id);
CREATE INDEX publisher_status ON publisher (status); -- the periodic re-check sweep
