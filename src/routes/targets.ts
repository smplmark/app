import { Hono, type Context } from "hono";
import { covers, isPublicStatus, requireWrite } from "../authz";
import { getBenchmarkById } from "../data/benchmarks";
import {
  createTarget,
  deleteTargetCascade,
  getTargetById,
  listTargets,
  updateTarget,
} from "../data/targets";
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
import { serializeTarget } from "../serialize/resource";
import type { BenchmarkRow, TargetRow } from "../types";
import { assertBenchmarkEditable, readAttributes, readPagination, readSort } from "./shared";

const SORT_ALLOWED = ["name", "key", "created_at", "updated_at"] as const;

export const targets = new Hono<AppBindings>();

/** Load a target + its parent benchmark, or 404 (existence not leaked when the cred can't cover it). */
async function loadOwned(
  c: Context<AppBindings>,
  id: string,
): Promise<{ target: TargetRow; benchmark: BenchmarkRow }> {
  const auth = getAuth(c);
  requireWrite(auth); // loadOwned backs only mutating handlers.
  const target = await getTargetById(c.env.DB, id);
  if (!target) throw new NotFoundError();
  const benchmark = await getBenchmarkById(c.env.DB, target.benchmark_id);
  if (
    !benchmark ||
    !covers(auth, {
      account_id: benchmark.account_id,
      benchmark_id: benchmark.id,
      target_id: target.id,
    })
  ) {
    throw new NotFoundError();
  }
  return { target, benchmark };
}

targets.post("/", requireAuth, async (c) => {
  const auth = getAuth(c);
  requireWrite(auth);
  const attrs = await readAttributes(c);
  const benchmarkId = requireString(attrs, "benchmark");
  const benchmark = await getBenchmarkById(c.env.DB, benchmarkId);
  if (
    !benchmark ||
    !covers(auth, { account_id: benchmark.account_id, benchmark_id: benchmark.id })
  ) {
    throw new NotFoundError();
  }
  assertBenchmarkEditable(benchmark);
  const key = requireString(attrs, "key");
  const name = requireString(attrs, "name");
  const details = "details" in attrs ? attrs.details : null;
  const row = await createTarget(c.env.DB, {
    benchmark_id: benchmark.id,
    key,
    name,
    details,
  });
  return resourceResponse(serializeTarget(row), { status: 201 });
});

targets.get("/", optionalAuth, async (c) => {
  const auth = getOptionalAuth(c);
  const benchmarkId = c.req.query("filter[benchmark]");
  if (benchmarkId === undefined) {
    throw new NotFoundError(); // must be scoped to a benchmark
  }
  const benchmark = await getBenchmarkById(c.env.DB, benchmarkId);
  if (!benchmark) throw new NotFoundError();
  if (!isPublicStatus(benchmark.status)) {
    if (!auth || !covers(auth, { account_id: benchmark.account_id, benchmark_id: benchmark.id })) {
      throw new NotFoundError();
    }
  }
  const pagination = readPagination(c);
  const sort = readSort(c, "created_at", SORT_ALLOWED);
  const { rows, total } = await listTargets(c.env.DB, {
    benchmarkId,
    filterKey: c.req.query("filter[key]"),
    sort,
    limit: pagination.limit,
    offset: pagination.offset,
    includeTotal: pagination.includeTotal,
  });
  return collectionResponse(rows.map(serializeTarget), {
    meta: { pagination: paginationMeta(pagination, total) },
  });
});

targets.get("/:id", optionalAuth, async (c) => {
  const auth = getOptionalAuth(c);
  const target = await getTargetById(c.env.DB, c.req.param("id"));
  if (!target) throw new NotFoundError();
  const benchmark = await getBenchmarkById(c.env.DB, target.benchmark_id);
  if (!benchmark) throw new NotFoundError();
  if (!isPublicStatus(benchmark.status)) {
    if (
      !auth ||
      !covers(auth, {
        account_id: benchmark.account_id,
        benchmark_id: benchmark.id,
        target_id: target.id,
      })
    ) {
      throw new NotFoundError();
    }
  }
  return resourceResponse(serializeTarget(target));
});

targets.put("/:id", requireAuth, async (c) => {
  const { target, benchmark } = await loadOwned(c, c.req.param("id"));
  assertBenchmarkEditable(benchmark);
  const attrs = await readAttributes(c);
  const name = requireString(attrs, "name");
  const details = "details" in attrs ? attrs.details : null;
  const row = await updateTarget(c.env.DB, target.id, { name, details });
  return resourceResponse(serializeTarget(row as TargetRow));
});

targets.delete("/:id", requireAuth, async (c) => {
  const { target, benchmark } = await loadOwned(c, c.req.param("id"));
  assertBenchmarkEditable(benchmark);
  if (benchmark.status !== "PRIVATE") {
    throw new ConflictError(
      "Published benchmark data is append-only; a target cannot be deleted.",
    );
  }
  await deleteTargetCascade(c.env.DB, target.id);
  return noContentResponse();
});
