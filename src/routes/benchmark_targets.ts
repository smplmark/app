import { Hono } from "hono";
import { covers, isPublicStatus, requireWrite } from "../authz";
import { getBenchmarkById } from "../data/benchmarks";
import {
  countLinksForBenchmark,
  createBenchmarkTarget,
  deleteBenchmarkTargetCascade,
  getBenchmarkTargetById,
  isTargetPublic,
  listBenchmarkTargets,
} from "../data/benchmark_targets";
import { getTargetById } from "../data/targets";
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
import { serializeBenchmarkTarget } from "../serialize/resource";
import { assertBenchmarkEditable, readAttributes, readPagination, readSort } from "./shared";

const SORT_ALLOWED = ["created_at"] as const;

export const benchmarkTargets = new Hono<AppBindings>();

// Link an existing account-owned target into a benchmark (M:N membership). Adding a target is an
// append, so it's allowed while a benchmark is editable or already published — but not while it's
// marked-ready or closed. The target must belong to the benchmark's account.
benchmarkTargets.post("/", requireAuth, async (c) => {
  const auth = getAuth(c);
  requireWrite(auth);
  const attrs = await readAttributes(c);
  const benchmarkId = requireString(attrs, "benchmark");
  const targetId = requireString(attrs, "target");

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
    throw new ConflictError("This benchmark is closed; no new targets can be added.");
  }
  // Resolve the target only after the benchmark is covered. A missing target and a target in another
  // account are rejected identically (same 409) so neither leaks whether a foreign id exists.
  const target = await getTargetById(c.env.DB, targetId);
  if (!target || target.account_id !== benchmark.account_id) {
    throw new ConflictError("The target does not belong to this benchmark's account.");
  }
  if ((await countLinksForBenchmark(c.env.DB, benchmark.id)) >= LIMITS.targetsPerBenchmark) {
    throw new ConflictError(
      `This benchmark has reached the limit of ${LIMITS.targetsPerBenchmark} targets.`,
    );
  }
  const row = await createBenchmarkTarget(c.env.DB, {
    benchmark_id: benchmark.id,
    target_id: target.id,
  });
  return resourceResponse(serializeBenchmarkTarget(row), { status: 201 });
});

benchmarkTargets.get("/", optionalAuth, async (c) => {
  const auth = getOptionalAuth(c);
  const benchmarkId = c.req.query("filter[benchmark]");
  const targetId = c.req.query("filter[target]");
  if (benchmarkId === undefined && targetId === undefined) {
    throw new NotFoundError(); // must be scoped to a benchmark or a target
  }

  // Visibility resolves off whichever scope anchors the query. When the anchor is a (shared) target
  // and the caller can't cover its account, only its links to PUBLISHED/WITHDRAWN benchmarks are
  // visible — a private benchmark's id must not leak through the target's link rows.
  let publicOnly = false;
  if (benchmarkId !== undefined) {
    const benchmark = await getBenchmarkById(c.env.DB, benchmarkId);
    if (!benchmark) throw new NotFoundError();
    if (!isPublicStatus(benchmark.status)) {
      if (!auth || !covers(auth, { account_id: benchmark.account_id, benchmark_id: benchmark.id })) {
        throw new NotFoundError();
      }
    }
  } else if (targetId !== undefined) {
    const target = await getTargetById(c.env.DB, targetId);
    if (!target) throw new NotFoundError();
    const covered = auth !== undefined && covers(auth, { account_id: target.account_id });
    if (!covered && !(await isTargetPublic(c.env.DB, target.id))) {
      throw new NotFoundError();
    }
    publicOnly = !covered;
  }

  const pagination = readPagination(c);
  const sort = readSort(c, "created_at", SORT_ALLOWED);
  const { rows, total } = await listBenchmarkTargets(c.env.DB, {
    benchmarkId,
    targetId,
    publicOnly,
    sort,
    limit: pagination.limit,
    offset: pagination.offset,
    includeTotal: pagination.includeTotal,
  });
  return collectionResponse(rows.map(serializeBenchmarkTarget), {
    meta: { pagination: paginationMeta(pagination, total) },
  });
});

// Unlink a target from a benchmark. Removal is not an append, so — like deleting a target — it's only
// allowed while the benchmark is PRIVATE; a published benchmark's target set is frozen.
benchmarkTargets.delete("/:id", requireAuth, async (c) => {
  const auth = getAuth(c);
  requireWrite(auth);
  const link = await getBenchmarkTargetById(c.env.DB, c.req.param("id"));
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
      "Published benchmark data is append-only; a target cannot be unlinked.",
    );
  }
  await deleteBenchmarkTargetCascade(c.env.DB, link);
  return noContentResponse();
});
