import { Hono } from "hono";
import { canMintScope, requireAdmin, type ResourceChain } from "../authz";
import { mintApiKey, revealApiKey } from "../auth/apikey";
import { evictCachedScope } from "../auth/scope_cache";
import { getBenchmarkById } from "../data/benchmarks";
import {
  getApiKeyById,
  listApiKeys,
  revokeApiKey,
} from "../data/api_keys";
import { getRunById } from "../data/runs";
import { getTargetById } from "../data/targets";
import { ForbiddenError, NotFoundError } from "../errors";
import {
  optionalStringOrNull,
  parseEpochMs,
  requireEnum,
  requireString,
} from "../http/body";
import { collectionResponse, noContentResponse, resourceResponse } from "../http/jsonapi";
import { getAuth, requireAuth, type AppBindings } from "../http/middleware";
import { paginationMeta } from "../query/pagination";
import { serializeApiKey } from "../serialize/resource";
import { SCOPE_TYPES, type AuthContext, type ScopeType } from "../types";
import { readAttributes, readPagination, readSort } from "./shared";

const SORT_ALLOWED = ["name", "created_at", "last_used_at"] as const;

export const apiKeys = new Hono<AppBindings>();

/** Account-wide key management (list/reveal/rotate/revoke) requires account-level authority. */
function requireAccountScope(auth: AuthContext): void {
  if (auth.scope_type !== "ACCOUNT") {
    throw new ForbiddenError(
      "Managing API keys requires an account-scoped credential.",
    );
  }
}

/** Resolve+validate the requested scope into the chain the authority-ceiling check needs. */
async function requestedScopeChain(
  db: D1Database,
  auth: AuthContext,
  scopeType: ScopeType,
  scopeRef: string | null,
): Promise<{ chain: ResourceChain; scope_ref: string | null }> {
  if (scopeType === "ACCOUNT") {
    return { chain: { account_id: auth.account_id }, scope_ref: null };
  }
  if (scopeRef === null) throw new NotFoundError();
  if (scopeType === "BENCHMARK") {
    const b = await getBenchmarkById(db, scopeRef);
    if (!b || b.account_id !== auth.account_id) throw new NotFoundError();
    return {
      chain: { account_id: b.account_id, benchmark_id: b.id },
      scope_ref: b.id,
    };
  }
  // RUN
  const run = await getRunById(db, scopeRef);
  if (!run) throw new NotFoundError();
  const target = await getTargetById(db, run.target_id);
  if (!target) throw new NotFoundError();
  const b = await getBenchmarkById(db, target.benchmark_id);
  if (!b || b.account_id !== auth.account_id) throw new NotFoundError();
  return {
    chain: { account_id: b.account_id, benchmark_id: b.id, target_id: target.id, run_id: run.id },
    scope_ref: run.id,
  };
}

apiKeys.post("/", requireAuth, async (c) => {
  const auth = getAuth(c);
  requireAdmin(auth); // Key management is admin-tier (a viewer/member may use keys, not mint them).
  const attrs = await readAttributes(c);
  const name = requireString(attrs, "name");
  const scopeType = requireEnum(attrs, "scope_type", SCOPE_TYPES);
  const rawScopeRef = optionalStringOrNull(attrs, "scope_ref") ?? null;
  const expiresAt =
    "expires_at" in attrs && attrs.expires_at !== null
      ? parseEpochMs(attrs.expires_at, "expires_at")
      : null;

  const { chain, scope_ref } = await requestedScopeChain(c.env.DB, auth, scopeType, rawScopeRef);
  if (!canMintScope(auth, chain)) {
    throw new ForbiddenError("A key may not exceed the authority of the credential that mints it.");
  }

  const { row, plaintext } = await mintApiKey(c.env, c.env.DB, {
    account_id: auth.account_id,
    name,
    scope_type: scopeType,
    scope_ref,
    expires_at: expiresAt,
    created_by_user_id: auth.user_id,
  });
  return resourceResponse(serializeApiKey(row, plaintext), { status: 201 });
});

apiKeys.get("/", requireAuth, async (c) => {
  const auth = getAuth(c);
  requireAccountScope(auth);
  const pagination = readPagination(c);
  const sort = readSort(c, "-created_at", SORT_ALLOWED);
  const { rows, total } = await listApiKeys(c.env.DB, {
    account_id: auth.account_id,
    sort,
    limit: pagination.limit,
    offset: pagination.offset,
    includeTotal: pagination.includeTotal,
  });
  return collectionResponse(
    rows.map((r) => serializeApiKey(r)),
    { meta: { pagination: paginationMeta(pagination, total) } },
  );
});

apiKeys.get("/:id", requireAuth, async (c) => {
  const auth = getAuth(c);
  requireAccountScope(auth);
  const row = await getApiKeyById(c.env.DB, c.req.param("id"));
  if (!row || row.account_id !== auth.account_id) throw new NotFoundError();
  const plaintext = await revealApiKey(c.env, row);
  return resourceResponse(serializeApiKey(row, plaintext));
});

apiKeys.post("/:id/actions/rotate", requireAuth, async (c) => {
  const auth = getAuth(c);
  requireAccountScope(auth);
  requireAdmin(auth);
  const old = await getApiKeyById(c.env.DB, c.req.param("id"));
  if (!old || old.account_id !== auth.account_id) throw new NotFoundError();

  const now = Date.now();
  await revokeApiKey(c.env.DB, old.id, now);
  evictCachedScope(old.key_hash);
  const { row, plaintext } = await mintApiKey(c.env, c.env.DB, {
    account_id: old.account_id,
    name: old.name,
    scope_type: old.scope_type,
    scope_ref: old.scope_ref,
    expires_at: old.expires_at,
    created_by_user_id: auth.user_id,
  });
  return resourceResponse(serializeApiKey(row, plaintext), { status: 201 });
});

apiKeys.delete("/:id", requireAuth, async (c) => {
  const auth = getAuth(c);
  requireAccountScope(auth);
  requireAdmin(auth);
  const row = await getApiKeyById(c.env.DB, c.req.param("id"));
  if (!row || row.account_id !== auth.account_id) throw new NotFoundError();
  await revokeApiKey(c.env.DB, row.id, Date.now());
  evictCachedScope(row.key_hash);
  return noContentResponse();
});
