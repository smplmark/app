// Publisher-identity persistence. An identity is an organization "brand" a benchmark can be published
// under; it is publishable while it owns at least one VERIFIED publisher_domain. Deleting an identity
// cascades to its domains (FKs are enforced) but never touches a benchmark that froze its snapshot.
import { ConflictError } from "../errors";
import type { PublisherIdentityRow } from "../types";
import { isUniqueViolation } from "./d1";

export interface CreatePublisherIdentityInput {
  account_id: string;
  key: string;
  name: string;
  logo_url: string | null;
}

export async function createPublisherIdentity(
  db: D1Database,
  input: CreatePublisherIdentityInput,
): Promise<PublisherIdentityRow> {
  const now = Date.now();
  const row: PublisherIdentityRow = {
    id: crypto.randomUUID(),
    account_id: input.account_id,
    key: input.key,
    name: input.name,
    logo_url: input.logo_url,
    created_at: now,
    updated_at: now,
  };
  try {
    await db
      .prepare(
        "INSERT INTO publisher_identity (id, account_id, key, name, logo_url, created_at, updated_at) VALUES (?,?,?,?,?,?,?)",
      )
      .bind(row.id, row.account_id, row.key, row.name, row.logo_url, row.created_at, row.updated_at)
      .run();
  } catch (e) {
    if (isUniqueViolation(e)) {
      throw new ConflictError(
        `A publisher identity with key ${JSON.stringify(input.key)} already exists for this account.`,
      );
    }
    throw e;
  }
  return row;
}

export async function getPublisherIdentityById(
  db: D1Database,
  id: string,
): Promise<PublisherIdentityRow | null> {
  return (
    (await db
      .prepare("SELECT * FROM publisher_identity WHERE id = ?")
      .bind(id)
      .first<PublisherIdentityRow>()) ?? null
  );
}

export async function listPublisherIdentities(
  db: D1Database,
  accountId: string,
  opts: { key?: string } = {},
): Promise<PublisherIdentityRow[]> {
  if (opts.key !== undefined) {
    return (
      await db
        .prepare(
          "SELECT * FROM publisher_identity WHERE account_id = ? AND key = ? ORDER BY created_at, id",
        )
        .bind(accountId, opts.key)
        .all<PublisherIdentityRow>()
    ).results;
  }
  return (
    await db
      .prepare("SELECT * FROM publisher_identity WHERE account_id = ? ORDER BY created_at, id")
      .bind(accountId)
      .all<PublisherIdentityRow>()
  ).results;
}

export interface UpdatePublisherIdentityInput {
  key: string;
  name: string;
  logo_url: string | null;
}

export async function updatePublisherIdentity(
  db: D1Database,
  id: string,
  input: UpdatePublisherIdentityInput,
): Promise<PublisherIdentityRow | null> {
  const existing = await getPublisherIdentityById(db, id);
  if (!existing) return null;
  const updated: PublisherIdentityRow = {
    ...existing,
    key: input.key,
    name: input.name,
    logo_url: input.logo_url,
    updated_at: Date.now(),
  };
  try {
    await db
      .prepare("UPDATE publisher_identity SET key=?, name=?, logo_url=?, updated_at=? WHERE id=?")
      .bind(updated.key, updated.name, updated.logo_url, updated.updated_at, id)
      .run();
  } catch (e) {
    if (isUniqueViolation(e)) {
      throw new ConflictError(
        `A publisher identity with key ${JSON.stringify(input.key)} already exists for this account.`,
      );
    }
    throw e;
  }
  return updated;
}

/**
 * Delete an identity and its domains (children first — FKs are enforced). A benchmark published under
 * this identity is untouched: its badge renders from the frozen attribution_snapshot, and
 * published_identity_id is a soft pointer with no FK.
 */
export async function deletePublisherIdentityCascade(db: D1Database, id: string): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM publisher_domain WHERE publisher_identity_id = ?").bind(id),
    db.prepare("DELETE FROM publisher_identity WHERE id = ?").bind(id),
  ]);
}
