import { Hono, type Context } from "hono";
import {
  canAdmin,
  canPublishOrg,
  canPublishPersonal,
  canWrite,
  covers,
  isAuthor,
  isPublicStatus,
  RBAC_REASONS,
  requireWrite,
} from "../authz";
import { sha256Hex } from "../auth/crypto";
import { accountHasVerifiedUser, getAccountById } from "../data/accounts";
import {
  createBenchmark,
  deleteBenchmarkCascade,
  getBenchmarkById,
  listBenchmarks,
  publishBenchmark,
  setBenchmarkDraft,
  updateBenchmark,
  withdrawBenchmark,
} from "../data/benchmarks";
import { getPublisherIdentityById } from "../data/publisher_identities";
import { listVerifiedDomains } from "../data/publisher_domains";
import { getUserById } from "../data/users";
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from "../errors";
import {
  optionalStringOrNull,
  requireString,
} from "../http/body";
import { collectionResponse, noContentResponse, resourceResponse } from "../http/jsonapi";
import { getAuth, getOptionalAuth, optionalAuth, requireAuth, type AppBindings } from "../http/middleware";
import { paginationMeta } from "../query/pagination";
import {
  assertFrozenCompatible,
  parseSampleSchema,
  validateSampleSchema,
} from "../schema/sample_schema";
import { serializeBenchmark } from "../serialize/resource";
import type {
  AuthContext,
  BenchmarkRow,
  OrgAttributionSnapshot,
  PersonalAttributionSnapshot,
  SampleSchema,
  Status,
} from "../types";
import { assertBenchmarkEditable, readAttributes, readPagination, readSort } from "./shared";

const EMPTY_SCHEMA: SampleSchema = { metrics: [], derived: [] };
const PUBLIC_STATUSES: Status[] = ["PUBLISHED", "WITHDRAWN"];
const SORT_ALLOWED = ["name", "created_at", "updated_at"] as const;

export const benchmarks = new Hono<AppBindings>();

/** Load a benchmark or 404; enforce that the credential covers it (else 404 — no existence leak). */
async function loadOwned(c: Context<AppBindings>, id: string): Promise<BenchmarkRow> {
  const auth = getAuth(c);
  requireWrite(auth); // loadOwned backs only mutating handlers — gate viewers here.
  const row = await getBenchmarkById(c.env.DB, id);
  if (!row || !covers(auth, { account_id: row.account_id, benchmark_id: row.id })) {
    throw new NotFoundError();
  }
  return row;
}

/** The draft/ready flag transitions (§2): the author (a writer) or any admin. */
function assertCanManageDraft(auth: AuthContext, benchmark: BenchmarkRow): void {
  if (!(canAdmin(auth) || (isAuthor(auth, benchmark) && canWrite(auth)))) {
    throw new ForbiddenError(
      "Only the benchmark's author or an admin can change its draft state.",
    );
  }
}

benchmarks.post("/", requireAuth, async (c) => {
  const auth = getAuth(c);
  if (auth.scope_type !== "ACCOUNT") {
    throw new ForbiddenError("This credential's scope does not permit creating benchmarks.");
  }
  requireWrite(auth);
  const attrs = await readAttributes(c);
  const key = requireString(attrs, "key");
  const name = requireString(attrs, "name");
  const description = optionalStringOrNull(attrs, "description") ?? null;
  const about = optionalStringOrNull(attrs, "about") ?? null;
  const methodology = optionalStringOrNull(attrs, "methodology") ?? null;
  const sample_schema =
    "sample_schema" in attrs ? validateSampleSchema(attrs.sample_schema) : EMPTY_SCHEMA;

  const row = await createBenchmark(c.env.DB, {
    account_id: auth.account_id,
    key,
    name,
    description,
    about,
    methodology,
    sample_schema,
    created_by_user_id: auth.user_id, // null when an API key creates it
  });
  return resourceResponse(serializeBenchmark(row), { status: 201 });
});

benchmarks.get("/", optionalAuth, async (c) => {
  const auth = getOptionalAuth(c);
  const pagination = readPagination(c);
  const sort = readSort(c, "-created_at", SORT_ALLOWED);
  const filterAccount = c.req.query("filter[account]");
  const filterKey = c.req.query("filter[key]");

  // An account-authority caller viewing their own account sees every status; everyone else sees
  // only world-visible benchmarks.
  const ownerView =
    !!auth &&
    auth.scope_type === "ACCOUNT" &&
    filterAccount !== undefined &&
    filterAccount === auth.account_id;

  const { rows, total } = await listBenchmarks(c.env.DB, {
    statuses: ownerView ? undefined : PUBLIC_STATUSES,
    accountId: filterAccount,
    filterKey,
    sort,
    limit: pagination.limit,
    offset: pagination.offset,
    includeTotal: pagination.includeTotal,
  });
  return collectionResponse(rows.map(serializeBenchmark), {
    meta: { pagination: paginationMeta(pagination, total) },
  });
});

benchmarks.get("/:id", optionalAuth, async (c) => {
  const auth = getOptionalAuth(c);
  const row = await getBenchmarkById(c.env.DB, c.req.param("id"));
  if (!row) throw new NotFoundError();
  if (!isPublicStatus(row.status)) {
    if (!auth || !covers(auth, { account_id: row.account_id, benchmark_id: row.id })) {
      throw new NotFoundError();
    }
  }
  return resourceResponse(serializeBenchmark(row));
});

benchmarks.put("/:id", requireAuth, async (c) => {
  const existing = await loadOwned(c, c.req.param("id"));
  assertBenchmarkEditable(existing); // marked-ready subtree is frozen until publish/return-to-draft
  const attrs = await readAttributes(c);
  const name = requireString(attrs, "name");
  const description = optionalStringOrNull(attrs, "description") ?? null;
  const about = optionalStringOrNull(attrs, "about") ?? null;
  const methodology = optionalStringOrNull(attrs, "methodology") ?? null;
  const sample_schema =
    "sample_schema" in attrs ? validateSampleSchema(attrs.sample_schema) : EMPTY_SCHEMA;

  // Interpretation freeze: on a published/withdrawn benchmark the semantic core is immutable.
  if (existing.status !== "PRIVATE") {
    assertFrozenCompatible(parseSampleSchema(existing.sample_schema), sample_schema);
  }

  const row = await updateBenchmark(c.env.DB, existing.id, {
    name,
    description,
    about,
    methodology,
    sample_schema,
  });
  return resourceResponse(serializeBenchmark(row as BenchmarkRow));
});

benchmarks.delete("/:id", requireAuth, async (c) => {
  const existing = await loadOwned(c, c.req.param("id"));
  assertBenchmarkEditable(existing); // can't delete out of the marked-ready state
  if (existing.status !== "PRIVATE") {
    throw new ConflictError(
      "Published benchmark data is append-only and cannot be deleted; withdraw it instead.",
    );
  }
  await deleteBenchmarkCascade(c.env.DB, existing.id);
  return noContentResponse();
});

// ── Draft workflow (§2) ──────────────────────────────────────────────────────

benchmarks.post("/:id/actions/mark_ready", requireAuth, async (c) => {
  const auth = getAuth(c);
  const existing = await loadOwned(c, c.req.param("id"));
  assertCanManageDraft(auth, existing);
  if (existing.status !== "PRIVATE") {
    throw new ConflictError("Only a private benchmark can be marked ready.");
  }
  const row = await setBenchmarkDraft(c.env.DB, existing.id, 0);
  return resourceResponse(serializeBenchmark(row as BenchmarkRow));
});

benchmarks.post("/:id/actions/return_to_draft", requireAuth, async (c) => {
  const auth = getAuth(c);
  const existing = await loadOwned(c, c.req.param("id"));
  assertCanManageDraft(auth, existing);
  if (existing.status !== "PRIVATE") {
    throw new ConflictError("Only a private benchmark can be returned to draft.");
  }
  const attrs = await readAttributes(c).catch(() => ({}) as Record<string, unknown>);
  const reason = optionalStringOrNull(attrs, "reason") ?? null;
  const row = await setBenchmarkDraft(c.env.DB, existing.id, 1);
  return resourceResponse(
    serializeBenchmark(row as BenchmarkRow),
    reason !== null ? { meta: { reason } } : {},
  );
});

// ── Publish / withdraw (§4) ──────────────────────────────────────────────────

benchmarks.post("/:id/actions/publish", requireAuth, async (c) => {
  const auth = getAuth(c);
  const existing = await loadOwned(c, c.req.param("id"));
  // Publish is inherently user-driven — API keys can create/populate, humans publish.
  if (auth.source !== "SESSION") throw new ForbiddenError(RBAC_REASONS.publishSession);
  if (existing.status !== "PRIVATE") {
    throw new ConflictError("Only a private benchmark can be published.");
  }
  if (existing.draft !== 0) {
    throw new ConflictError("Mark the benchmark ready before publishing.");
  }
  if (!(await accountHasVerifiedUser(c.env.DB, existing.account_id))) {
    throw new ForbiddenError("Verify your email address before publishing a benchmark.");
  }

  const attrs = await readAttributes(c).catch(() => ({}) as Record<string, unknown>);
  const identityRef = optionalStringOrNull(attrs, "publisher_identity") ?? null;
  const now = Date.now();

  // ORGANIZATION publish — a publisher_identity is named (and isn't the "self" sentinel).
  if (identityRef !== null && identityRef !== "self") {
    if (!canPublishOrg(auth)) throw new ForbiddenError(RBAC_REASONS.publishOrg);
    const identity = await getPublisherIdentityById(c.env.DB, identityRef);
    if (!identity || identity.account_id !== existing.account_id) throw new NotFoundError();
    const verified = await listVerifiedDomains(c.env.DB, identity.id);
    if (verified.length === 0) {
      throw new ConflictError("This organization identity has no verified domain.");
    }
    const snapshot: OrgAttributionSnapshot = {
      name: identity.name,
      logo_url: identity.logo_url,
      verified_domains: verified.map((d) => d.domain),
    };
    const row = await publishBenchmark(c.env.DB, existing.id, now, {
      published_by_user_id: auth.user_id,
      published_as_kind: "ORGANIZATION",
      published_identity_id: identity.id,
      attribution_snapshot: JSON.stringify(snapshot),
    });
    return resourceResponse(serializeBenchmark(row as BenchmarkRow));
  }

  // PERSONAL publish — attributed to the author, gated by the account's opt-in.
  const account = await getAccountById(c.env.DB, existing.account_id);
  if (!canPublishPersonal(auth, existing, account)) {
    throw new ForbiddenError(RBAC_REASONS.publishPersonal);
  }
  const author = auth.user_id !== null ? await getUserById(c.env.DB, auth.user_id) : null;
  const snapshot: PersonalAttributionSnapshot = {
    display_name: author?.display_name ?? null,
    email_sha256: await sha256Hex((author?.email ?? "").trim().toLowerCase()),
  };
  const row = await publishBenchmark(c.env.DB, existing.id, now, {
    published_by_user_id: auth.user_id,
    published_as_kind: "PERSONAL",
    published_identity_id: null,
    attribution_snapshot: JSON.stringify(snapshot),
  });
  return resourceResponse(serializeBenchmark(row as BenchmarkRow));
});

benchmarks.post("/:id/actions/withdraw", requireAuth, async (c) => {
  const auth = getAuth(c);
  const existing = await loadOwned(c, c.req.param("id"));
  if (auth.source !== "SESSION") throw new ForbiddenError(RBAC_REASONS.withdrawSession);
  if (existing.status !== "PUBLISHED") {
    throw new ConflictError("Only a published benchmark can be withdrawn.");
  }
  // Withdraw authority mirrors the publish attribution.
  if (existing.published_as_kind === "ORGANIZATION") {
    if (!canAdmin(auth)) throw new ForbiddenError(RBAC_REASONS.admin);
  } else if (!(isAuthor(auth, existing) || canAdmin(auth))) {
    throw new ForbiddenError(RBAC_REASONS.withdrawPersonal);
  }

  const attrs = await readAttributes(c).catch(() => ({}) as Record<string, unknown>);
  const reason = optionalStringOrNull(attrs, "withdrawal_reason") ?? null;
  if (reason === null) {
    throw new BadRequestError(
      "withdrawal_reason is required.",
      { pointer: "/data/attributes/withdrawal_reason" },
    );
  }
  const row = await withdrawBenchmark(c.env.DB, existing.id, Date.now(), reason);
  return resourceResponse(serializeBenchmark(row as BenchmarkRow));
});
