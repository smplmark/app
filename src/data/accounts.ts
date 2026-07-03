import { ConflictError } from "../errors";
import type { AccountRow } from "../types";
import { isUniqueViolation } from "./d1";

export interface CreateAccountInput {
  key: string;
  name: string;
  description?: string | null;
  url?: string | null;
}

export async function createAccount(
  db: D1Database,
  input: CreateAccountInput,
): Promise<AccountRow> {
  const row: AccountRow = {
    id: crypto.randomUUID(),
    key: input.key,
    name: input.name,
    description: input.description ?? null,
    url: input.url ?? null,
    allow_personal_publish: 0,
    created_at: Date.now(),
  };
  try {
    await db
      .prepare(
        "INSERT INTO account (id, key, name, description, url, allow_personal_publish, created_at) VALUES (?,?,?,?,?,?,?)",
      )
      .bind(
        row.id,
        row.key,
        row.name,
        row.description,
        row.url,
        row.allow_personal_publish,
        row.created_at,
      )
      .run();
  } catch (e) {
    if (isUniqueViolation(e)) {
      throw new ConflictError(
        `An account with key ${JSON.stringify(input.key)} already exists.`,
      );
    }
    throw e;
  }
  return row;
}

export async function getAccountById(
  db: D1Database,
  id: string,
): Promise<AccountRow | null> {
  return (
    (await db.prepare("SELECT * FROM account WHERE id = ?").bind(id).first<AccountRow>()) ??
    null
  );
}

export async function getAccountByKey(
  db: D1Database,
  key: string,
): Promise<AccountRow | null> {
  return (
    (await db.prepare("SELECT * FROM account WHERE key = ?").bind(key).first<AccountRow>()) ??
    null
  );
}

/** Public publisher lookup: only accounts publishing at least one world-visible benchmark. */
export async function getPublicAccountById(
  db: D1Database,
  id: string,
): Promise<AccountRow | null> {
  return (
    (await db
      .prepare(
        "SELECT * FROM account WHERE id = ? AND EXISTS (SELECT 1 FROM benchmark WHERE benchmark.account_id = account.id AND benchmark.status IN ('PUBLISHED', 'WITHDRAWN'))",
      )
      .bind(id)
      .first<AccountRow>()) ?? null
  );
}

export interface UpdateAccountInput {
  name: string;
  description: string | null;
  url: string | null;
  /** 0/1. The personal-publish opt-in (admins only, via account settings). */
  allow_personal_publish: number;
}

export async function updateAccount(
  db: D1Database,
  id: string,
  input: UpdateAccountInput,
): Promise<AccountRow | null> {
  const existing = await getAccountById(db, id);
  if (!existing) return null;
  const updated: AccountRow = {
    ...existing,
    name: input.name,
    description: input.description,
    url: input.url,
    allow_personal_publish: input.allow_personal_publish,
  };
  await db
    .prepare(
      "UPDATE account SET name=?, description=?, url=?, allow_personal_publish=? WHERE id=?",
    )
    .bind(
      updated.name,
      updated.description,
      updated.url,
      updated.allow_personal_publish,
      id,
    )
    .run();
  return updated;
}

/** Publish gate (§5): does the account have at least one verified user? */
export async function accountHasVerifiedUser(
  db: D1Database,
  accountId: string,
): Promise<boolean> {
  const row = await db
    .prepare(
      "SELECT 1 AS ok FROM account_user JOIN user ON user.id = account_user.user_id WHERE account_user.account_id = ? AND user.email_verified = 1 LIMIT 1",
    )
    .bind(accountId)
    .first<{ ok: number }>();
  return row !== null;
}
