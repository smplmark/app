import { Hono, type Context } from "hono";
import { covers, isPublicStatus, requireWrite } from "../authz";
import { getBenchmarkById } from "../data/benchmarks";
import {
  countRunsForBenchmark,
  createRun,
  deleteRunCascade,
  endRun,
  getRunById,
  invalidateRun,
  listRuns,
  runKeyExists,
  updateRun,
} from "../data/runs";
import { LIMITS } from "../limits";
import { BadRequestError, ConflictError, NotFoundError } from "../errors";
import {
  optionalStringOrNull,
  parseEpochMs,
  requireString,
} from "../http/body";
import { collectionResponse, noContentResponse, resourceResponse } from "../http/jsonapi";
import {
  getAuth,
  getOptionalAuth,
  optionalAuth,
  requireAuth,
  type AppBindings,
} from "../http/middleware";
import { paginationMeta } from "../query/pagination";
import { serializeRun } from "../serialize/resource";
import type { BenchmarkRow, RunRow } from "../types";
import { assertBenchmarkEditable, readAttributes, readPagination, readSort } from "./shared";

const SORT_ALLOWED = ["key", "started_at", "created_at", "updated_at"] as const;

export const runs = new Hono<AppBindings>();

async function loadOwned(
  c: Context<AppBindings>,
  id: string,
): Promise<{ run: RunRow; benchmark: BenchmarkRow }> {
  const auth = getAuth(c);
  requireWrite(auth); // loadOwned backs only mutating handlers.
  const run = await getRunById(c.env.DB, id);
  if (!run) throw new NotFoundError();
  const benchmark = await getBenchmarkById(c.env.DB, run.benchmark_id);
  if (
    !benchmark ||
    !covers(auth, {
      account_id: benchmark.account_id,
      benchmark_id: benchmark.id,
      run_id: run.id,
    })
  ) {
    throw new NotFoundError();
  }
  return { run, benchmark };
}

function optionalStartedAt(attrs: Record<string, unknown>): number | null {
  if (!("started_at" in attrs) || attrs.started_at === null) return null;
  return parseEpochMs(attrs.started_at, "started_at");
}

/** started_at for CREATE: an explicit null means "no start time"; omitting it defaults to now. */
function createStartedAt(attrs: Record<string, unknown>): number | null {
  if (!("started_at" in attrs)) return Date.now();
  if (attrs.started_at === null) return null;
  return parseEpochMs(attrs.started_at, "started_at");
}

function optionalEndedAt(attrs: Record<string, unknown>): number | null {
  if (!("ended_at" in attrs) || attrs.ended_at === null) return null;
  return parseEpochMs(attrs.ended_at, "ended_at");
}

function assertChronological(started_at: number | null, ended_at: number | null): void {
  if (started_at !== null && ended_at !== null && ended_at < started_at) {
    throw new BadRequestError("ended_at must not be earlier than started_at.");
  }
}

/** A published (or withdrawn) benchmark's runs are immutable — no additions, edits, or deletions. */
function assertRunsMutable(benchmark: BenchmarkRow): void {
  if (benchmark.status !== "PRIVATE") {
    throw new ConflictError("This benchmark is published; its runs are frozen and cannot be changed.");
  }
}

/** Resolve the run key: use the supplied one, or auto-generate a unique `run-<hex>` when omitted. */
async function resolveRunKey(
  db: D1Database,
  benchmarkId: string,
  attrs: Record<string, unknown>,
): Promise<string> {
  if (typeof attrs.key === "string" && attrs.key.trim().length > 0) {
    return requireString(attrs, "key", LIMITS.keyLength);
  }
  for (let i = 0; i < 20; i++) {
    const candidate = `run-${crypto.randomUUID().slice(0, 8)}`;
    if (!(await runKeyExists(db, benchmarkId, candidate))) return candidate;
  }
  return `run-${crypto.randomUUID()}`;
}

runs.post("/", requireAuth, async (c) => {
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
  assertRunsMutable(benchmark);
  if (benchmark.closed_at !== null) {
    throw new ConflictError("This benchmark is closed; no new runs can be added.");
  }
  const key = await resolveRunKey(c.env.DB, benchmark.id, attrs);
  const name = optionalStringOrNull(attrs, "name", LIMITS.nameLength) ?? null;
  const details = "details" in attrs ? attrs.details : null;
  const started_at = createStartedAt(attrs);
  const ended_at = optionalEndedAt(attrs);
  assertChronological(started_at, ended_at);
  if ((await countRunsForBenchmark(c.env.DB, benchmark.id)) >= LIMITS.runsPerBenchmark) {
    throw new ConflictError(
      `This benchmark has reached the limit of ${LIMITS.runsPerBenchmark} runs.`,
    );
  }
  const row = await createRun(c.env.DB, {
    benchmark_id: benchmark.id,
    key,
    name,
    details,
    started_at,
    ended_at,
  });
  return resourceResponse(serializeRun(row), { status: 201 });
});

runs.get("/", optionalAuth, async (c) => {
  const auth = getOptionalAuth(c);
  // Runs are benchmark-owned: one request lists every run under a benchmark (a whole leaderboard).
  const benchmarkId = c.req.query("filter[benchmark]");
  if (benchmarkId === undefined) {
    throw new NotFoundError(); // must be scoped to a benchmark
  }
  const benchmark = await getBenchmarkById(c.env.DB, benchmarkId);
  if (!benchmark) throw new NotFoundError();
  if (!isPublicStatus(benchmark.status)) {
    if (
      !auth ||
      !covers(auth, { account_id: benchmark.account_id, benchmark_id: benchmark.id })
    ) {
      throw new NotFoundError();
    }
  }
  const pagination = readPagination(c);
  const sort = readSort(c, "created_at", SORT_ALLOWED);
  const { rows, total } = await listRuns(c.env.DB, {
    benchmarkId: benchmark.id,
    filterKey: c.req.query("filter[key]"),
    sort,
    limit: pagination.limit,
    offset: pagination.offset,
    includeTotal: pagination.includeTotal,
  });
  return collectionResponse(rows.map(serializeRun), {
    meta: { pagination: paginationMeta(pagination, total) },
  });
});

runs.get("/:id", optionalAuth, async (c) => {
  const auth = getOptionalAuth(c);
  const run = await getRunById(c.env.DB, c.req.param("id"));
  if (!run) throw new NotFoundError();
  const benchmark = await getBenchmarkById(c.env.DB, run.benchmark_id);
  if (!benchmark) throw new NotFoundError();
  if (!isPublicStatus(benchmark.status)) {
    if (
      !auth ||
      !covers(auth, {
        account_id: benchmark.account_id,
        benchmark_id: benchmark.id,
        run_id: run.id,
      })
    ) {
      throw new NotFoundError();
    }
  }
  return resourceResponse(serializeRun(run));
});

runs.put("/:id", requireAuth, async (c) => {
  const { run, benchmark } = await loadOwned(c, c.req.param("id"));
  assertBenchmarkEditable(benchmark);
  assertRunsMutable(benchmark);
  const attrs = await readAttributes(c);
  const name = optionalStringOrNull(attrs, "name", LIMITS.nameLength) ?? null;
  const details = "details" in attrs ? attrs.details : null;
  // The timestamps are factual: omitting one keeps the current value (so a prose-only edit never
  // disturbs it); send an explicit value or null to change or clear it. Clearing ended_at returns
  // the run to live.
  const started_at = "started_at" in attrs ? optionalStartedAt(attrs) : run.started_at;
  const ended_at = "ended_at" in attrs ? optionalEndedAt(attrs) : run.ended_at;
  assertChronological(started_at, ended_at);
  const row = await updateRun(c.env.DB, run.id, { name, details, started_at, ended_at });
  return resourceResponse(serializeRun(row as RunRow));
});

runs.delete("/:id", requireAuth, async (c) => {
  const { run, benchmark } = await loadOwned(c, c.req.param("id"));
  assertBenchmarkEditable(benchmark);
  // A private benchmark's runs are freely deletable (measurements cascade). A published benchmark is
  // frozen — a run that no longer stands must be invalidated instead (kept for the record).
  if (benchmark.status !== "PRIVATE") {
    throw new ConflictError(
      "This benchmark is published; its runs are frozen and cannot be deleted. Invalidate the run instead.",
    );
  }
  await deleteRunCascade(c.env.DB, run.id);
  return noContentResponse();
});

runs.post("/:id/actions/end", requireAuth, async (c) => {
  const { run, benchmark } = await loadOwned(c, c.req.param("id"));
  assertBenchmarkEditable(benchmark);
  assertRunsMutable(benchmark);
  if (run.ended_at !== null) {
    throw new ConflictError("This run has already ended.");
  }
  // A run whose started_at is in the future can't be ended "now" — that would invert the interval.
  assertChronological(run.started_at, Date.now());
  const row = await endRun(c.env.DB, run.id, Date.now());
  return resourceResponse(serializeRun(row as RunRow));
});

runs.post("/:id/actions/invalidate", requireAuth, async (c) => {
  const auth = getAuth(c);
  const { run, benchmark } = await loadOwned(c, c.req.param("id"));
  assertBenchmarkEditable(benchmark);
  const attrs = await readAttributes(c).catch(() => ({}) as Record<string, unknown>);
  const reason = optionalStringOrNull(attrs, "invalidation_reason") ?? null;
  const row = await invalidateRun(c.env.DB, run.id, Date.now(), reason, auth.user_id);
  return resourceResponse(serializeRun(row as RunRow));
});
