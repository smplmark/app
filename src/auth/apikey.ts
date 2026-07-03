// API-key minting, resolution, and reveal. The hot path (resolveApiKey) touches only the indexed
// key_hash column (and the per-isolate cache); the AES-GCM ciphertext is decrypted only for reveal.
import { requireKeyEncryptionSecret } from "../config";
import {
  createApiKey,
  getApiKeyByHash,
  type CreateApiKeyInput,
} from "../data/api_keys";
import { UnauthorizedError } from "../errors";
import type { ApiKeyRow, AuthContext, ScopeType } from "../types";
import {
  apiKeyPrefix,
  decryptSecret,
  encryptSecret,
  generateApiKey,
  sha256Hex,
} from "./crypto";
import { getCachedScope, setCachedScope, type ResolvedScope } from "./scope_cache";

export interface MintApiKeyInput {
  account_id: string;
  name: string;
  scope_type: ScopeType;
  scope_ref: string | null;
  expires_at: number | null;
  created_by_user_id: string | null;
}

/** Mint a key: generate plaintext, hash + encrypt at rest, persist. Returns the row + plaintext. */
export async function mintApiKey(
  env: Env,
  db: D1Database,
  input: MintApiKeyInput,
): Promise<{ row: ApiKeyRow; plaintext: string }> {
  const plaintext = generateApiKey();
  const key_hash = await sha256Hex(plaintext);
  const key_encrypted = await encryptSecret(plaintext, requireKeyEncryptionSecret(env));
  const create: CreateApiKeyInput = {
    account_id: input.account_id,
    name: input.name,
    scope_type: input.scope_type,
    scope_ref: input.scope_ref,
    key_hash,
    key_encrypted,
    prefix: apiKeyPrefix(plaintext),
    expires_at: input.expires_at,
    created_by_user_id: input.created_by_user_id,
  };
  const row = await createApiKey(db, create);
  return { row, plaintext };
}

/** Decrypt a stored key back to plaintext (reveal endpoint only). */
export function revealApiKey(env: Env, row: ApiKeyRow): Promise<string> {
  return decryptSecret(row.key_encrypted, requireKeyEncryptionSecret(env));
}

function toContext(scope: ResolvedScope): AuthContext {
  return {
    source: "API_KEY",
    account_id: scope.account_id,
    scope_type: scope.scope_type,
    scope_ref: scope.scope_ref,
    user_id: null,
    role: null,
    session_id: null,
  };
}

/**
 * Resolve a presented API-key plaintext to an auth context. Throws UnauthorizedError (non-leaky) on
 * unknown / revoked / expired. Returns the resolved key hash + id so the caller can touch last_used.
 */
export async function resolveApiKey(
  db: D1Database,
  plaintext: string,
  now: number,
): Promise<{ ctx: AuthContext; keyId: string; keyHash: string }> {
  const keyHash = await sha256Hex(plaintext);
  const cached = getCachedScope(keyHash, now);
  if (cached) {
    return { ctx: toContext(cached), keyId: cached.keyId, keyHash };
  }
  const row = await getApiKeyByHash(db, keyHash);
  if (row === null || row.revoked_at !== null) {
    throw new UnauthorizedError();
  }
  if (row.expires_at !== null && row.expires_at <= now) {
    throw new UnauthorizedError();
  }
  const scope: ResolvedScope = {
    keyId: row.id,
    account_id: row.account_id,
    scope_type: row.scope_type,
    scope_ref: row.scope_ref,
  };
  setCachedScope(keyHash, scope, now);
  return { ctx: toContext(scope), keyId: row.id, keyHash };
}
