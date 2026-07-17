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
  type BenchmarkRowWithPublisher,
  benchmarkKeyExists,
  countBenchmarksForAccount,
  createBenchmark,
  setBenchmarkClosed,
  deleteBenchmarkCascade,
  getBenchmarkById,
  listBenchmarks,
  publishBenchmark,
  refreshBenchmarkSearchText,
  setBenchmarkDraft,
  updateBenchmark,
  withdrawBenchmark,
} from "../data/benchmarks";
import { recordBenchmarkView } from "../data/views";
import { LIMITS } from "../limits";
import { getPublisherById } from "../data/publishers";
import {
  listTagsForBenchmark,
  listTagsForBenchmarks,
  normalizeTagKey,
  optionalTags,
  setBenchmarkTags,
} from "../data/tags";
import { countLinksForBenchmark } from "../data/benchmark_subjects";
import { countRunsForBenchmark } from "../data/runs";
import { benchmarkHasMeasurements } from "../data/measurements";
import { getSubjectTypeById } from "../data/subject_types";
import { getUserById } from "../data/users";
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from "../errors";
import {
  optionalEnum,
  optionalStringOrNull,
  requireString,
} from "../http/body";
import { collectionResponse, noContentResponse, resourceResponse } from "../http/jsonapi";
import { getAuth, getOptionalAuth, optionalAuth, requireAuth, type AppBindings } from "../http/middleware";
import { paginationMeta } from "../query/pagination";
import { parseSearchQuery } from "../query/search";
import { emitAuditEvent, listHistoryEvents } from "../audit/smpl_audit";
import {
  canonical,
  diffMeasurementSchema,
  parseMeasurementSchema,
  validateMeasurementSchema,
} from "../schema/measurement_schema";
import { kebab } from "../schema/subject_type";
import { publisherLabel, serializeBenchmark, serializeHistoryEvent } from "../serialize/resource";
import {
  CATEGORIES,
  type AuthContext,
  type BenchmarkRow,
  type Category,
  type OrgAttributionSnapshot,
  type PersonalAttributionSnapshot,
  type MeasurementSchema,
  type Status,
} from "../types";
import { assertBenchmarkEditable, readAttributes, readPagination, readSort } from "./shared";

const EMPTY_SCHEMA: MeasurementSchema = { metrics: [], derived: [] };

/** A benchmark compares like against like: `subject_type` is required and must name a subject type in
 *  the caller's account. Returns the validated id. */
async function requireSubjectType(db: D1Database, accountId: string, attrs: Record<string, unknown>): Promise<string> {
  const id = requireString(attrs, "subject_type");
  const type = await getSubjectTypeById(db, id);
  if (!type || type.account_id !== accountId) {
    throw new BadRequestError("subject_type must name a subject type in this account.");
  }
  return id;
}
const PUBLIC_STATUSES: Status[] = ["PUBLISHED", "WITHDRAWN"];
const SORT_ALLOWED = [
  "name",
  "created_at",
  "updated_at",
  "published_at",
  // Popularity: all-time, plus rolling windows over the per-day view buckets.
  "views",
  "views_today",
  "views_week",
  "views_month",
  "views_year",
] as const;

/** filter[category]: SCREAMING_SNAKE_CASE enum, case-insensitive on input (ADR-014). */
function readCategoryFilter(value: string | undefined): Category | undefined {
  if (value === undefined) return undefined;
  const normalized = value.toUpperCase();
  if ((CATEGORIES as readonly string[]).includes(normalized)) {
    return normalized as Category;
  }
  throw new BadRequestError(
    `filter[category] must be one of: ${CATEGORIES.join(", ")}.`,
  );
}

export const benchmarks = new Hono<AppBindings>();

/** Load a benchmark or 404; enforce that the credential covers it (else 404 — no existence leak). */
async function loadOwned(c: Context<AppBindings>, id: string): Promise<BenchmarkRowWithPublisher> {
  const auth = getAuth(c);
  requireWrite(auth); // loadOwned backs only mutating handlers — gate viewers here.
  const row = await getBenchmarkById(c.env.DB, id);
  if (!row || !covers(auth, { account_id: row.account_id, benchmark_id: row.id })) {
    throw new NotFoundError();
  }
  return row;
}

/** Resolve the benchmark key: use the supplied one, or auto-generate a unique kebab key from the name. */
async function resolveBenchmarkKey(
  db: D1Database,
  accountId: string,
  attrs: Record<string, unknown>,
  name: string,
): Promise<string> {
  if (typeof attrs.key === "string" && attrs.key.trim().length > 0) {
    return requireString(attrs, "key", LIMITS.keyLength);
  }
  const base = kebab(name) || "benchmark";
  if (!(await benchmarkKeyExists(db, accountId, base))) return base;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base}-${i}`;
    if (!(await benchmarkKeyExists(db, accountId, candidate))) return candidate;
  }
  return `${base}-${crypto.randomUUID().slice(0, 8)}`;
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
  const name = requireString(attrs, "name", LIMITS.nameLength);
  // The key is optional: when omitted it's auto-generated from the name (unique within the account).
  const key = await resolveBenchmarkKey(c.env.DB, auth.account_id, attrs, name);
  const description = optionalStringOrNull(attrs, "description", LIMITS.descriptionLength) ?? null;
  const about = optionalStringOrNull(attrs, "about", LIMITS.longTextLength) ?? null;
  const methodology = optionalStringOrNull(attrs, "methodology", LIMITS.longTextLength) ?? null;
  const subject_type = await requireSubjectType(c.env.DB, auth.account_id, attrs);
  const measurement_schema =
    "measurement_schema" in attrs ? validateMeasurementSchema(attrs.measurement_schema) : EMPTY_SCHEMA;
  const category = optionalEnum(attrs, "category", CATEGORIES) ?? "OTHER";
  const tags = optionalTags(attrs) ?? [];

  if ((await countBenchmarksForAccount(c.env.DB, auth.account_id)) >= LIMITS.benchmarksPerAccount) {
    throw new ConflictError(
      `This account has reached the limit of ${LIMITS.benchmarksPerAccount} benchmarks.`,
    );
  }

  const row = await createBenchmark(c.env.DB, {
    account_id: auth.account_id,
    key,
    name,
    description,
    about,
    methodology,
    subject_type,
    measurement_schema,
    category,
    created_by_user_id: auth.user_id, // null when an API key creates it
  });
  if (tags.length > 0) await setBenchmarkTags(c.env.DB, row.id, tags);
  await refreshBenchmarkSearchText(c.env.DB, row.id);
  emitAuditEvent(c, {
    event_type: "benchmark.created",
    resource_type: "benchmark",
    resource_id: row.id,
    benchmark_id: row.id,
    visibility: "internal",
    description: `Benchmark "${name}" created.`,
    actor: auth,
  });
  return resourceResponse(serializeBenchmark(row, tags), { status: 201 });
});

benchmarks.get("/", optionalAuth, async (c) => {
  const auth = getOptionalAuth(c);
  const pagination = readPagination(c);
  const sort = readSort(c, "-created_at", SORT_ALLOWED);
  const filterAccount = c.req.query("filter[account]");
  const filterPublisher = c.req.query("filter[publisher]");
  const filterKey = c.req.query("filter[key]");
  const filterTag = c.req.query("filter[tag]");
  const filterCategory = readCategoryFilter(c.req.query("filter[category]"));
  const filterSearch = c.req.query("filter[search]");
  const searchTerms = filterSearch !== undefined ? parseSearchQuery(filterSearch) : undefined;

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
    publisherSlug: filterPublisher,
    filterKey,
    tag: filterTag !== undefined ? normalizeTagKey(filterTag) : undefined,
    category: filterCategory,
    searchTerms: searchTerms !== undefined && searchTerms.length > 0 ? searchTerms : undefined,
    sort,
    limit: pagination.limit,
    offset: pagination.offset,
    includeTotal: pagination.includeTotal,
  });
  const tagsByBenchmark = await listTagsForBenchmarks(
    c.env.DB,
    rows.map((r) => r.id),
  );
  return collectionResponse(
    rows.map((r) => serializeBenchmark(r, tagsByBenchmark.get(r.id) ?? [])),
    { meta: { pagination: paginationMeta(pagination, total) } },
  );
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
  return resourceResponse(
    serializeBenchmark(row, await listTagsForBenchmark(c.env.DB, row.id)),
  );
});

benchmarks.put("/:id", requireAuth, async (c) => {
  const auth = getAuth(c);
  const existing = await loadOwned(c, c.req.param("id"));
  assertBenchmarkEditable(existing); // marked-ready subtree is frozen until publish/return-to-draft
  const attrs = await readAttributes(c);
  const name = requireString(attrs, "name", LIMITS.nameLength);
  const description = optionalStringOrNull(attrs, "description", LIMITS.descriptionLength) ?? null;
  const about = optionalStringOrNull(attrs, "about", LIMITS.longTextLength) ?? null;
  const methodology = optionalStringOrNull(attrs, "methodology", LIMITS.longTextLength) ?? null;
  const subject_type = await requireSubjectType(c.env.DB, existing.account_id, attrs);
  // The subject type is fixed while subjects are linked — they conform to it. (Setting it on a
  // pre-0023 row that never had one is fine; that's the null → value transition.)
  if (subject_type !== existing.subject_type && existing.subject_type !== null) {
    if ((await countLinksForBenchmark(c.env.DB, existing.id)) > 0) {
      throw new ConflictError("The subject type can't change while subjects are linked; unlink them first.");
    }
  }
  const measurement_schema =
    "measurement_schema" in attrs ? validateMeasurementSchema(attrs.measurement_schema) : EMPTY_SCHEMA;
  // Full-replace semantics, like measurement_schema: absent → the defaults, not "keep".
  const category = optionalEnum(attrs, "category", CATEGORIES) ?? "OTHER";
  const tags = optionalTags(attrs) ?? [];

  // A published benchmark is editable — the record is auditable, not frozen. Diff the old row
  // against the incoming full-replace so the audit event can say exactly what changed (and flag a
  // semantic-core change: metric set, derived expressions, chart/axis mapping).
  const oldSchema = parseMeasurementSchema(existing.measurement_schema);
  const schemaDiff = diffMeasurementSchema(oldSchema, measurement_schema);
  const oldTags = await listTagsForBenchmark(c.env.DB, existing.id);
  const changes: Record<string, { before: unknown; after: unknown }> = {};
  const scalarFields: [string, unknown, unknown][] = [
    ["name", existing.name, name],
    ["description", existing.description, description],
    ["about", existing.about, about],
    ["methodology", existing.methodology, methodology],
    ["subject_type", existing.subject_type, subject_type],
    ["category", existing.category, category],
  ];
  for (const [field, before, after] of scalarFields) {
    if (before !== after) changes[field] = { before, after };
  }
  if (schemaDiff.changed) {
    changes.measurement_schema = { before: oldSchema, after: measurement_schema };
  }
  if (canonical([...oldTags].sort()) !== canonical([...tags].sort())) {
    changes.tags = { before: oldTags, after: tags };
  }

  const row = await updateBenchmark(c.env.DB, existing.id, {
    name,
    description,
    about,
    methodology,
    subject_type,
    measurement_schema,
    category,
  });
  await setBenchmarkTags(c.env.DB, existing.id, tags);
  await refreshBenchmarkSearchText(c.env.DB, existing.id);
  if (Object.keys(changes).length > 0) {
    emitAuditEvent(c, {
      event_type: "benchmark.edited",
      resource_type: "benchmark",
      resource_id: existing.id,
      benchmark_id: existing.id,
      // Post-publish edits are part of the public record; draft edits are console-only history.
      visibility: existing.status === "PRIVATE" ? "internal" : "public",
      description: schemaDiff.semantic_core
        ? "Benchmark edited (semantic core changed: metrics, derived expressions, or chart mapping)."
        : "Benchmark edited.",
      changes,
      semantic_core: schemaDiff.semantic_core,
      actor: auth,
    });
  }
  return resourceResponse(serializeBenchmark(row as BenchmarkRowWithPublisher, tags));
});

// Delete a benchmark. A PRIVATE benchmark hard-deletes freely; a published (or withdrawn) one never
// does — a public record must not silently vanish, which is the one mutation an audit trail cannot
// cover. The publisher's exit is withdrawal (a visible tombstone); true removal is an operator-only
// takedown (see routes/jobs.ts), reachable via a takedown request.
benchmarks.delete("/:id", requireAuth, async (c) => {
  const existing = await loadOwned(c, c.req.param("id"));
  assertBenchmarkEditable(existing); // can't delete out of the marked-ready state
  if (existing.status !== "PRIVATE") {
    throw new ConflictError(
      "A published benchmark can't be deleted — the public record must not vanish. Withdraw it instead, or request a takedown for true removal.",
    );
  }
  await deleteBenchmarkCascade(c.env.DB, existing.id);
  return noContentResponse();
});

// ── History (the audit trail) ────────────────────────────────────────────────

// The benchmark's full change history — its own events plus its whole subtree (runs,
// measurements), correlated in Smpl Audit by benchmark id. Three views from one endpoint:
//  - an ACCOUNT-authority caller (a session or account-scoped key) sees every event with real
//    actors;
//  - a covered narrower credential (a BENCHMARK-scoped key) sees every event but with the actor
//    redacted — member emails and user ids are account-level data a scoped key is denied
//    everywhere else (cf. the member-roster gate in routes/account_users.ts);
//  - anyone else sees a world-visible benchmark's PUBLIC events only, with the actor redacted to
//    the publisher identity (never an individual email or user id) — the credibility surface.
benchmarks.get("/:id/history", optionalAuth, async (c) => {
  const auth = getOptionalAuth(c);
  const row = await getBenchmarkById(c.env.DB, c.req.param("id"));
  if (!row) throw new NotFoundError();
  const covered = auth !== undefined && covers(auth, { account_id: row.account_id, benchmark_id: row.id });
  if (!covered && !isPublicStatus(row.status)) throw new NotFoundError();
  const fullActors = covered && auth !== undefined && auth.scope_type === "ACCOUNT";
  const events = await listHistoryEvents(c.env, { benchmark_id: row.id });
  const visible = covered ? events : events.filter((e) => e.visibility === "public");
  const redact = fullActors ? null : { publisher_label: publisherLabel(row) };
  return collectionResponse(
    visible.map((e) => serializeHistoryEvent(e, redact)),
    { meta: { count: visible.length } },
  );
});

// ── Popularity ───────────────────────────────────────────────────────────────

// The view beacon: the public benchmark page fires this once per load. Unauthenticated,
// fire-and-forget, best-effort by design — a raw view count, not an audited metric. Only
// world-visible benchmarks count (private ones 404 without leaking existence).
benchmarks.post("/:id/actions/view", async (c) => {
  const row = await getBenchmarkById(c.env.DB, c.req.param("id"));
  if (!row || !isPublicStatus(row.status)) throw new NotFoundError();
  await recordBenchmarkView(c.env.DB, row.id);
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
  return resourceResponse(
    serializeBenchmark(row as BenchmarkRowWithPublisher, await listTagsForBenchmark(c.env.DB, existing.id)),
  );
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
    serializeBenchmark(row as BenchmarkRowWithPublisher, await listTagsForBenchmark(c.env.DB, existing.id)),
    reason !== null ? { meta: { reason } } : {},
  );
});

// ── Close / reopen ───────────────────────────────────────────────────────────
// The publisher's reversible "complete" signal: a closed benchmark accepts no new subjects, runs,
// or measurements. History stays append-only either way — closing is a lifecycle signal, not a
// credibility invariant, which is why reopening is allowed (any sequence of close/reopen/append is
// inherently visible in the measurements' timestamps).

benchmarks.post("/:id/actions/close", requireAuth, async (c) => {
  const auth = getAuth(c);
  const existing = await loadOwned(c, c.req.param("id"));
  assertCanManageDraft(auth, existing);
  if (existing.closed_at !== null) {
    throw new ConflictError("This benchmark is already closed.");
  }
  const row = await setBenchmarkClosed(c.env.DB, existing.id, Date.now());
  // Closing is a lifecycle signal, not a credibility invariant — but it's world-visible state on
  // a published benchmark, so a close/reopen/append sequence must be reconstructible from the
  // History, not just from measurement timestamps.
  emitAuditEvent(c, {
    event_type: "benchmark.closed",
    resource_type: "benchmark",
    resource_id: existing.id,
    benchmark_id: existing.id,
    visibility: existing.status === "PRIVATE" ? "internal" : "public",
    description: "Benchmark closed to new data.",
    actor: auth,
  });
  return resourceResponse(
    serializeBenchmark(row as BenchmarkRowWithPublisher, await listTagsForBenchmark(c.env.DB, existing.id)),
  );
});

benchmarks.post("/:id/actions/reopen", requireAuth, async (c) => {
  const auth = getAuth(c);
  const existing = await loadOwned(c, c.req.param("id"));
  assertCanManageDraft(auth, existing);
  if (existing.closed_at === null) {
    throw new ConflictError("This benchmark is not closed.");
  }
  const row = await setBenchmarkClosed(c.env.DB, existing.id, null);
  emitAuditEvent(c, {
    event_type: "benchmark.reopened",
    resource_type: "benchmark",
    resource_id: existing.id,
    benchmark_id: existing.id,
    visibility: existing.status === "PRIVATE" ? "internal" : "public",
    description: "Benchmark reopened to new data.",
    actor: auth,
  });
  return resourceResponse(
    serializeBenchmark(row as BenchmarkRowWithPublisher, await listTagsForBenchmark(c.env.DB, existing.id)),
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
  if (!(await accountHasVerifiedUser(c.env.DB, existing.account_id))) {
    throw new ForbiddenError("Verify your email address before publishing a benchmark.");
  }
  // A published benchmark is a finished dataset: it must actually compare something (subjects) on
  // something (metrics) with evidence (runs carrying measurements) before it can go public.
  const missing: string[] = [];
  const schema = parseMeasurementSchema(existing.measurement_schema);
  if ((await countLinksForBenchmark(c.env.DB, existing.id)) === 0) missing.push("one subject");
  if (schema.metrics.length + schema.derived.length === 0) missing.push("one metric");
  if ((await countRunsForBenchmark(c.env.DB, existing.id)) === 0) missing.push("one run");
  if (!(await benchmarkHasMeasurements(c.env.DB, existing.id))) missing.push("one measurement");
  if (missing.length > 0) {
    const list =
      missing.length === 1
        ? missing[0]
        : missing.slice(0, -1).join(", ") + " and " + missing[missing.length - 1];
    throw new ConflictError(
      `This benchmark isn't ready to publish — it needs at least ${list}.`,
    );
  }

  const attrs = await readAttributes(c).catch(() => ({}) as Record<string, unknown>);
  const publisherRef = optionalStringOrNull(attrs, "publisher") ?? null;
  const now = Date.now();

  // ORGANIZATION publish — a verified publisher (domain) is named (and isn't the "self" sentinel).
  if (publisherRef !== null && publisherRef !== "self") {
    if (!canPublishOrg(auth)) throw new ForbiddenError(RBAC_REASONS.publishOrg);
    const publisher = await getPublisherById(c.env.DB, publisherRef);
    if (!publisher || publisher.account_id !== existing.account_id) throw new NotFoundError();
    if (publisher.status !== "VERIFIED") {
      throw new ConflictError("This publisher's domain is not verified.");
    }
    const snapshot: OrgAttributionSnapshot = {
      domain: publisher.domain,
      icon: publisher.icon,
    };
    const row = await publishBenchmark(c.env.DB, existing.id, now, {
      published_by_user_id: auth.user_id,
      published_as_kind: "ORGANIZATION",
      published_identity_id: publisher.id,
      attribution_snapshot: JSON.stringify(snapshot),
    });
    emitAuditEvent(c, {
      event_type: "benchmark.published",
      resource_type: "benchmark",
      resource_id: existing.id,
      benchmark_id: existing.id,
      visibility: "public",
      description: `Benchmark published as ${publisher.domain}.`,
      extra: { published_as_kind: "ORGANIZATION", attribution: snapshot },
      actor: auth,
    });
    return resourceResponse(
      serializeBenchmark(row as BenchmarkRowWithPublisher, await listTagsForBenchmark(c.env.DB, existing.id)),
    );
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
  emitAuditEvent(c, {
    event_type: "benchmark.published",
    resource_type: "benchmark",
    resource_id: existing.id,
    benchmark_id: existing.id,
    visibility: "public",
    description: `Benchmark published as ${snapshot.display_name ?? "a personal publisher"}.`,
    extra: { published_as_kind: "PERSONAL", attribution: { display_name: snapshot.display_name } },
    actor: auth,
  });
  return resourceResponse(
    serializeBenchmark(row as BenchmarkRowWithPublisher, await listTagsForBenchmark(c.env.DB, existing.id)),
  );
});

benchmarks.post("/:id/actions/withdraw", requireAuth, async (c) => {
  const auth = getAuth(c);
  const existing = await loadOwned(c, c.req.param("id"));
  if (auth.source !== "SESSION") throw new ForbiddenError(RBAC_REASONS.withdrawSession);
  if (existing.status !== "PUBLISHED") {
    throw new ConflictError("Only a published benchmark can be withdrawn.");
  }
  // Withdraw authority mirrors the publish attribution. INGESTED benchmarks (importer-seeded,
  // owned by the member-less system account) take the admin rule — in practice the importer
  // removes them; no session can ever pass this gate for the system account.
  if (
    existing.published_as_kind === "ORGANIZATION" ||
    existing.published_as_kind === "INGESTED"
  ) {
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
  emitAuditEvent(c, {
    event_type: "benchmark.withdrawn",
    resource_type: "benchmark",
    resource_id: existing.id,
    benchmark_id: existing.id,
    visibility: "public",
    description: "Benchmark withdrawn by its publisher.",
    extra: { reason },
    actor: auth,
  });
  return resourceResponse(
    serializeBenchmark(row as BenchmarkRowWithPublisher, await listTagsForBenchmark(c.env.DB, existing.id)),
  );
});
