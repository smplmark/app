// Session JWTs — the web-login credential (§6). HS256 via jose, verified statelessly (signature +
// exp + iss + aud). The `session` table records issuance for audit/logout; the hot path never reads
// it. Claims mirror smplkit's app JWT: iss=APP_URL, aud=smplmark, sub=user_id, plus account_id/role.

import { SignJWT, jwtVerify } from "jose";
import { JWT_AUDIENCE, JWT_TTL_SECONDS, requireAuthSecret } from "../config";
import { UnauthorizedError } from "../errors";
import { ROLES, type Role } from "./../types";

export interface SessionClaims {
  /** user id */
  sub: string;
  account_id: string;
  role: Role;
  email_verified: boolean;
  /** session id (jti), for audit/revocation. */
  jti: string;
}

function secretKey(env: Env): Uint8Array {
  return new TextEncoder().encode(requireAuthSecret(env));
}

/** Sign a session token. Returns the compact JWT and its absolute expiry (epoch-ms). */
export async function issueSessionToken(
  env: Env,
  issuer: string,
  claims: SessionClaims,
  now: number,
): Promise<{ token: string; expiresAt: number }> {
  const iat = Math.floor(now / 1000);
  const exp = iat + JWT_TTL_SECONDS;
  const token = await new SignJWT({
    account_id: claims.account_id,
    role: claims.role,
    email_verified: claims.email_verified,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(claims.sub)
    .setJti(claims.jti)
    .setIssuer(issuer)
    .setAudience(JWT_AUDIENCE)
    .setIssuedAt(iat)
    .setExpirationTime(exp)
    .sign(secretKey(env));
  return { token, expiresAt: exp * 1000 };
}

/** Verify a session token. Throws UnauthorizedError on any failure (non-leaky). */
export async function verifySessionToken(env: Env, token: string): Promise<SessionClaims> {
  let payload: Record<string, unknown>;
  try {
    const result = await jwtVerify(token, secretKey(env), {
      audience: JWT_AUDIENCE,
    });
    payload = result.payload as Record<string, unknown>;
  } catch {
    throw new UnauthorizedError();
  }
  const sub = payload.sub;
  const account_id = payload.account_id;
  const jti = payload.jti;
  const role = payload.role;
  if (
    typeof sub !== "string" ||
    typeof account_id !== "string" ||
    typeof jti !== "string" ||
    typeof role !== "string" ||
    !(ROLES as readonly string[]).includes(role)
  ) {
    throw new UnauthorizedError();
  }
  return {
    sub,
    account_id,
    role: role as Role,
    email_verified: payload.email_verified === true,
    jti,
  };
}
