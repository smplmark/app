import { Hono } from "hono";
import { requireAdmin } from "../authz";
import { getAccountById, softDeleteAccount, updateAccount } from "../data/accounts";
import { listMembershipsForUserWithAccount } from "../data/account_users";
import { ForbiddenError, NotFoundError } from "../errors";
import { optionalBoolean, optionalStringOrNull, requireString } from "../http/body";
import { collectionResponse, noContentResponse, resourceResponse } from "../http/jsonapi";
import {
  getAuth,
  requireAuth,
  type AppBindings,
} from "../http/middleware";
import { serializeAccount, serializeAccountMembership } from "../serialize/resource";
import { readAttributes } from "./shared";

export const accounts = new Hono<AppBindings>();

/** The accounts the current user is a member of, with the caller's role in each (for the switcher). */
accounts.get("/", requireAuth, async (c) => {
  const auth = getAuth(c);
  if (!auth.user_id) {
    throw new ForbiddenError("Listing your accounts requires a session credential.");
  }
  const rows = await listMembershipsForUserWithAccount(c.env.DB, auth.user_id);
  return collectionResponse(rows.map((r) => serializeAccountMembership(r)));
});

/** The caller's own account. */
accounts.get("/current", requireAuth, async (c) => {
  const auth = getAuth(c);
  const row = await getAccountById(c.env.DB, auth.account_id);
  if (!row) throw new NotFoundError();
  return resourceResponse(serializeAccount(row));
});

accounts.put("/current", requireAuth, async (c) => {
  const auth = getAuth(c);
  if (auth.scope_type !== "ACCOUNT") {
    throw new ForbiddenError("Updating the account requires an account-scoped credential.");
  }
  requireAdmin(auth);
  const existing = await getAccountById(c.env.DB, auth.account_id);
  if (!existing) throw new NotFoundError();
  const attrs = await readAttributes(c);
  const name = requireString(attrs, "name");
  const description = optionalStringOrNull(attrs, "description") ?? null;
  // Full-replace, but an omitted flag keeps its current value (a settings PUT shouldn't silently
  // toggle the personal-publish gate off).
  const allowPersonal = optionalBoolean(attrs, "allow_personal_publish");
  const row = await updateAccount(c.env.DB, auth.account_id, {
    name,
    description,
    allow_personal_publish:
      allowPersonal === undefined ? existing.allow_personal_publish : allowPersonal ? 1 : 0,
  });
  if (!row) throw new NotFoundError();
  return resourceResponse(serializeAccount(row));
});

/** Soft-delete the caller's account. Owner-only and session-only: a deliberate human action, never an
 *  API key. The account is stamped deleted_at; all its tokens then stop resolving (see middleware). */
accounts.delete("/current", requireAuth, async (c) => {
  const auth = getAuth(c);
  if (auth.source !== "SESSION" || auth.role !== "OWNER") {
    throw new ForbiddenError("Only the account owner can delete the account.");
  }
  await softDeleteAccount(c.env.DB, auth.account_id);
  return noContentResponse();
});

/** Public publisher lookup (only accounts with a world-visible benchmark), or the caller's own. */
// Fetch an account by id. Authenticated and scoped to the caller's own account — a publisher's public
// identity (name/domain, verified tier, "publishing since") is carried on the benchmark's frozen
// `published_as`, so the public viewer needs no account lookup. Any other id is an indistinguishable
// 404 (no cross-account probing, no leak of the account's name / personal-publish setting).
accounts.get("/:id", requireAuth, async (c) => {
  const auth = getAuth(c);
  if (auth.account_id !== c.req.param("id")) throw new NotFoundError();
  const own = await getAccountById(c.env.DB, auth.account_id);
  if (!own) throw new NotFoundError();
  return resourceResponse(serializeAccount(own));
});
