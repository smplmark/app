// Publisher domains (§3) — TXT-verification claims under an identity. Writes are admin-gated and
// require an account-scoped credential; reads are visible to any member. The verify action performs a
// live DNS-over-HTTPS check now; a periodic cron sweep re-checks VERIFIED domains (see publish/sweep).
import { Hono } from "hono";
import { requireAdmin } from "../authz";
import {
  createPublisherDomain,
  deletePublisherDomain,
  getPublisherDomainById,
  listPublisherDomains,
  setPublisherDomainStatus,
} from "../data/publisher_domains";
import { getPublisherIdentityById } from "../data/publisher_identities";
import { ForbiddenError, NotFoundError } from "../errors";
import { requireEnum, requireString } from "../http/body";
import { collectionResponse, noContentResponse, resourceResponse } from "../http/jsonapi";
import { getAuth, requireAuth, type AppBindings } from "../http/middleware";
import { generateVerificationToken, lookupTxt, txtRecordsContain } from "../publish/dns";
import { serializePublisherDomain } from "../serialize/resource";
import {
  PUBLISHER_DOMAIN_STATUSES,
  type AuthContext,
  type PublisherDomainRow,
} from "../types";
import { readAttributes } from "./shared";

export const publisherDomains = new Hono<AppBindings>();

function requireAccountScope(auth: AuthContext): void {
  if (auth.scope_type !== "ACCOUNT") {
    throw new ForbiddenError("Managing publisher domains requires an account-scoped credential.");
  }
}

/** Load a domain in the caller's account, or 404. */
async function loadOwned(c: Parameters<typeof getAuth>[0], id: string): Promise<PublisherDomainRow> {
  const auth = getAuth(c);
  requireAccountScope(auth);
  const row = await getPublisherDomainById(c.env.DB, id);
  if (!row || row.account_id !== auth.account_id) throw new NotFoundError();
  return row;
}

publisherDomains.post("/", requireAuth, async (c) => {
  const auth = getAuth(c);
  requireAccountScope(auth);
  requireAdmin(auth);
  const attrs = await readAttributes(c);
  const identityId = requireString(attrs, "publisher_identity");
  const domain = requireString(attrs, "domain");
  const identity = await getPublisherIdentityById(c.env.DB, identityId);
  if (!identity || identity.account_id !== auth.account_id) throw new NotFoundError();
  const row = await createPublisherDomain(c.env.DB, {
    account_id: auth.account_id,
    publisher_identity_id: identity.id,
    domain,
    verification_token: generateVerificationToken(),
  });
  return resourceResponse(serializePublisherDomain(row), { status: 201 });
});

publisherDomains.get("/", requireAuth, async (c) => {
  const auth = getAuth(c);
  requireAccountScope(auth);
  const statusFilter = c.req.query("filter[status]");
  const rows = await listPublisherDomains(c.env.DB, auth.account_id, {
    publisherIdentityId: c.req.query("filter[publisher_identity]"),
    status:
      statusFilter !== undefined
        ? requireEnum({ status: statusFilter }, "status", PUBLISHER_DOMAIN_STATUSES)
        : undefined,
  });
  return collectionResponse(rows.map(serializePublisherDomain));
});

publisherDomains.post("/:id/actions/verify", requireAuth, async (c) => {
  const auth = getAuth(c);
  const existing = await loadOwned(c, c.req.param("id"));
  requireAdmin(auth);
  const now = Date.now();

  let records: string[] | null = null;
  try {
    records = await lookupTxt(existing.domain);
  } catch {
    // The check itself failed (network / resolver). Never lapse on ambiguity — record the attempt and
    // return the domain unchanged so the user can retry.
    const unchanged = await setPublisherDomainStatus(c.env.DB, existing.id, {
      status: existing.status,
      verified_at: existing.verified_at,
      last_checked_at: now,
    });
    return resourceResponse(serializePublisherDomain(unchanged as PublisherDomainRow));
  }

  if (txtRecordsContain(records, existing.verification_token)) {
    const row = await setPublisherDomainStatus(c.env.DB, existing.id, {
      status: "VERIFIED",
      verified_at: now,
      last_checked_at: now,
    });
    return resourceResponse(serializePublisherDomain(row as PublisherDomainRow));
  }

  // A genuine miss: stay PENDING, or lapse if it had been verified.
  const row = await setPublisherDomainStatus(c.env.DB, existing.id, {
    status: existing.status === "VERIFIED" ? "LAPSED" : existing.status,
    verified_at: existing.verified_at,
    last_checked_at: now,
  });
  return resourceResponse(serializePublisherDomain(row as PublisherDomainRow));
});

publisherDomains.delete("/:id", requireAuth, async (c) => {
  const auth = getAuth(c);
  const existing = await loadOwned(c, c.req.param("id"));
  requireAdmin(auth);
  await deletePublisherDomain(c.env.DB, existing.id);
  return noContentResponse();
});
