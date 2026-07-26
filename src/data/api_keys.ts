import type { ApiKeyRow, ScopeType } from "../types";
import { orderByClause, type Sort } from "../query/sort";

export interface CreateApiKeyInput {
  account_id: string;
  name: string;
  scope_type: ScopeType;
  scope_ref: string | null;
  key_hash: string;
  key_encrypted: string;
  prefix: string;
  expires_at: number | null;
  created_by_user_id: string | null;
}

export async function createApiKey(
  db: D1Database,
  input: CreateApiKeyInput,
): Promise<ApiKeyRow> {
  const row: ApiKeyRow = {
    id: crypto.randomUUID(),
    account_id: input.account_id,
    name: input.name,
    scope_type: input.scope_type,
    scope_ref: input.scope_ref,
    key_hash: input.key_hash,
    key_encrypted: input.key_encrypted,
    prefix: input.prefix,
    expires_at: input.expires_at,
    created_by_user_id: input.created_by_user_id,
    revoked_at: null,
    last_used_at: null,
    created_at: Date.now(),
  };
  await db
    .prepare(
      "INSERT INTO api_key (id, account_id, name, scope_type, scope_ref, key_hash, key_encrypted, prefix, expires_at, created_by_user_id, revoked_at, last_used_at, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,NULL,NULL,?)",
    )
    .bind(
      row.id,
      row.account_id,
      row.name,
      row.scope_type,
      row.scope_ref,
      row.key_hash,
      row.key_encrypted,
      row.prefix,
      row.expires_at,
      row.created_by_user_id,
      row.created_at,
    )
    .run();
  return row;
}

/** Hot-path lookup for authentication: resolve a presented key's hash to its row. */
export async function getApiKeyByHash(
  db: D1Database,
  keyHash: string,
): Promise<ApiKeyRow | null> {
  return (
    (await db
      .prepare("SELECT * FROM api_key WHERE key_hash = ?")
      .bind(keyHash)
      .first<ApiKeyRow>()) ?? null
  );
}

export async function getApiKeyById(
  db: D1Database,
  id: string,
): Promise<ApiKeyRow | null> {
  return (
    (await db.prepare("SELECT * FROM api_key WHERE id = ?").bind(id).first<ApiKeyRow>()) ??
    null
  );
}

export interface ListApiKeysInput {
  account_id: string;
  sort: Sort;
  limit: number;
  offset: number;
  includeTotal: boolean;
  /** Optional scope filter — the tabbed UI lists only the keys scoped to a given resource. */
  scope_type?: ScopeType;
  scope_ref?: string | null;
}

const API_KEY_COLUMNS: Record<string, string> = {
  name: "name",
  created_at: "created_at",
  last_used_at: "last_used_at",
};

export async function listApiKeys(
  db: D1Database,
  input: ListApiKeysInput,
): Promise<{ rows: ApiKeyRow[]; total?: number }> {
  const order = orderByClause(input.sort, (f) => API_KEY_COLUMNS[f], "id");
  // Optional scope filter: scope_type alone, or scope_type + a specific scope_ref (BENCHMARK/RUN tabs).
  const filters: string[] = [];
  const filterBinds: unknown[] = [];
  if (input.scope_type !== undefined) {
    filters.push("scope_type = ?");
    filterBinds.push(input.scope_type);
  }
  if (input.scope_ref !== undefined && input.scope_ref !== null) {
    filters.push("scope_ref = ?");
    filterBinds.push(input.scope_ref);
  }
  const where = `WHERE account_id = ?${filters.length ? " AND " + filters.join(" AND ") : ""}`;

  const rows = (
    await db
      .prepare(`SELECT * FROM api_key ${where} ${order} LIMIT ? OFFSET ?`)
      .bind(input.account_id, ...filterBinds, input.limit, input.offset)
      .all<ApiKeyRow>()
  ).results;

  let total: number | undefined;
  if (input.includeTotal) {
    const r = await db
      .prepare(`SELECT COUNT(*) AS n FROM api_key ${where}`)
      .bind(input.account_id, ...filterBinds)
      .first<{ n: number }>();
    total = r?.n ?? 0;
  }
  return { rows, total };
}

export async function revokeApiKey(
  db: D1Database,
  id: string,
  now: number,
): Promise<void> {
  await db
    .prepare("UPDATE api_key SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
    .bind(now, id)
    .run();
}

/** Rename a key (the only mutable field; scope and expiry are fixed at creation). */
export async function updateApiKeyName(
  db: D1Database,
  id: string,
  name: string,
): Promise<void> {
  await db.prepare("UPDATE api_key SET name = ? WHERE id = ?").bind(name, id).run();
}

/** Hard-delete a key. (Revoke keeps the row marked revoked; Delete removes it outright.) */
export async function deleteApiKey(db: D1Database, id: string): Promise<void> {
  await db.prepare("DELETE FROM api_key WHERE id = ?").bind(id).run();
}

/** Best-effort last-used stamp (called via ctx.waitUntil off the hot path). */
export async function touchLastUsed(
  db: D1Database,
  id: string,
  now: number,
): Promise<void> {
  await db.prepare("UPDATE api_key SET last_used_at = ? WHERE id = ?").bind(now, id).run();
}
