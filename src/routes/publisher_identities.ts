// Publisher identities (§3) — organization "brands" a benchmark can be published under. All writes
// are admin-gated and require an account-scoped credential; reads are visible to any member of the
// account. Deleting an identity is allowed even if a published benchmark references it: that benchmark
// froze its own attribution snapshot, so its badge survives.
import { Hono } from "hono";
import { requireAdmin } from "../authz";
import {
  createPublisherIdentity,
  deletePublisherIdentityCascade,
  getPublisherIdentityById,
  listPublisherIdentities,
  updatePublisherIdentity,
} from "../data/publisher_identities";
import { ForbiddenError, NotFoundError } from "../errors";
import { optionalStringOrNull, requireString } from "../http/body";
import { collectionResponse, noContentResponse, resourceResponse } from "../http/jsonapi";
import { getAuth, requireAuth, type AppBindings } from "../http/middleware";
import { serializePublisherIdentity } from "../serialize/resource";
import type { AuthContext, PublisherIdentityRow } from "../types";
import { readAttributes } from "./shared";

export const publisherIdentities = new Hono<AppBindings>();

/** Managing publisher identities requires account-level authority (not a scoped key). */
function requireAccountScope(auth: AuthContext): void {
  if (auth.scope_type !== "ACCOUNT") {
    throw new ForbiddenError("Managing publisher identities requires an account-scoped credential.");
  }
}

/** Load an identity in the caller's account, or 404. */
async function loadOwned(c: Parameters<typeof getAuth>[0], id: string): Promise<PublisherIdentityRow> {
  const auth = getAuth(c);
  requireAccountScope(auth);
  const row = await getPublisherIdentityById(c.env.DB, id);
  if (!row || row.account_id !== auth.account_id) throw new NotFoundError();
  return row;
}

publisherIdentities.post("/", requireAuth, async (c) => {
  const auth = getAuth(c);
  requireAccountScope(auth);
  requireAdmin(auth);
  const attrs = await readAttributes(c);
  const key = requireString(attrs, "key");
  const name = requireString(attrs, "name");
  const logo_url = optionalStringOrNull(attrs, "logo_url") ?? null;
  const row = await createPublisherIdentity(c.env.DB, {
    account_id: auth.account_id,
    key,
    name,
    logo_url,
  });
  return resourceResponse(serializePublisherIdentity(row), { status: 201 });
});

publisherIdentities.get("/", requireAuth, async (c) => {
  const auth = getAuth(c);
  requireAccountScope(auth);
  const rows = await listPublisherIdentities(c.env.DB, auth.account_id, {
    key: c.req.query("filter[key]"),
  });
  return collectionResponse(rows.map(serializePublisherIdentity));
});

publisherIdentities.get("/:id", requireAuth, async (c) => {
  const row = await loadOwned(c, c.req.param("id"));
  return resourceResponse(serializePublisherIdentity(row));
});

publisherIdentities.put("/:id", requireAuth, async (c) => {
  const auth = getAuth(c);
  const existing = await loadOwned(c, c.req.param("id"));
  requireAdmin(auth);
  const attrs = await readAttributes(c);
  const key = requireString(attrs, "key");
  const name = requireString(attrs, "name");
  const logo_url = optionalStringOrNull(attrs, "logo_url") ?? null;
  const row = await updatePublisherIdentity(c.env.DB, existing.id, { key, name, logo_url });
  return resourceResponse(serializePublisherIdentity(row as PublisherIdentityRow));
});

publisherIdentities.delete("/:id", requireAuth, async (c) => {
  const auth = getAuth(c);
  const existing = await loadOwned(c, c.req.param("id"));
  requireAdmin(auth);
  await deletePublisherIdentityCascade(c.env.DB, existing.id);
  return noContentResponse();
});
