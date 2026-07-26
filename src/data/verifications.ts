import type { EmailVerificationRow } from "../types";

export async function createVerification(
  db: D1Database,
  input: { user_id: string; token_hash: string; expires_at: number },
): Promise<EmailVerificationRow> {
  const row: EmailVerificationRow = {
    id: crypto.randomUUID(),
    user_id: input.user_id,
    token_hash: input.token_hash,
    expires_at: input.expires_at,
    consumed_at: null,
    created_at: Date.now(),
  };
  await db
    .prepare(
      "INSERT INTO email_verification (id, user_id, token_hash, expires_at, consumed_at, created_at) VALUES (?,?,?,?,NULL,?)",
    )
    .bind(row.id, row.user_id, row.token_hash, row.expires_at, row.created_at)
    .run();
  return row;
}

/**
 * Consume a verification token: find an unconsumed, unexpired row by hash and mark it consumed.
 * Returns the owning user_id, or null if not found / expired / already consumed.
 */
export async function consumeVerification(
  db: D1Database,
  tokenHash: string,
  now: number,
): Promise<string | null> {
  const row = await db
    .prepare(
      "SELECT * FROM email_verification WHERE token_hash = ? AND consumed_at IS NULL AND expires_at > ?",
    )
    .bind(tokenHash, now)
    .first<EmailVerificationRow>();
  if (!row) return null;
  await db
    .prepare("UPDATE email_verification SET consumed_at = ? WHERE id = ?")
    .bind(now, row.id)
    .run();
  return row.user_id;
}
