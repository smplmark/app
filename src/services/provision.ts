// Provision a fresh account + OWNER membership for a new user (password signup or OIDC first login).
// Mirrors smplkit: a user with no membership never dead-ends — they get their own account.
import { createAccount, getAccountByKey } from "../data/accounts";
import { createMembership } from "../data/account_users";
import { randomToken } from "../auth/crypto";
import type { AccountRow, UserRow } from "../types";

/** Slugify a name/email into a candidate account key. */
export function slugifyKey(input: string): string {
  const base = input
    .toLowerCase()
    .replace(/@.*$/, "") // drop email domain
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return base.length > 0 ? base : "account";
}

/** Find an unused account key derived from `seed`, adding a short suffix on collision. */
async function uniqueAccountKey(db: D1Database, seed: string): Promise<string> {
  const base = slugifyKey(seed);
  if (!(await getAccountByKey(db, base))) return base;
  for (let i = 0; i < 5; i++) {
    const candidate = `${base}-${randomToken(3).toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 4)}`;
    if (candidate !== base && !(await getAccountByKey(db, candidate))) return candidate;
  }
  return `${base}-${crypto.randomUUID().slice(0, 8)}`;
}

/** Create an account named for the user and make them its OWNER. */
export async function provisionAccountForUser(
  db: D1Database,
  user: UserRow,
): Promise<AccountRow> {
  const displayName = user.display_name && user.display_name.length > 0 ? user.display_name : user.email;
  const key = await uniqueAccountKey(db, displayName);
  const account = await createAccount(db, {
    key,
    name: `${displayName}'s workspace`,
    description: null,
    url: null,
  });
  await createMembership(db, {
    account_id: account.id,
    user_id: user.id,
    role: "OWNER",
  });
  return account;
}
