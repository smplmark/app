import { Hono } from "hono";
import { covers, isPublicStatus, requireWrite } from "../authz";
import { getBenchmarkById } from "../data/benchmarks";
import {
  insertMeasurement,
  listMeasurements,
  type MeasurementScope,
} from "../data/measurements";
import { getRunById } from "../data/runs";
import { getTargetById } from "../data/targets";
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
} from "../errors";
import { parseEpochMs, requireObject, requireString } from "../http/body";
import { wantsCsv } from "../http/content_negotiation";
import { collectionResponse, resourceResponse } from "../http/jsonapi";
import {
  getAuth,
  getOptionalAuth,
  optionalAuth,
  requireAuth,
  type AppBindings,
} from "../http/middleware";
import { parseDateRange } from "../query/daterange";
import { paginationMeta } from "../query/pagination";
import { parseObservationSchema } from "../schema/observation_schema";
import { measurementsToCsv } from "../serialize/csv";
import { serializeMeasurement } from "../serialize/resource";
import type { AuthContext, ObservationSchema } from "../types";
import { assertBenchmarkEditable, readAttributes, readPagination, readSort } from "./shared";

const SORT_ALLOWED = ["created_at"] as const;

export const measurements = new Hono<AppBindings>();

/** Validate a stored-metrics bag: an object whose every value is a finite number (§4). */
function validateMetrics(value: unknown): Record<string, number> {
  const obj = requireObject(value, "metrics");
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v !== "number" || !Number.isFinite(v)) {
      throw new BadRequestError(
        `metrics.${k} must be a finite number.`,
        { pointer: "/data/attributes/metrics" },
      );
    }
  }
  return obj as Record<string, number>;
}

measurements.post("/", requireAuth, async (c) => {
  const auth = getAuth(c);
  requireWrite(auth); // API keys (beacons) pass; a viewer session cannot ingest.
  const attrs = await readAttributes(c);
  // A measurement names both the run (the occasion) and the target (the thing measured).
  const runId = requireString(attrs, "run");
  const targetId = requireString(attrs, "target");

  // Authorize the RUN first, before the target is ever looked up — so an uncovered/foreign run is an
  // indistinguishable 404 and the target probe below can't leak cross-account existence (the no-leak
  // invariant every loader in this repo upholds).
  const run = await getRunById(c.env.DB, runId);
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
  // The caller covers the run's benchmark. Only now resolve the named target and validate it belongs
  // to that same benchmark (D1 can't enforce the cross-pair FK). A missing target and a target in a
  // different benchmark are rejected identically (same 409) so neither leaks whether a foreign id exists.
  const target = await getTargetById(c.env.DB, targetId);
  if (!target || target.benchmark_id !== benchmark.id) {
    throw new ConflictError("The target does not belong to the run's benchmark.");
  }
  assertBenchmarkEditable(benchmark);
  // The append-only door is open by default, but closed things are actually closed: an ended run
  // and a closed target/benchmark all refuse new measurements.
  if (benchmark.closed_at !== null) {
    throw new ConflictError("This benchmark is closed; no new measurements can be added.");
  }
  if (target.closed_at !== null) {
    throw new ConflictError("This target is closed; no new measurements can be added.");
  }
  if (run.ended_at !== null) {
    throw new ConflictError("This run has ended; no new measurements can be added.");
  }

  const now = Date.now();
  const createdAt = "created_at" in attrs ? parseEpochMs(attrs.created_at, "created_at") : now;
  const metricsJson =
    "metrics" in attrs && attrs.metrics !== null
      ? JSON.stringify(validateMetrics(attrs.metrics))
      : null;
  const metaJson =
    "meta" in attrs && attrs.meta !== null
      ? JSON.stringify(requireObject(attrs.meta, "meta"))
      : null;
  const clientIp = c.req.header("CF-Connecting-IP") ?? null;

  const id = await insertMeasurement(c.env.DB, {
    run_id: run.id,
    target_id: target.id,
    created_at: createdAt,
    metrics: metricsJson,
    meta: metaJson,
    client_ip: clientIp,
  });

  const schema = parseObservationSchema(benchmark.observation_schema);
  const resource = serializeMeasurement(
    { id, run_id: run.id, target_id: target.id, created_at: createdAt, metrics: metricsJson, meta: metaJson },
    schema,
    { created_at: createdAt, run: { started_at: run.started_at, ended_at: run.ended_at } },
  );
  return resourceResponse(resource, { status: 201 });
});

/** Resolve the one required scope filter to a bounded subtree, enforcing visibility. */
async function resolveScope(
  c: Parameters<typeof getOptionalAuth>[0],
  auth: AuthContext | undefined,
): Promise<MeasurementScope> {
  const run = c.req.query("filter[run]");
  const target = c.req.query("filter[target]");
  const benchmark = c.req.query("filter[benchmark]");
  const provided = [run, target, benchmark].filter((x) => x !== undefined);
  if (provided.length !== 1) {
    throw new BadRequestError(
      "Provide exactly one of filter[run], filter[target], filter[benchmark].",
    );
  }

  // Resolve to the owning benchmark (for visibility) and the scope chain (for coverage).
  let bench = null;
  let chain: { account_id: string; benchmark_id: string; run_id?: string } | null = null;
  if (run !== undefined) {
    const r = await getRunById(c.env.DB, run);
    if (r) {
      bench = await getBenchmarkById(c.env.DB, r.benchmark_id);
      if (bench) chain = { account_id: bench.account_id, benchmark_id: bench.id, run_id: r.id };
    }
  } else if (target !== undefined) {
    const t = await getTargetById(c.env.DB, target);
    if (t) {
      bench = await getBenchmarkById(c.env.DB, t.benchmark_id);
      if (bench) chain = { account_id: bench.account_id, benchmark_id: bench.id };
    }
  } else if (benchmark !== undefined) {
    bench = await getBenchmarkById(c.env.DB, benchmark);
    if (bench) chain = { account_id: bench.account_id, benchmark_id: bench.id };
  }

  if (!bench || !chain) throw new NotFoundError();
  if (!isPublicStatus(bench.status)) {
    if (!auth || !covers(auth, chain)) throw new NotFoundError();
  }
  return { run, target, benchmark };
}

measurements.get("/", optionalAuth, async (c) => {
  const auth = getOptionalAuth(c);
  const scope = await resolveScope(c, auth);

  const createdAt = c.req.query("filter[created_at]");
  const range = createdAt !== undefined ? parseDateRange(createdAt) : undefined;

  const pagination = readPagination(c);
  const sort = readSort(c, "created_at", SORT_ALLOWED);
  const { rows, total } = await listMeasurements(c.env.DB, {
    scope,
    range,
    sort,
    limit: pagination.limit,
    offset: pagination.offset,
    includeTotal: pagination.includeTotal,
  });

  // Parse each benchmark's schema once per request (compute-on-read is O(rows × derived)).
  const schemaCache = new Map<string, ObservationSchema>();
  const resources = rows.map((r) => {
    let schema = schemaCache.get(r.observation_schema);
    if (schema === undefined) {
      schema = parseObservationSchema(r.observation_schema);
      schemaCache.set(r.observation_schema, schema);
    }
    return serializeMeasurement(
      { id: r.id, run_id: r.run_id, target_id: r.target_id, created_at: r.created_at, metrics: r.metrics, meta: r.meta },
      schema,
      { created_at: r.created_at, run: { started_at: r.run_started_at, ended_at: r.run_ended_at } },
    );
  });

  if (wantsCsv(c.req.header("Accept"))) {
    return new Response(measurementsToCsv(resources), {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": 'attachment; filename="measurements.csv"',
        Vary: "Accept",
      },
    });
  }

  return collectionResponse(resources, {
    meta: { pagination: paginationMeta(pagination, total) },
    headers: { Vary: "Accept" },
  });
});
