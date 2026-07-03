import { ConflictError } from "../errors";
import type { UserRow } from "../types";
import { isUniqueViolation } from "./d1";

export interface CreateUserInput {
  email: string;
  display_name: string | null;
  email_verified: boolean;
}

export async function createUser(
  db: D1Database,
  input: CreateUserInput,
): Promise<UserRow> {
  const now = Date.now();
  const row: UserRow = {
    id: crypto.randomUUID(),
    email: input.email,
    email_verified: input.email_verified ? 1 : 0,
    display_name: input.display_name,
    created_at: now,
  };
  try {
    await db
      .prepare(
        "INSERT INTO user (id, email, email_verified, display_name, created_at) VALUES (?,?,?,?,?)",
      )
      .bind(row.id, row.email, row.email_verified, row.display_name, row.created_at)
      .run();
  } catch (e) {
    if (isUniqueViolation(e)) {
      throw new ConflictError("An account with this email already exists.");
    }
    throw e;
  }
  return row;
}

export async function getUserById(
  db: D1Database,
  id: string,
): Promise<UserRow | null> {
  return (
    (await db.prepare("SELECT * FROM user WHERE id = ?").bind(id).first<UserRow>()) ??
    null
  );
}

/** Case-insensitive email lookup (matches the NOCASE unique index). */
export async function getUserByEmail(
  db: D1Database,
  email: string,
): Promise<UserRow | null> {
  return (
    (await db
      .prepare("SELECT * FROM user WHERE email = ? COLLATE NOCASE")
      .bind(email)
      .first<UserRow>()) ?? null
  );
}

export async function setEmailVerified(db: D1Database, userId: string): Promise<void> {
  await db
    .prepare("UPDATE user SET email_verified = 1 WHERE id = ?")
    .bind(userId)
    .run();
}

export async function updateUserDisplayName(
  db: D1Database,
  id: string,
  displayName: string | null,
): Promise<void> {
  await db
    .prepare("UPDATE user SET display_name = ? WHERE id = ?")
    .bind(displayName, id)
    .run();
}
