// Invitation persistence. The emailed token is stored only as its SHA-256 hash (the plaintext lives
// in the email + the create/resend response). Accepting an invite adds an account_user membership.
import type { InvitableRole, InvitationRow, InvitationStatus } from "../types";

export interface CreateInvitationInput {
  account_id: string;
  email: string;
  role: InvitableRole;
  token_hash: string;
  invited_by_user_id: string | null;
  expires_at: number;
}

export async function createInvitation(
  db: D1Database,
  input: CreateInvitationInput,
): Promise<InvitationRow> {
  const row: InvitationRow = {
    id: crypto.randomUUID(),
    account_id: input.account_id,
    email: input.email,
    role: input.role,
    token_hash: input.token_hash,
    status: "PENDING",
    invited_by_user_id: input.invited_by_user_id,
    expires_at: input.expires_at,
    accepted_at: null,
    created_at: Date.now(),
  };
  await db
    .prepare(
      "INSERT INTO invitation (id, account_id, email, role, token_hash, status, invited_by_user_id, expires_at, accepted_at, created_at) " +
        "VALUES (?,?,?,?,?,?,?,?,?,?)",
    )
    .bind(
      row.id,
      row.account_id,
      row.email,
      row.role,
      row.token_hash,
      row.status,
      row.invited_by_user_id,
      row.expires_at,
      row.accepted_at,
      row.created_at,
    )
    .run();
  return row;
}

export async function getInvitationById(
  db: D1Database,
  id: string,
): Promise<InvitationRow | null> {
  return (
    (await db.prepare("SELECT * FROM invitation WHERE id = ?").bind(id).first<InvitationRow>()) ??
    null
  );
}

export async function getInvitationByTokenHash(
  db: D1Database,
  tokenHash: string,
): Promise<InvitationRow | null> {
  return (
    (await db
      .prepare("SELECT * FROM invitation WHERE token_hash = ?")
      .bind(tokenHash)
      .first<InvitationRow>()) ?? null
  );
}

/** A live (PENDING) invitation for this email in this account, if any (the dedupe guard). */
export async function getPendingInvitationByEmail(
  db: D1Database,
  accountId: string,
  email: string,
): Promise<InvitationRow | null> {
  return (
    (await db
      .prepare(
        "SELECT * FROM invitation WHERE account_id = ? AND email = ? COLLATE NOCASE AND status = 'PENDING'",
      )
      .bind(accountId, email)
      .first<InvitationRow>()) ?? null
  );
}

export async function listInvitationsForAccount(
  db: D1Database,
  accountId: string,
  opts: { status?: InvitationStatus } = {},
): Promise<InvitationRow[]> {
  if (opts.status) {
    return (
      await db
        .prepare(
          "SELECT * FROM invitation WHERE account_id = ? AND status = ? ORDER BY created_at DESC, id",
        )
        .bind(accountId, opts.status)
        .all<InvitationRow>()
    ).results;
  }
  return (
    await db
      .prepare("SELECT * FROM invitation WHERE account_id = ? ORDER BY created_at DESC, id")
      .bind(accountId)
      .all<InvitationRow>()
  ).results;
}

export async function setInvitationStatus(
  db: D1Database,
  id: string,
  status: InvitationStatus,
  acceptedAt: number | null = null,
): Promise<void> {
  await db
    .prepare("UPDATE invitation SET status = ?, accepted_at = ? WHERE id = ?")
    .bind(status, acceptedAt, id)
    .run();
}

/** Resend: mint a fresh token + extend the expiry, keeping the invitation PENDING. */
export async function rotateInvitationToken(
  db: D1Database,
  id: string,
  tokenHash: string,
  expiresAt: number,
): Promise<void> {
  await db
    .prepare("UPDATE invitation SET token_hash = ?, expires_at = ? WHERE id = ?")
    .bind(tokenHash, expiresAt, id)
    .run();
}
