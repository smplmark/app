// Account invitations. An admin invites an email at a role; the invitee gets an emailed link and
// accepts it (creating an account_user membership) after signing in. Mirrors smplkit's flow.
import { Hono } from "hono";
import { requireAdmin } from "../authz";
import { randomToken, sha256Hex } from "../auth/crypto";
import { INVITATION_TTL_MS, appUrl } from "../config";
import { getAccountById } from "../data/accounts";
import { createMembership, getMembership } from "../data/account_users";
import {
  createInvitation,
  getInvitationById,
  getInvitationByTokenHash,
  getPendingInvitationByEmail,
  listInvitationsForAccount,
  rotateInvitationToken,
  setInvitationStatus,
} from "../data/invitations";
import { getUserByEmail, getUserById } from "../data/users";
import { AppError, BadRequestError, ConflictError, ForbiddenError, NotFoundError } from "../errors";
import { requireEnum, requireString } from "../http/body";
import { collectionResponse, resourceResponse } from "../http/jsonapi";
import { getAuth, getOptionalAuth, optionalAuth, requireAuth, type AppBindings } from "../http/middleware";
import { paginationMeta } from "../query/pagination";
import { rateLimit } from "../http/ratelimit";
import { sendInvitationEmail } from "../email/resend";
import { serializeInvitation } from "../serialize/resource";
import { INVITABLE_ROLES, INVITATION_STATUSES, type InvitationRow } from "../types";
import { readAttributes, readPagination } from "./shared";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const invitations = new Hono<AppBindings>();

function acceptUrl(env: Env, requestUrl: string, token: string): string {
  return `${appUrl(env, requestUrl)}/accept-invitation?token=${encodeURIComponent(token)}`;
}

/** 410 Gone — an expired invitation. */
class GoneError extends AppError {
  constructor(detail: string) {
    super(410, "Gone", detail);
  }
}

// ── Create ───────────────────────────────────────────────────────────────────
invitations.post("/", requireAuth, rateLimit((e) => e.RL_SENSITIVE), async (c) => {
  const auth = getAuth(c);
  if (auth.scope_type !== "ACCOUNT") {
    throw new ForbiddenError("Inviting members requires an account-scoped credential.");
  }
  requireAdmin(auth);
  const attrs = await readAttributes(c);
  const email = requireString(attrs, "email");
  if (!EMAIL_RE.test(email)) {
    throw new BadRequestError("A valid email is required.", { pointer: "/data/attributes/email" });
  }
  const role = requireEnum(attrs, "role", INVITABLE_ROLES);

  // Already a member?
  const existingUser = await getUserByEmail(c.env.DB, email);
  if (existingUser && (await getMembership(c.env.DB, auth.account_id, existingUser.id))) {
    throw new ConflictError("That person is already a member of this account.");
  }
  // Already invited (pending)?
  if (await getPendingInvitationByEmail(c.env.DB, auth.account_id, email)) {
    throw new ConflictError(
      "A pending invitation already exists for this email. Resend it from the members page instead.",
    );
  }

  const token = randomToken(32);
  const row = await createInvitation(c.env.DB, {
    account_id: auth.account_id,
    email,
    role,
    token_hash: await sha256Hex(token),
    invited_by_user_id: auth.user_id,
    expires_at: Date.now() + INVITATION_TTL_MS,
  });

  await emailInvite(c, row, token);
  return resourceResponse(serializeInvitation(row, token), { status: 201 });
});

// ── List (admin) or public token lookup ──────────────────────────────────────
invitations.get("/", optionalAuth, async (c) => {
  const token = c.req.query("filter[token]");
  if (token !== undefined) {
    // Public preview: knowledge of the token is the capability (used by the login page banner).
    const row = await getInvitationByTokenHash(c.env.DB, await sha256Hex(token));
    if (!row) return collectionResponse([]);
    const account = await getAccountById(c.env.DB, row.account_id);
    const inviter = row.invited_by_user_id
      ? await getUserById(c.env.DB, row.invited_by_user_id)
      : null;
    const resource = serializeInvitation(row);
    resource.attributes.account_name = account ? account.name : null;
    resource.attributes.invited_by_name = inviter ? inviter.display_name : null;
    return collectionResponse([resource]);
  }

  // Admin list of the account's invitations.
  const auth = getOptionalAuth(c);
  if (!auth) throw new ForbiddenError("Listing invitations requires authentication.");
  if (auth.scope_type !== "ACCOUNT") {
    throw new ForbiddenError("Listing invitations requires an account-scoped credential.");
  }
  requireAdmin(auth);
  const pagination = readPagination(c);
  const status = c.req.query("filter[status]");
  const parsedStatus =
    status !== undefined
      ? requireEnum({ status }, "status", INVITATION_STATUSES)
      : undefined;
  const rows = await listInvitationsForAccount(c.env.DB, auth.account_id, { status: parsedStatus });
  const page = rows.slice(pagination.offset, pagination.offset + pagination.limit);
  return collectionResponse(page.map((r) => serializeInvitation(r)), {
    meta: { pagination: paginationMeta(pagination, pagination.includeTotal ? rows.length : undefined) },
  });
});

// ── Revoke ───────────────────────────────────────────────────────────────────
invitations.post("/:id/actions/revoke", requireAuth, async (c) => {
  const { row } = await loadOwnedInvite(c, c.req.param("id"));
  if (row.status !== "PENDING") {
    throw new ConflictError("Only a pending invitation can be revoked.");
  }
  await setInvitationStatus(c.env.DB, row.id, "REVOKED");
  const updated = await getInvitationById(c.env.DB, row.id);
  return resourceResponse(serializeInvitation(updated as InvitationRow));
});

// ── Resend ───────────────────────────────────────────────────────────────────
invitations.post("/:id/actions/resend", requireAuth, rateLimit((e) => e.RL_SENSITIVE), async (c) => {
  const { row } = await loadOwnedInvite(c, c.req.param("id"));
  if (row.status !== "PENDING") {
    throw new ConflictError("Only a pending invitation can be resent.");
  }
  const token = randomToken(32);
  await rotateInvitationToken(c.env.DB, row.id, await sha256Hex(token), Date.now() + INVITATION_TTL_MS);
  const updated = (await getInvitationById(c.env.DB, row.id)) as InvitationRow;
  await emailInvite(c, updated, token);
  return resourceResponse(serializeInvitation(updated, token));
});

// ── Accept ───────────────────────────────────────────────────────────────────
invitations.post("/accept", requireAuth, async (c) => {
  const auth = getAuth(c);
  if (!auth.user_id) {
    throw new ForbiddenError("Accepting an invitation requires a session credential.");
  }
  const attrs = await readAttributes(c);
  const token = requireString(attrs, "token");
  const row = await getInvitationByTokenHash(c.env.DB, await sha256Hex(token));
  if (!row) throw new BadRequestError("This invitation link is invalid.");
  if (row.status !== "PENDING") {
    throw new ConflictError("This invitation has already been used, revoked, or expired.");
  }
  if (row.expires_at < Date.now()) {
    await setInvitationStatus(c.env.DB, row.id, "EXPIRED");
    throw new GoneError("This invitation has expired. Ask an admin to send a new one.");
  }
  const user = await getUserById(c.env.DB, auth.user_id);
  if (!user) throw new NotFoundError();
  if (user.email.toLowerCase() !== row.email.toLowerCase()) {
    throw new ForbiddenError(`This invitation was sent to ${row.email}. Sign in as ${row.email} to accept it.`);
  }
  if (!(await getMembership(c.env.DB, row.account_id, user.id))) {
    await createMembership(c.env.DB, { account_id: row.account_id, user_id: user.id, role: row.role });
  }
  await setInvitationStatus(c.env.DB, row.id, "ACCEPTED", Date.now());
  const updated = (await getInvitationById(c.env.DB, row.id)) as InvitationRow;
  return resourceResponse(serializeInvitation(updated));
});

// ── Helpers ──────────────────────────────────────────────────────────────────
async function loadOwnedInvite(
  c: Parameters<typeof getAuth>[0],
  id: string,
): Promise<{ row: InvitationRow }> {
  const auth = getAuth(c);
  if (auth.scope_type !== "ACCOUNT") {
    throw new ForbiddenError("Managing invitations requires an account-scoped credential.");
  }
  requireAdmin(auth);
  const row = await getInvitationById(c.env.DB, id);
  if (!row || row.account_id !== auth.account_id) throw new NotFoundError();
  return { row };
}

async function emailInvite(
  c: Parameters<typeof getAuth>[0],
  row: InvitationRow,
  token: string,
): Promise<void> {
  const account = await getAccountById(c.env.DB, row.account_id);
  const inviter = row.invited_by_user_id
    ? await getUserById(c.env.DB, row.invited_by_user_id)
    : null;
  await sendInvitationEmail(c.env, {
    to: row.email,
    acceptUrl: acceptUrl(c.env, c.req.url, token),
    accountName: account ? account.name : "an account",
    inviterName: inviter ? inviter.display_name : null,
    role: row.role,
  });
}
