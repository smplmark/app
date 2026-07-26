import { Hono } from "hono";
import { requireAdmin } from "../authz";
import {
  deleteMembership,
  getMembership,
  listAccountMembers,
  updateMembershipRole,
} from "../data/account_users";
import { BadRequestError, ForbiddenError, NotFoundError } from "../errors";
import { requireEnum } from "../http/body";
import { collectionResponse, noContentResponse, resourceResponse } from "../http/jsonapi";
import { getAuth, requireAuth, type AppBindings } from "../http/middleware";
import { paginationMeta } from "../query/pagination";
import { serializeAccountUser } from "../serialize/resource";
import { INVITABLE_ROLES } from "../types";
import { readAttributes, readPagination } from "./shared";

export const accountUsers = new Hono<AppBindings>();

/** Members of the caller's account (any member may view the roster). Account-level authority required. */
accountUsers.get("/", requireAuth, async (c) => {
  const auth = getAuth(c);
  if (auth.scope_type !== "ACCOUNT") {
    throw new ForbiddenError("Listing members requires an account-scoped credential.");
  }
  const pagination = readPagination(c);
  const rows = await listAccountMembers(c.env.DB, auth.account_id);
  const page = rows.slice(pagination.offset, pagination.offset + pagination.limit);
  return collectionResponse(page.map(serializeAccountUser), {
    meta: { pagination: paginationMeta(pagination, pagination.includeTotal ? rows.length : undefined) },
  });
});

/** Change a member's role. Admin-only; the owner's role is immutable and admins can't mint admins. */
accountUsers.put("/:userId", requireAuth, async (c) => {
  const auth = getAuth(c);
  requireAdmin(auth);
  const userId = c.req.param("userId");
  const membership = await getMembership(c.env.DB, auth.account_id, userId);
  if (!membership) throw new NotFoundError();
  if (membership.role === "OWNER") {
    throw new BadRequestError("The account owner's role cannot be changed.");
  }
  const attrs = await readAttributes(c);
  const role = requireEnum(attrs, "role", INVITABLE_ROLES);
  // An admin (not owner) may only assign MEMBER or VIEWER — never mint another admin.
  if (auth.source === "SESSION" && auth.role === "ADMIN" && role === "ADMIN") {
    throw new ForbiddenError("Admins can only assign the MEMBER or VIEWER role.");
  }
  await updateMembershipRole(c.env.DB, auth.account_id, userId, role);
  const updated = await getMembership(c.env.DB, auth.account_id, userId);
  return resourceResponse(serializeAccountUser(updated!));
});

/** Remove a member. Admin-only; you can't remove yourself or the owner. */
accountUsers.delete("/:userId", requireAuth, async (c) => {
  const auth = getAuth(c);
  requireAdmin(auth);
  const userId = c.req.param("userId");
  if (auth.user_id !== null && auth.user_id === userId) {
    throw new BadRequestError("You cannot remove yourself from the account.");
  }
  const membership = await getMembership(c.env.DB, auth.account_id, userId);
  if (!membership) throw new NotFoundError();
  if (membership.role === "OWNER") {
    throw new BadRequestError("The account owner cannot be removed.");
  }
  await deleteMembership(c.env.DB, auth.account_id, userId);
  return noContentResponse();
});
