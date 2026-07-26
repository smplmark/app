export async function createSession(
  db: D1Database,
  input: { id: string; user_id: string; account_id: string; expires_at: number },
): Promise<void> {
  await db
    .prepare(
      "INSERT INTO session (id, user_id, account_id, created_at, expires_at, revoked_at) VALUES (?,?,?,?,?,NULL)",
    )
    .bind(input.id, input.user_id, input.account_id, Date.now(), input.expires_at)
    .run();
}

/** Logout: drop the session record (best-effort; JWT verification is stateless). */
export async function deleteSession(db: D1Database, id: string): Promise<void> {
  await db.prepare("DELETE FROM session WHERE id = ?").bind(id).run();
}
