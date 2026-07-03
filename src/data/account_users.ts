import type { AccountUserRow, Role } from "../types";

/** A member row joined with the user's identity fields (for the members table). */
export interface AccountMemberRow extends AccountUserRow {
  email: string;
  display_name: string | null;
  email_verified: number;
}

/** An account the caller belongs to, with their role in it (for the account switcher). */
export interface AccountMembershipRow {
  account_id: string;
  account_key: string;
  account_name: string;
  role: Role;
  created_at: number;
}

export async function createMembership(
  db: D1Database,
  input: { account_id: string; user_id: string; role: Role },
): Promise<AccountUserRow> {
  const row: AccountUserRow = {
    account_id: input.account_id,
    user_id: input.user_id,
    role: input.role,
    created_at: Date.now(),
  };
  await db
    .prepare(
      "INSERT INTO account_user (account_id, user_id, role, created_at) VALUES (?,?,?,?)",
    )
    .bind(row.account_id, row.user_id, row.role, row.created_at)
    .run();
  return row;
}

export async function listMembershipsForAccount(
  db: D1Database,
  accountId: string,
): Promise<AccountUserRow[]> {
  return (
    await db
      .prepare(
        "SELECT * FROM account_user WHERE account_id = ? ORDER BY created_at, user_id",
      )
      .bind(accountId)
      .all<AccountUserRow>()
  ).results;
}

/** The caller's primary (oldest) account, used to pick the session account on login. */
export async function getPrimaryMembershipForUser(
  db: D1Database,
  userId: string,
): Promise<AccountUserRow | null> {
  return (
    (await db
      .prepare(
        "SELECT account_user.* FROM account_user JOIN account ON account.id = account_user.account_id WHERE account_user.user_id = ? ORDER BY account.created_at, account.id LIMIT 1",
      )
      .bind(userId)
      .first<AccountUserRow>()) ?? null
  );
}

/** A single membership (account + user), or null. */
export async function getMembership(
  db: D1Database,
  accountId: string,
  userId: string,
): Promise<AccountUserRow | null> {
  return (
    (await db
      .prepare("SELECT * FROM account_user WHERE account_id = ? AND user_id = ?")
      .bind(accountId, userId)
      .first<AccountUserRow>()) ?? null
  );
}

/** Members of an account, joined with each member's identity (for the members table). */
export async function listAccountMembers(
  db: D1Database,
  accountId: string,
): Promise<AccountMemberRow[]> {
  return (
    await db
      .prepare(
        "SELECT account_user.*, user.email AS email, user.display_name AS display_name, user.email_verified AS email_verified " +
          "FROM account_user JOIN user ON user.id = account_user.user_id " +
          "WHERE account_user.account_id = ? ORDER BY account_user.created_at, account_user.user_id",
      )
      .bind(accountId)
      .all<AccountMemberRow>()
  ).results;
}

/** The accounts a user belongs to, with their role in each (oldest first). */
export async function listMembershipsForUserWithAccount(
  db: D1Database,
  userId: string,
): Promise<AccountMembershipRow[]> {
  return (
    await db
      .prepare(
        "SELECT account.id AS account_id, account.key AS account_key, account.name AS account_name, " +
          "account_user.role AS role, account_user.created_at AS created_at " +
          "FROM account_user JOIN account ON account.id = account_user.account_id " +
          "WHERE account_user.user_id = ? ORDER BY account.created_at, account.id",
      )
      .bind(userId)
      .all<AccountMembershipRow>()
  ).results;
}

export async function updateMembershipRole(
  db: D1Database,
  accountId: string,
  userId: string,
  role: Role,
): Promise<void> {
  await db
    .prepare("UPDATE account_user SET role = ? WHERE account_id = ? AND user_id = ?")
    .bind(role, accountId, userId)
    .run();
}

export async function deleteMembership(
  db: D1Database,
  accountId: string,
  userId: string,
): Promise<void> {
  await db
    .prepare("DELETE FROM account_user WHERE account_id = ? AND user_id = ?")
    .bind(accountId, userId)
    .run();
}
