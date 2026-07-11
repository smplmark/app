import { Hono, type Context } from "hono";
import { covers, isPublicStatus, requireWrite } from "../authz";
import { getBenchmarkById } from "../data/benchmarks";
import { isTargetPublic, targetHasFrozenBenchmark, targetHasNonPrivateBenchmark } from "../data/benchmark_targets";
import { LIMITS } from "../limits";
import {
  countTargetsForAccount,
  createTarget,
  deleteTargetCascade,
  getTargetById,
  listAccountTargets,
  listTargetsForBenchmark,
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
import type { TargetRow } from "../types";
import { readAttributes, readPagination, readSort } from "./shared";

const SORT_ALLOWED = ["name", "key", "created_at", "updated_at"] as const;

export const targets = new Hono<AppBindings>();

/** Load an account-owned target the caller may mutate, or 404 (existence not leaked to a non-owner). */
async function loadOwned(c: Context<AppBindings>, id: string): Promise<TargetRow> {
  const auth = getAuth(c);
  requireWrite(auth); // loadOwned backs only mutating handlers.
  const target = await getTargetById(c.env.DB, id);
  // A target is account-owned; only an ACCOUNT-authority credential in its tenant covers it (a
  // benchmark/run-scoped key can't reach across the account's shared target namespace).
  if (!target || !covers(auth, { account_id: target.account_id })) {
    throw new NotFoundError();
  }
  return target;
}

/**
 * The draft-freeze reaches a shared target through any benchmark that's marked ready (PRIVATE &&
 * draft=0): while frozen, its name/details can't change and it can't be deleted (§2).
 */
async function assertTargetNotFrozen(c: Context<AppBindings>, targetId: string): Promise<void> {
  if (await targetHasFrozenBenchmark(c.env.DB, targetId)) {
    throw new ConflictError(
      "This target is linked to a benchmark that is marked ready for publishing; return it to draft to make changes.",
    );
  }
}

// Create a standalone, account-owned target. It is not tied to any benchmark here — link it with
// POST /benchmark_targets. Pick-or-create in the console reuses an existing target (matched by key)
// rather than calling this when one already exists.
targets.post("/", requireAuth, async (c) => {
  const auth = getAuth(c);
  requireWrite(auth);
  // A target belongs to the caller's account; only ACCOUNT authority may mint one.
  if (!covers(auth, { account_id: auth.account_id })) {
    throw new NotFoundError();
  }
  const attrs = await readAttributes(c);
  const key = requireString(attrs, "key", LIMITS.keyLength);
  const name = requireString(attrs, "name", LIMITS.nameLength);
  const details = "details" in attrs ? attrs.details : null;
  if ((await countTargetsForAccount(c.env.DB, auth.account_id)) >= LIMITS.targetsPerAccount) {
    throw new ConflictError(
      `This account has reached the limit of ${LIMITS.targetsPerAccount} targets.`,
    );
  }
  const row = await createTarget(c.env.DB, { account_id: auth.account_id, key, name, details });
  return resourceResponse(serializeTarget(row), { status: 201 });
});

targets.get("/", optionalAuth, async (c) => {
  const auth = getOptionalAuth(c);
  const benchmarkId = c.req.query("filter[benchmark]");
  const pagination = readPagination(c);
  const sort = readSort(c, "created_at", SORT_ALLOWED);
  const filterKey = c.req.query("filter[key]");

  if (benchmarkId !== undefined) {
    // Scoped to a benchmark: the targets linked to it (public benchmark ⇒ world-visible).
    const benchmark = await getBenchmarkById(c.env.DB, benchmarkId);
    if (!benchmark) throw new NotFoundError();
    if (!isPublicStatus(benchmark.status)) {
      if (!auth || !covers(auth, { account_id: benchmark.account_id, benchmark_id: benchmark.id })) {
        throw new NotFoundError();
      }
    }
    const { rows, total } = await listTargetsForBenchmark(c.env.DB, {
      benchmarkId,
      filterKey,
      sort,
      limit: pagination.limit,
      offset: pagination.offset,
      includeTotal: pagination.includeTotal,
    });
    return collectionResponse(rows.map(serializeTarget), {
      meta: { pagination: paginationMeta(pagination, total) },
    });
  }

  // Unscoped: the caller's own account targets (auth required — an anonymous list must scope to a
  // benchmark). No cross-account listing exists; tenant isolation is the floor.
  if (!auth) throw new NotFoundError();
  const { rows, total } = await listAccountTargets(c.env.DB, {
    accountId: auth.account_id,
    filterKey,
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
  // Visible if the caller covers the owning account, or the target is linked to a public benchmark.
  const covered = auth !== undefined && covers(auth, { account_id: target.account_id });
  if (!covered && !(await isTargetPublic(c.env.DB, target.id))) {
    throw new NotFoundError();
  }
  return resourceResponse(serializeTarget(target));
});

targets.put("/:id", requireAuth, async (c) => {
  const target = await loadOwned(c, c.req.param("id"));
  await assertTargetNotFrozen(c, target.id);
  const attrs = await readAttributes(c);
  const name = requireString(attrs, "name", LIMITS.nameLength);
  const details = "details" in attrs ? attrs.details : null;
  const row = await updateTarget(c.env.DB, target.id, { name, details });
  return resourceResponse(serializeTarget(row as TargetRow));
});

targets.delete("/:id", requireAuth, async (c) => {
  const target = await loadOwned(c, c.req.param("id"));
  // A marked-ready benchmark freezes its whole subtree; a published/withdrawn one holds frozen,
  // append-only data. Either way the target (and the measurements the delete would cascade) is
  // protected until it's returned to draft / unlinked from every non-draft home.
  await assertTargetNotFrozen(c, target.id);
  if (await targetHasNonPrivateBenchmark(c.env.DB, target.id)) {
    throw new ConflictError(
      "This target is linked to a published benchmark; unlink it there before deleting.",
    );
  }
  await deleteTargetCascade(c.env.DB, target.id);
  return noContentResponse();
});
