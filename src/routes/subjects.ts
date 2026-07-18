import { Hono, type Context } from "hono";
import { emitAuditEvent, listHistoryEvents } from "../audit/smpl_audit";
import { covers, isPublicStatus, requireWrite } from "../authz";
import { getBenchmarkById } from "../data/benchmarks";
import { isSubjectPublic, subjectHasFrozenBenchmark, subjectHasNonPrivateBenchmark } from "../data/benchmark_subjects";
import { LIMITS } from "../limits";
import {
  countSubjectsForAccount,
  createSubject,
  deleteSubjectCascade,
  listAccountSubjects,
  listSubjectsForBenchmark,
  resolveOwnedSubject,
  resolveSubjectForRead,
  subjectKeyExists,
  updateSubject,
  type SubjectRowWithType,
} from "../data/subjects";
import { getSubjectTypeById, resolveOwnedSubjectType } from "../data/subject_types";
import { ConflictError, NotFoundError } from "../errors";
import { requireString } from "../http/body";
import { canonical } from "../schema/measurement_schema";
import { kebab, parseStoredFieldDefs, validateSubjectValues } from "../schema/subject_type";
import { collectionResponse, noContentResponse, resourceResponse } from "../http/jsonapi";
import {
  getAuth,
  getOptionalAuth,
  optionalAuth,
  requireAuth,
  type AppBindings,
} from "../http/middleware";
import { paginationMeta } from "../query/pagination";
import { serializeHistoryEvent, serializeSubject } from "../serialize/resource";
import type { SubjectRow } from "../types";
import { readAttributes, readPagination, readSort } from "./shared";

const SORT_ALLOWED = ["name", "key", "created_at", "updated_at"] as const;

export const subjects = new Hono<AppBindings>();

/** Load an account-owned subject the caller may mutate, or 404 (existence not leaked to a non-owner). */
async function loadOwned(c: Context<AppBindings>, idOrKey: string): Promise<SubjectRow> {
  const auth = getAuth(c);
  requireWrite(auth); // loadOwned backs only mutating handlers.
  // Resolve by the caller's account key first, then the raw UUID (legacy path). Authorization is
  // unchanged: a subject is account-owned, so only an ACCOUNT-authority credential in its tenant
  // covers it (a benchmark/run-scoped key can't reach across the account's shared subject namespace).
  const subject = await resolveOwnedSubject(c.env.DB, auth.account_id, idOrKey);
  if (!subject || !covers(auth, { account_id: subject.account_id })) {
    throw new NotFoundError();
  }
  return subject;
}

/** Resolve the subject key: use the supplied one, or auto-generate a unique kebab key from the name. */
async function resolveSubjectKey(
  db: D1Database,
  accountId: string,
  attrs: Record<string, unknown>,
  name: string,
): Promise<string> {
  if (typeof attrs.key === "string" && attrs.key.trim().length > 0) {
    return requireString(attrs, "key", LIMITS.keyLength);
  }
  const base = kebab(name) || "subject";
  if (!(await subjectKeyExists(db, accountId, base))) return base;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base}-${i}`;
    if (!(await subjectKeyExists(db, accountId, candidate))) return candidate;
  }
  return `${base}-${crypto.randomUUID().slice(0, 8)}`;
}

/**
 * The draft-freeze reaches a shared subject through any benchmark that's marked ready (PRIVATE &&
 * draft=0): while frozen, its name/details can't change and it can't be deleted (§2).
 */
async function assertSubjectNotFrozen(c: Context<AppBindings>, subjectId: string): Promise<void> {
  if (await subjectHasFrozenBenchmark(c.env.DB, subjectId)) {
    throw new ConflictError(
      "This subject is linked to a benchmark that is marked ready for publishing; return it to draft to make changes.",
    );
  }
}

// Create a standalone, account-owned subject. It is not tied to any benchmark here — link it with
// POST /benchmark_subjects. Pick-or-create in the console reuses an existing subject (matched by key)
// rather than calling this when one already exists.
subjects.post("/", requireAuth, async (c) => {
  const auth = getAuth(c);
  requireWrite(auth);
  // A subject belongs to the caller's account; only ACCOUNT authority may mint one.
  if (!covers(auth, { account_id: auth.account_id })) {
    throw new NotFoundError();
  }
  const attrs = await readAttributes(c);
  const name = requireString(attrs, "name", LIMITS.nameLength);
  // The key is optional: when omitted it's auto-generated from the name (unique within the account).
  const key = await resolveSubjectKey(c.env.DB, auth.account_id, attrs, name);
  // Every subject picks a subject_type; its details are validated against that type's fields. The
  // reference may be the subject type's key (its public id) or a raw UUID (legacy path).
  const subjectTypeRef = requireString(attrs, "subject_type");
  const type = await resolveOwnedSubjectType(c.env.DB, auth.account_id, subjectTypeRef);
  if (!type || type.account_id !== auth.account_id) {
    throw new NotFoundError("No such subject type in this account.");
  }
  const details = validateSubjectValues(parseStoredFieldDefs(type.fields), "details" in attrs ? attrs.details : null);
  if ((await countSubjectsForAccount(c.env.DB, auth.account_id)) >= LIMITS.subjectsPerAccount) {
    throw new ConflictError(
      `This account has reached the limit of ${LIMITS.subjectsPerAccount} subjects.`,
    );
  }
  const row = await createSubject(c.env.DB, {
    account_id: auth.account_id,
    subject_type_id: type.id,
    key,
    name,
    details,
  });
  // Subjects are account-level (shared across benchmarks), so their events carry no benchmark
  // correlation and stay internal — the public History is benchmark-scoped.
  emitAuditEvent(c, {
    event_type: "subject.created",
    resource_type: "subject",
    resource_id: row.id,
    visibility: "internal",
    description: `Subject "${name}" created.`,
    actor: auth,
  });
  // createSubject builds the row in-memory (no join), so supply the resolved type's key for the wire.
  return resourceResponse(serializeSubject({ ...row, subject_type_key: type.key }), { status: 201 });
});

subjects.get("/", optionalAuth, async (c) => {
  const auth = getOptionalAuth(c);
  const benchmarkId = c.req.query("filter[benchmark]");
  const pagination = readPagination(c);
  const sort = readSort(c, "created_at", SORT_ALLOWED);
  const filterKey = c.req.query("filter[key]");

  if (benchmarkId !== undefined) {
    // Scoped to a benchmark: the subjects linked to it (public benchmark ⇒ world-visible).
    const benchmark = await getBenchmarkById(c.env.DB, benchmarkId);
    if (!benchmark) throw new NotFoundError();
    if (!isPublicStatus(benchmark.status)) {
      if (!auth || !covers(auth, { account_id: benchmark.account_id, benchmark_id: benchmark.id })) {
        throw new NotFoundError();
      }
    }
    const { rows, total } = await listSubjectsForBenchmark(c.env.DB, {
      benchmarkId,
      filterKey,
      sort,
      limit: pagination.limit,
      offset: pagination.offset,
      includeTotal: pagination.includeTotal,
    });
    return collectionResponse(rows.map(serializeSubject), {
      meta: { pagination: paginationMeta(pagination, total) },
    });
  }

  // Unscoped: the caller's own account subjects (auth required — an anonymous list must scope to a
  // benchmark). No cross-account listing exists; tenant isolation is the floor.
  if (!auth) throw new NotFoundError();
  // filter[subject_type] may be the subject type's key or a raw UUID; resolve it to the internal UUID
  // the column stores. An unresolved (unknown or cross-account) reference falls through as-is, which
  // matches no owned subject — the existing "no matches" behavior, with no existence leak.
  const subjectTypeRef = c.req.query("filter[subject_type]");
  let filterSubjectTypeId = subjectTypeRef;
  if (subjectTypeRef !== undefined) {
    const type = await resolveOwnedSubjectType(c.env.DB, auth.account_id, subjectTypeRef);
    if (type && type.account_id === auth.account_id) filterSubjectTypeId = type.id;
  }
  const { rows, total } = await listAccountSubjects(c.env.DB, {
    accountId: auth.account_id,
    filterKey,
    filterSubjectTypeId,
    sort,
    limit: pagination.limit,
    offset: pagination.offset,
    includeTotal: pagination.includeTotal,
  });
  return collectionResponse(rows.map(serializeSubject), {
    meta: { pagination: paginationMeta(pagination, total) },
  });
});

subjects.get("/:id", optionalAuth, async (c) => {
  const auth = getOptionalAuth(c);
  const subject = await resolveSubjectForRead(c.env.DB, auth?.account_id ?? null, c.req.param("id"));
  if (!subject) throw new NotFoundError();
  // Visible if the caller covers the owning account, or the subject is linked to a public benchmark.
  const covered = auth !== undefined && covers(auth, { account_id: subject.account_id });
  if (!covered && !(await isSubjectPublic(c.env.DB, subject.id))) {
    throw new NotFoundError();
  }
  return resourceResponse(serializeSubject(subject));
});

subjects.put("/:id", requireAuth, async (c) => {
  const auth = getAuth(c);
  const subject = await loadOwned(c, c.req.param("id"));
  await assertSubjectNotFrozen(c, subject.id);
  const attrs = await readAttributes(c);
  const name = requireString(attrs, "name", LIMITS.nameLength);
  // The subject_type is fixed at creation; validate the new details against it.
  const type = subject.subject_type_id ? await getSubjectTypeById(c.env.DB, subject.subject_type_id) : null;
  const details = validateSubjectValues(
    type ? parseStoredFieldDefs(type.fields) : [],
    "details" in attrs ? attrs.details : null,
  );
  const row = await updateSubject(c.env.DB, subject.id, { name, details });

  const changes: Record<string, { before: unknown; after: unknown }> = {};
  if (subject.name !== name) changes.name = { before: subject.name, after: name };
  const oldDetails = subject.details === null ? null : JSON.parse(subject.details);
  // canonical(): key-order-only differences are not changes (no spurious "edited" events).
  if (canonical(oldDetails) !== canonical(details)) {
    changes.details = { before: oldDetails, after: details };
  }
  if (Object.keys(changes).length > 0) {
    emitAuditEvent(c, {
      event_type: "subject.edited",
      resource_type: "subject",
      resource_id: subject.id,
      visibility: "internal",
      description: `Subject "${name}" edited.`,
      changes,
      actor: auth,
    });
  }
  return resourceResponse(serializeSubject(row as SubjectRowWithType));
});

// The subject's own audit trail (console detail page). Subject events are account-level and
// internal, so this is a covered-caller surface; an uncovered caller on a publicly-linked subject
// gets the public filter, which for subjects yields nothing rather than a leak.
subjects.get("/:id/history", optionalAuth, async (c) => {
  const auth = getOptionalAuth(c);
  const subject = await resolveSubjectForRead(c.env.DB, auth?.account_id ?? null, c.req.param("id"));
  if (!subject) throw new NotFoundError();
  const covered = auth !== undefined && covers(auth, { account_id: subject.account_id });
  if (!covered && !(await isSubjectPublic(c.env.DB, subject.id))) {
    throw new NotFoundError();
  }
  const events = await listHistoryEvents(c.env, { resource_type: "subject", resource_id: subject.id });
  const visible = covered ? events : events.filter((e) => e.visibility === "public");
  const redact = covered ? null : { publisher_label: "the publisher" };
  return collectionResponse(
    visible.map((e) => serializeHistoryEvent(e, redact)),
    { meta: { count: visible.length } },
  );
});

subjects.delete("/:id", requireAuth, async (c) => {
  const subject = await loadOwned(c, c.req.param("id"));
  // A marked-ready benchmark freezes its whole subtree; a published/withdrawn one holds frozen,
  // append-only data. Either way the subject (and the measurements the delete would cascade) is
  // protected until it's returned to draft / unlinked from every non-draft home.
  await assertSubjectNotFrozen(c, subject.id);
  if (await subjectHasNonPrivateBenchmark(c.env.DB, subject.id)) {
    throw new ConflictError(
      "This subject is linked to a published benchmark; unlink it there before deleting.",
    );
  }
  await deleteSubjectCascade(c.env.DB, subject.id);
  return noContentResponse();
});
