import { Hono } from "hono";
import { emitAuditEvent } from "../audit/smpl_audit";
import { covers, isPublicStatus, requireWrite } from "../authz";
import { getBenchmarkById } from "../data/benchmarks";
import {
  countLinksForBenchmark,
  createBenchmarkSubject,
  deleteBenchmarkSubjectCascade,
  getBenchmarkSubjectById,
  isSubjectPublic,
  listBenchmarkSubjects,
} from "../data/benchmark_subjects";
import { getSubjectById } from "../data/subjects";
import { LIMITS } from "../limits";
import { ConflictError, NotFoundError } from "../errors";
import { requireString } from "../http/body";
import { collectionResponse, noContentResponse, resourceResponse } from "../http/jsonapi";
import {
  getAuth,
  getOptionalAuth,
  optionalAuth,
  requireAuth,
  type AppBindings,
} from "../http/middleware";
import { paginationMeta } from "../query/pagination";
import { serializeBenchmarkSubject } from "../serialize/resource";
import { assertBenchmarkEditable, readAttributes, readPagination, readSort } from "./shared";

const SORT_ALLOWED = ["created_at"] as const;

export const benchmarkSubjects = new Hono<AppBindings>();

// Link an existing account-owned subject into a benchmark (M:N membership). Adding a subject is an
// append, so it's allowed while a benchmark is editable or already published — but not while it's
// marked-ready or closed. The subject must belong to the benchmark's account.
benchmarkSubjects.post("/", requireAuth, async (c) => {
  const auth = getAuth(c);
  requireWrite(auth);
  const attrs = await readAttributes(c);
  const benchmarkId = requireString(attrs, "benchmark");
  const subjectId = requireString(attrs, "subject");

  // Authorize the benchmark first (no-leak: an uncovered/foreign benchmark is an indistinguishable 404).
  const benchmark = await getBenchmarkById(c.env.DB, benchmarkId);
  if (
    !benchmark ||
    !covers(auth, { account_id: benchmark.account_id, benchmark_id: benchmark.id })
  ) {
    throw new NotFoundError();
  }
  assertBenchmarkEditable(benchmark);
  if (benchmark.closed_at !== null) {
    throw new ConflictError("This benchmark is closed; no new subjects can be added.");
  }
  // Resolve the subject only after the benchmark is covered. A missing subject and a subject in another
  // account are rejected identically (same 409) so neither leaks whether a foreign id exists.
  const subject = await getSubjectById(c.env.DB, subjectId);
  if (!subject || subject.account_id !== benchmark.account_id) {
    throw new ConflictError("The subject does not belong to this benchmark's account.");
  }
  // A benchmark compares like against like: every linked subject shares the benchmark's subject type.
  if (subject.subject_type_id !== benchmark.subject_type) {
    throw new ConflictError("This benchmark compares subjects of a different type; only subjects of the benchmark's subject type can be linked.");
  }
  if ((await countLinksForBenchmark(c.env.DB, benchmark.id)) >= LIMITS.subjectsPerBenchmark) {
    throw new ConflictError(
      `This benchmark has reached the limit of ${LIMITS.subjectsPerBenchmark} subjects.`,
    );
  }
  const row = await createBenchmarkSubject(c.env.DB, {
    benchmark_id: benchmark.id,
    subject_id: subject.id,
  });
  emitAuditEvent(c, {
    event_type: "benchmark.edited",
    resource_type: "benchmark",
    resource_id: benchmark.id,
    benchmark_id: benchmark.id,
    visibility: benchmark.status === "PRIVATE" ? "internal" : "public",
    description: `Subject "${subject.name}" linked to the benchmark.`,
    extra: { subject_linked: subject.id },
    actor: auth,
  });
  return resourceResponse(serializeBenchmarkSubject(row), { status: 201 });
});

benchmarkSubjects.get("/", optionalAuth, async (c) => {
  const auth = getOptionalAuth(c);
  const benchmarkId = c.req.query("filter[benchmark]");
  const subjectId = c.req.query("filter[subject]");
  if (benchmarkId === undefined && subjectId === undefined) {
    throw new NotFoundError(); // must be scoped to a benchmark or a subject
  }

  // Visibility resolves off whichever scope anchors the query. When the anchor is a (shared) subject
  // and the caller can't cover its account, only its links to PUBLISHED/WITHDRAWN benchmarks are
  // visible — a private benchmark's id must not leak through the subject's link rows.
  let publicOnly = false;
  if (benchmarkId !== undefined) {
    const benchmark = await getBenchmarkById(c.env.DB, benchmarkId);
    if (!benchmark) throw new NotFoundError();
    if (!isPublicStatus(benchmark.status)) {
      if (!auth || !covers(auth, { account_id: benchmark.account_id, benchmark_id: benchmark.id })) {
        throw new NotFoundError();
      }
    }
  } else if (subjectId !== undefined) {
    const subject = await getSubjectById(c.env.DB, subjectId);
    if (!subject) throw new NotFoundError();
    const covered = auth !== undefined && covers(auth, { account_id: subject.account_id });
    if (!covered && !(await isSubjectPublic(c.env.DB, subject.id))) {
      throw new NotFoundError();
    }
    publicOnly = !covered;
  }

  const pagination = readPagination(c);
  const sort = readSort(c, "created_at", SORT_ALLOWED);
  const { rows, total } = await listBenchmarkSubjects(c.env.DB, {
    benchmarkId,
    subjectId,
    publicOnly,
    sort,
    limit: pagination.limit,
    offset: pagination.offset,
    includeTotal: pagination.includeTotal,
  });
  return collectionResponse(rows.map(serializeBenchmarkSubject), {
    meta: { pagination: paginationMeta(pagination, total) },
  });
});

// Unlink a subject from a benchmark. Unlinking cascades away the subject's measurements under this
// benchmark, so on a published benchmark it stays blocked: it would hard-delete published data —
// the one mutation the auditable-record model still forbids. Retract a subject's results visibly
// by invalidating the runs that carry them instead.
benchmarkSubjects.delete("/:id", requireAuth, async (c) => {
  const auth = getAuth(c);
  requireWrite(auth);
  const link = await getBenchmarkSubjectById(c.env.DB, c.req.param("id"));
  if (!link) throw new NotFoundError();
  const benchmark = await getBenchmarkById(c.env.DB, link.benchmark_id);
  if (
    !benchmark ||
    !covers(auth, { account_id: benchmark.account_id, benchmark_id: benchmark.id })
  ) {
    throw new NotFoundError();
  }
  assertBenchmarkEditable(benchmark);
  if (benchmark.status !== "PRIVATE") {
    throw new ConflictError(
      "A published benchmark's subjects can't be unlinked — that would delete their published measurements. Invalidate the affected runs instead.",
    );
  }
  await deleteBenchmarkSubjectCascade(c.env.DB, link);
  return noContentResponse();
});
