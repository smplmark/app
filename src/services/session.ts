// Issue a session: record it (audit/revocation) and mint the JWT the client carries as its bearer.
import { issueSessionToken } from "../auth/jwt";
import { JWT_TTL_SECONDS } from "../config";
import { createSession } from "../data/sessions";
import type { AccountRow, Role, UserRow } from "../types";

export interface IssuedSession {
  token: string;
  expires_in: number;
  account_id: string;
  user_id: string;
}

export async function startSession(
  env: Env,
  db: D1Database,
  issuer: string,
  user: UserRow,
  account: AccountRow,
  role: Role,
  now: number,
): Promise<IssuedSession> {
  const jti = crypto.randomUUID();
  const { token, expiresAt } = await issueSessionToken(
    env,
    issuer,
    {
      sub: user.id,
      account_id: account.id,
      role,
      email_verified: user.email_verified === 1,
      jti,
    },
    now,
  );
  await createSession(db, {
    id: jti,
    user_id: user.id,
    account_id: account.id,
    expires_at: expiresAt,
  });
  return { token, expires_in: JWT_TTL_SECONDS, account_id: account.id, user_id: user.id };
}
