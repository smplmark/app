// Publisher-domain persistence. A domain is a TXT-verification claim under an identity. The
// verification_token is public (it goes in DNS), so it is stored plaintext. An identity is publishable
// while it owns at least one VERIFIED domain. Deleting a domain is a plain claim removal.
import { ConflictError } from "../errors";
import type { PublisherDomainRow, PublisherDomainStatus } from "../types";
import { isUniqueViolation } from "./d1";

export interface CreatePublisherDomainInput {
  account_id: string;
  publisher_identity_id: string;
  domain: string;
  verification_token: string;
}

export async function createPublisherDomain(
  db: D1Database,
  input: CreatePublisherDomainInput,
): Promise<PublisherDomainRow> {
  const row: PublisherDomainRow = {
    id: crypto.randomUUID(),
    account_id: input.account_id,
    publisher_identity_id: input.publisher_identity_id,
    domain: input.domain,
    verification_token: input.verification_token,
    status: "PENDING",
    verified_at: null,
    last_checked_at: null,
    created_at: Date.now(),
  };
  try {
    await db
      .prepare(
        "INSERT INTO publisher_domain (id, account_id, publisher_identity_id, domain, verification_token, status, verified_at, last_checked_at, created_at) VALUES (?,?,?,?,?,?,NULL,NULL,?)",
      )
      .bind(
        row.id,
        row.account_id,
        row.publisher_identity_id,
        row.domain,
        row.verification_token,
        row.status,
        row.created_at,
      )
      .run();
  } catch (e) {
    if (isUniqueViolation(e)) {
      throw new ConflictError(
        `The domain ${JSON.stringify(input.domain)} is already claimed by this identity.`,
      );
    }
    throw e;
  }
  return row;
}

export async function getPublisherDomainById(
  db: D1Database,
  id: string,
): Promise<PublisherDomainRow | null> {
  return (
    (await db
      .prepare("SELECT * FROM publisher_domain WHERE id = ?")
      .bind(id)
      .first<PublisherDomainRow>()) ?? null
  );
}

export async function listPublisherDomains(
  db: D1Database,
  accountId: string,
  opts: { publisherIdentityId?: string; status?: PublisherDomainStatus } = {},
): Promise<PublisherDomainRow[]> {
  const clauses = ["account_id = ?"];
  const binds: unknown[] = [accountId];
  if (opts.publisherIdentityId !== undefined) {
    clauses.push("publisher_identity_id = ?");
    binds.push(opts.publisherIdentityId);
  }
  if (opts.status !== undefined) {
    clauses.push("status = ?");
    binds.push(opts.status);
  }
  return (
    await db
      .prepare(
        `SELECT * FROM publisher_domain WHERE ${clauses.join(" AND ")} ORDER BY created_at, id`,
      )
      .bind(...binds)
      .all<PublisherDomainRow>()
  ).results;
}

/** The VERIFIED domains under an identity, in claim order (used to freeze the org publish snapshot). */
export async function listVerifiedDomains(
  db: D1Database,
  publisherIdentityId: string,
): Promise<PublisherDomainRow[]> {
  return (
    await db
      .prepare(
        "SELECT * FROM publisher_domain WHERE publisher_identity_id = ? AND status = 'VERIFIED' ORDER BY created_at, id",
      )
      .bind(publisherIdentityId)
      .all<PublisherDomainRow>()
  ).results;
}

/** Record the outcome of a verification check. */
export async function setPublisherDomainStatus(
  db: D1Database,
  id: string,
  input: {
    status: PublisherDomainStatus;
    verified_at: number | null;
    last_checked_at: number;
  },
): Promise<PublisherDomainRow | null> {
  await db
    .prepare(
      "UPDATE publisher_domain SET status=?, verified_at=?, last_checked_at=? WHERE id=?",
    )
    .bind(input.status, input.verified_at, input.last_checked_at, id)
    .run();
  return getPublisherDomainById(db, id);
}

export async function deletePublisherDomain(db: D1Database, id: string): Promise<void> {
  await db.prepare("DELETE FROM publisher_domain WHERE id = ?").bind(id).run();
}

/** A bounded page of VERIFIED domains, oldest first, for the periodic re-check sweep. */
export async function listVerifiedDomainsPage(
  db: D1Database,
  limit: number,
  offset: number,
): Promise<PublisherDomainRow[]> {
  return (
    await db
      .prepare(
        "SELECT * FROM publisher_domain WHERE status = 'VERIFIED' ORDER BY created_at, id LIMIT ? OFFSET ?",
      )
      .bind(limit, offset)
      .all<PublisherDomainRow>()
  ).results;
}
