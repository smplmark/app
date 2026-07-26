import type { Provider, UserIdentityRow } from "../types";

export interface CreateIdentityInput {
  user_id: string;
  provider: Provider;
  provider_subject: string | null;
  password_hash: string | null;
}

export async function createIdentity(
  db: D1Database,
  input: CreateIdentityInput,
): Promise<UserIdentityRow> {
  const row: UserIdentityRow = {
    id: crypto.randomUUID(),
    user_id: input.user_id,
    provider: input.provider,
    provider_subject: input.provider_subject,
    password_hash: input.password_hash,
    created_at: Date.now(),
  };
  await db
    .prepare(
      "INSERT INTO user_identity (id, user_id, provider, provider_subject, password_hash, created_at) VALUES (?,?,?,?,?,?)",
    )
    .bind(
      row.id,
      row.user_id,
      row.provider,
      row.provider_subject,
      row.password_hash,
      row.created_at,
    )
    .run();
  return row;
}

/** OIDC lookup: the identity for a (provider, subject) pair, or null. */
export async function getIdentityByProviderSubject(
  db: D1Database,
  provider: Provider,
  subject: string,
): Promise<UserIdentityRow | null> {
  return (
    (await db
      .prepare(
        "SELECT * FROM user_identity WHERE provider = ? AND provider_subject = ?",
      )
      .bind(provider, subject)
      .first<UserIdentityRow>()) ?? null
  );
}

/** The (single) PASSWORD identity for a user, or null. */
export async function getPasswordIdentity(
  db: D1Database,
  userId: string,
): Promise<UserIdentityRow | null> {
  return (
    (await db
      .prepare(
        "SELECT * FROM user_identity WHERE user_id = ? AND provider = 'PASSWORD'",
      )
      .bind(userId)
      .first<UserIdentityRow>()) ?? null
  );
}
