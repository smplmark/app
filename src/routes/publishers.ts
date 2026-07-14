// Publishers (§3) — a publisher IS a domain, TXT-verified via DNS. Writes are admin-gated and need an
// account-scoped credential; reads are visible to any member. `verify` does a live DNS-over-HTTPS
// check now; a periodic cron sweep re-checks VERIFIED publishers (see publish/sweep).
import { Hono } from "hono";
import { requireAdmin } from "../authz";
import {
  createPublisher,
  deletePublisher,
  getPublisherById,
  listPublishers,
  setPublisherStatus,
  updatePublisherIcon,
} from "../data/publishers";
import { BadRequestError, ForbiddenError, NotFoundError } from "../errors";
import { requireEnum, requireString } from "../http/body";
import { collectionResponse, noContentResponse, resourceResponse } from "../http/jsonapi";
import { getAuth, requireAuth, type AppBindings } from "../http/middleware";
import { domainHasVerificationToken, generateVerificationToken } from "../publish/dns";
import { serializePublisher } from "../serialize/resource";
import {
  PUBLISHER_ICON_KINDS,
  PUBLISHER_STATUSES,
  type AuthContext,
  type PublisherIconKind,
  type PublisherRow,
} from "../types";
import { readAttributes } from "./shared";

export const publishers = new Hono<AppBindings>();

/** Managing publishers requires account-level authority (not a scoped key). */
function requireAccountScope(auth: AuthContext): void {
  if (auth.scope_type !== "ACCOUNT") {
    throw new ForbiddenError("Managing publishers requires an account-scoped credential.");
  }
}

/** Load a publisher in the caller's account, or 404. */
async function loadOwned(c: Parameters<typeof getAuth>[0], id: string): Promise<PublisherRow> {
  const auth = getAuth(c);
  requireAccountScope(auth);
  const row = await getPublisherById(c.env.DB, id);
  if (!row || row.account_id !== auth.account_id) throw new NotFoundError();
  return row;
}

publishers.post("/", requireAuth, async (c) => {
  const auth = getAuth(c);
  requireAccountScope(auth);
  requireAdmin(auth);
  const attrs = await readAttributes(c);
  const domain = requireString(attrs, "domain");
  const row = await createPublisher(c.env.DB, {
    account_id: auth.account_id,
    domain,
    verification_token: generateVerificationToken(),
  });
  return resourceResponse(serializePublisher(row), { status: 201 });
});

publishers.get("/", requireAuth, async (c) => {
  const auth = getAuth(c);
  requireAccountScope(auth);
  const statusFilter = c.req.query("filter[status]");
  const rows = await listPublishers(c.env.DB, auth.account_id, {
    status:
      statusFilter !== undefined
        ? requireEnum({ status: statusFilter }, "status", PUBLISHER_STATUSES)
        : undefined,
  });
  return collectionResponse(rows.map(serializePublisher));
});

publishers.get("/:id", requireAuth, async (c) => {
  const row = await loadOwned(c, c.req.param("id"));
  return resourceResponse(serializePublisher(row));
});

publishers.put("/:id", requireAuth, async (c) => {
  const auth = getAuth(c);
  const existing = await loadOwned(c, c.req.param("id"));
  requireAdmin(auth);
  const attrs = await readAttributes(c);
  // icon values are lowercase (monogram|favicon), so validate case-sensitively (not via requireEnum,
  // which upper-cases for SCREAMING_SNAKE_CASE enums).
  const iconRaw = requireString(attrs, "icon");
  if (!(PUBLISHER_ICON_KINDS as readonly string[]).includes(iconRaw)) {
    throw new BadRequestError(`icon must be one of: ${PUBLISHER_ICON_KINDS.join(", ")}.`);
  }
  const row = await updatePublisherIcon(c.env.DB, existing.id, iconRaw as PublisherIconKind);
  return resourceResponse(serializePublisher(row as PublisherRow));
});

publishers.post("/:id/actions/verify", requireAuth, async (c) => {
  const auth = getAuth(c);
  const existing = await loadOwned(c, c.req.param("id"));
  requireAdmin(auth);
  const now = Date.now();

  let found: boolean;
  try {
    found = await domainHasVerificationToken(existing.domain, existing.verification_token);
  } catch {
    // The check itself was inconclusive (network / resolver). Never lapse on ambiguity — record the
    // attempt and return the publisher unchanged so the user can retry.
    const unchanged = await setPublisherStatus(c.env.DB, existing.id, {
      status: existing.status,
      verified_at: existing.verified_at,
      last_checked_at: now,
    });
    return resourceResponse(serializePublisher(unchanged as PublisherRow));
  }

  if (found) {
    const row = await setPublisherStatus(c.env.DB, existing.id, { status: "VERIFIED", verified_at: now, last_checked_at: now });
    return resourceResponse(serializePublisher(row as PublisherRow));
  }

  // A genuine miss: stay PENDING, or lapse if it had been verified.
  const row = await setPublisherStatus(c.env.DB, existing.id, {
    status: existing.status === "VERIFIED" ? "LAPSED" : existing.status,
    verified_at: existing.verified_at,
    last_checked_at: now,
  });
  return resourceResponse(serializePublisher(row as PublisherRow));
});

publishers.delete("/:id", requireAuth, async (c) => {
  const auth = getAuth(c);
  const existing = await loadOwned(c, c.req.param("id"));
  requireAdmin(auth);
  await deletePublisher(c.env.DB, existing.id);
  return noContentResponse();
});
