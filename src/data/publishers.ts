// Publisher persistence. A publisher IS a domain: publishable once its domain is VERIFIED via a DNS
// TXT record. The verification_token is public (it goes in DNS) so it's stored plaintext. There is no
// name/logo — attribution shows only the verified domain. Deleting a publisher is a plain claim
// removal; a benchmark already published under it keeps its frozen attribution snapshot.
import { ConflictError } from "../errors";
import type { PublisherIconKind, PublisherRow, PublisherStatus } from "../types";
import { isUniqueViolation } from "./d1";

export interface CreatePublisherInput {
  account_id: string;
  domain: string;
  verification_token: string;
}

export async function createPublisher(
  db: D1Database,
  input: CreatePublisherInput,
): Promise<PublisherRow> {
  const row: PublisherRow = {
    id: crypto.randomUUID(),
    account_id: input.account_id,
    domain: input.domain,
    status: "PENDING",
    verification_token: input.verification_token,
    verified_at: null,
    last_checked_at: null,
    icon: "monogram",
    created_at: Date.now(),
  };
  try {
    await db
      .prepare(
        "INSERT INTO publisher (id, account_id, domain, status, verification_token, verified_at, last_checked_at, icon, created_at) VALUES (?,?,?,?,?,NULL,NULL,?,?)",
      )
      .bind(row.id, row.account_id, row.domain, row.status, row.verification_token, row.icon, row.created_at)
      .run();
  } catch (e) {
    if (isUniqueViolation(e)) {
      throw new ConflictError(`The domain ${JSON.stringify(input.domain)} is already a publisher for this account.`);
    }
    throw e;
  }
  return row;
}

export async function getPublisherById(db: D1Database, id: string): Promise<PublisherRow | null> {
  return (
    (await db.prepare("SELECT * FROM publisher WHERE id = ?").bind(id).first<PublisherRow>()) ?? null
  );
}

export async function listPublishers(
  db: D1Database,
  accountId: string,
  opts: { status?: PublisherStatus } = {},
): Promise<PublisherRow[]> {
  if (opts.status !== undefined) {
    return (
      await db
        .prepare("SELECT * FROM publisher WHERE account_id = ? AND status = ? ORDER BY created_at, id")
        .bind(accountId, opts.status)
        .all<PublisherRow>()
    ).results;
  }
  return (
    await db
      .prepare("SELECT * FROM publisher WHERE account_id = ? ORDER BY created_at, id")
      .bind(accountId)
      .all<PublisherRow>()
  ).results;
}

/** Record the outcome of a verification check. */
export async function setPublisherStatus(
  db: D1Database,
  id: string,
  input: { status: PublisherStatus; verified_at: number | null; last_checked_at: number },
): Promise<PublisherRow | null> {
  await db
    .prepare("UPDATE publisher SET status=?, verified_at=?, last_checked_at=? WHERE id=?")
    .bind(input.status, input.verified_at, input.last_checked_at, id)
    .run();
  return getPublisherById(db, id);
}

/** Update the displayed-icon preference (monogram | favicon). */
export async function updatePublisherIcon(
  db: D1Database,
  id: string,
  icon: PublisherIconKind,
): Promise<PublisherRow | null> {
  await db.prepare("UPDATE publisher SET icon=? WHERE id=?").bind(icon, id).run();
  return getPublisherById(db, id);
}

export async function deletePublisher(db: D1Database, id: string): Promise<void> {
  await db.prepare("DELETE FROM publisher WHERE id = ?").bind(id).run();
}

/** A bounded page of VERIFIED publishers, oldest first, for the periodic re-check sweep. */
export async function listVerifiedPublishersPage(
  db: D1Database,
  limit: number,
  offset: number,
): Promise<PublisherRow[]> {
  return (
    await db
      .prepare("SELECT * FROM publisher WHERE status = 'VERIFIED' ORDER BY created_at, id LIMIT ? OFFSET ?")
      .bind(limit, offset)
      .all<PublisherRow>()
  ).results;
}
