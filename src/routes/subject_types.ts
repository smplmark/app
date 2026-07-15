// Subject types — a formal, account-owned schema for subjects. A type has a display name, a kebab
// `key` derived from that name server-side (never supplied by the client), and a `fields` list. All
// endpoints need an account-scoped credential (a benchmark/run-scoped key can't reach the account's
// shared type namespace); writes are write-tier (a viewer may read, not mutate).
import { Hono, type Context } from "hono";
import { requireWrite } from "../authz";
import {
  countSubjectsOfType,
  countSubjectTypesForAccount,
  createSubjectType,
  deleteSubjectType,
  getSubjectTypeById,
  getSubjectTypeByKey,
  listSubjectTypes,
  updateSubjectType,
  countBenchmarksOfType,
} from "../data/subject_types";
import { ConflictError, ForbiddenError, NotFoundError } from "../errors";
import { requireString } from "../http/body";
import { collectionResponse, noContentResponse, resourceResponse } from "../http/jsonapi";
import { getAuth, requireAuth, type AppBindings } from "../http/middleware";
import { LIMITS } from "../limits";
import { paginationMeta } from "../query/pagination";
import { kebab, parseFieldDefs } from "../schema/subject_type";
import { serializeSubjectType } from "../serialize/resource";
import type { AuthContext, SubjectTypeRow } from "../types";
import { readAttributes, readPagination, readSort } from "./shared";

const SORT_ALLOWED = ["name", "key", "created_at", "updated_at"] as const;

export const subjectTypes = new Hono<AppBindings>();

/** Managing subject types is an account-level concern (not reachable by a scoped key). */
function requireAccountScope(auth: AuthContext): void {
  if (auth.scope_type !== "ACCOUNT") {
    throw new ForbiddenError("Managing subject types requires an account-scoped credential.");
  }
}

/** Load an account-owned subject type for a mutation, or 404. */
async function loadOwnedForWrite(c: Context<AppBindings>, id: string): Promise<SubjectTypeRow> {
  const auth = getAuth(c);
  requireAccountScope(auth);
  requireWrite(auth);
  const row = await getSubjectTypeById(c.env.DB, id);
  if (!row || row.account_id !== auth.account_id) throw new NotFoundError();
  return row;
}

/** A key derived from the name (kebab), made unique within the account with a numeric suffix. */
async function uniqueTypeKey(db: D1Database, accountId: string, name: string): Promise<string> {
  const base = kebab(name) || "type";
  if (!(await getSubjectTypeByKey(db, accountId, base))) return base;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base}-${i}`;
    if (!(await getSubjectTypeByKey(db, accountId, candidate))) return candidate;
  }
  return `${base}-${crypto.randomUUID().slice(0, 8)}`;
}

subjectTypes.post("/", requireAuth, async (c) => {
  const auth = getAuth(c);
  requireAccountScope(auth);
  requireWrite(auth);
  if ((await countSubjectTypesForAccount(c.env.DB, auth.account_id)) >= LIMITS.subjectTypesPerAccount) {
    throw new ForbiddenError(`You have reached the limit of ${LIMITS.subjectTypesPerAccount} subject types.`);
  }
  const attrs = await readAttributes(c);
  const name = requireString(attrs, "name");
  const fields = parseFieldDefs(attrs.fields);
  const key = await uniqueTypeKey(c.env.DB, auth.account_id, name);
  const row = await createSubjectType(c.env.DB, { account_id: auth.account_id, key, name, fields });
  return resourceResponse(serializeSubjectType(row), { status: 201 });
});

subjectTypes.get("/", requireAuth, async (c) => {
  const auth = getAuth(c);
  requireAccountScope(auth);
  const pagination = readPagination(c);
  const sort = readSort(c, "name", SORT_ALLOWED);
  const { rows, total } = await listSubjectTypes(c.env.DB, {
    account_id: auth.account_id,
    sort,
    limit: pagination.limit,
    offset: pagination.offset,
    includeTotal: pagination.includeTotal,
  });
  return collectionResponse(rows.map(serializeSubjectType), {
    meta: { pagination: paginationMeta(pagination, total) },
  });
});

subjectTypes.get("/:id", requireAuth, async (c) => {
  const auth = getAuth(c);
  requireAccountScope(auth);
  const row = await getSubjectTypeById(c.env.DB, c.req.param("id"));
  if (!row || row.account_id !== auth.account_id) throw new NotFoundError();
  return resourceResponse(serializeSubjectType(row));
});

subjectTypes.put("/:id", requireAuth, async (c) => {
  const existing = await loadOwnedForWrite(c, c.req.param("id"));
  const attrs = await readAttributes(c);
  const name = requireString(attrs, "name");
  const fields = parseFieldDefs(attrs.fields);
  const row = await updateSubjectType(c.env.DB, existing.id, { name, fields });
  if (!row) throw new NotFoundError();
  return resourceResponse(serializeSubjectType(row));
});

subjectTypes.delete("/:id", requireAuth, async (c) => {
  const existing = await loadOwnedForWrite(c, c.req.param("id"));
  if ((await countSubjectsOfType(c.env.DB, existing.id)) > 0) {
    throw new ConflictError("This subject type is in use by one or more subjects; delete those subjects first.");
  }
  if ((await countBenchmarksOfType(c.env.DB, existing.id)) > 0) {
    throw new ConflictError("This subject type is in use by one or more benchmarks; change their subject type first.");
  }
  await deleteSubjectType(c.env.DB, existing.id);
  return noContentResponse();
});
