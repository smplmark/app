import { Hono } from "hono";
import { covers, isPublicStatus, requireWrite } from "../authz";
import { getBenchmarkById } from "../data/benchmarks";
import {
  insertObservation,
  listObservations,
  type ObservationScope,
} from "../data/observations";
import { getRunById } from "../data/runs";
import { getTargetById } from "../data/targets";
import { BadRequestError, NotFoundError } from "../errors";
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
import { parseSampleSchema } from "../schema/sample_schema";
import { observationsToCsv } from "../serialize/csv";
import { serializeObservation } from "../serialize/resource";
import type { AuthContext, SampleSchema } from "../types";
import { assertBenchmarkEditable, readAttributes, readPagination, readSort } from "./shared";

const SORT_ALLOWED = ["created_at"] as const;

export const observations = new Hono<AppBindings>();

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

observations.post("/", requireAuth, async (c) => {
  const auth = getAuth(c);
  requireWrite(auth); // API keys (beacons) pass; a viewer session cannot ingest.
  const attrs = await readAttributes(c);
  const runId = requireString(attrs, "run");

  const run = await getRunById(c.env.DB, runId);
  if (!run) throw new NotFoundError();
  const target = await getTargetById(c.env.DB, run.target_id);
  if (!target) throw new NotFoundError();
  const benchmark = await getBenchmarkById(c.env.DB, target.benchmark_id);
  if (
    !benchmark ||
    !covers(auth, {
      account_id: benchmark.account_id,
      benchmark_id: benchmark.id,
      target_id: target.id,
      run_id: run.id,
    })
  ) {
    throw new NotFoundError();
  }
  assertBenchmarkEditable(benchmark);

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

  const id = await insertObservation(c.env.DB, {
    run_id: run.id,
    created_at: createdAt,
    metrics: metricsJson,
    meta: metaJson,
    client_ip: clientIp,
  });

  const schema = parseSampleSchema(benchmark.sample_schema);
  const resource = serializeObservation(
    { id, run_id: run.id, created_at: createdAt, metrics: metricsJson, meta: metaJson },
    schema,
    { created_at: createdAt, run: { started_at: run.started_at, ended_at: run.ended_at } },
  );
  return resourceResponse(resource, { status: 201 });
});

/** Resolve the one required scope filter to a bounded subtree, enforcing visibility. */
async function resolveScope(
  c: Parameters<typeof getOptionalAuth>[0],
  auth: AuthContext | undefined,
): Promise<ObservationScope> {
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
  let chain: { account_id: string; benchmark_id: string; target_id?: string; run_id?: string } | null =
    null;
  if (run !== undefined) {
    const r = await getRunById(c.env.DB, run);
    if (r) {
      const t = await getTargetById(c.env.DB, r.target_id);
      if (t) {
        bench = await getBenchmarkById(c.env.DB, t.benchmark_id);
        if (bench) chain = { account_id: bench.account_id, benchmark_id: bench.id, target_id: t.id, run_id: r.id };
      }
    }
  } else if (target !== undefined) {
    const t = await getTargetById(c.env.DB, target);
    if (t) {
      bench = await getBenchmarkById(c.env.DB, t.benchmark_id);
      if (bench) chain = { account_id: bench.account_id, benchmark_id: bench.id, target_id: t.id };
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

observations.get("/", optionalAuth, async (c) => {
  const auth = getOptionalAuth(c);
  const scope = await resolveScope(c, auth);

  const createdAt = c.req.query("filter[created_at]");
  const range = createdAt !== undefined ? parseDateRange(createdAt) : undefined;

  const pagination = readPagination(c);
  const sort = readSort(c, "created_at", SORT_ALLOWED);
  const { rows, total } = await listObservations(c.env.DB, {
    scope,
    range,
    sort,
    limit: pagination.limit,
    offset: pagination.offset,
    includeTotal: pagination.includeTotal,
  });

  // Parse each benchmark's schema once per request (compute-on-read is O(rows × derived)).
  const schemaCache = new Map<string, SampleSchema>();
  const resources = rows.map((r) => {
    let schema = schemaCache.get(r.sample_schema);
    if (schema === undefined) {
      schema = parseSampleSchema(r.sample_schema);
      schemaCache.set(r.sample_schema, schema);
    }
    return serializeObservation(
      { id: r.id, run_id: r.run_id, created_at: r.created_at, metrics: r.metrics, meta: r.meta },
      schema,
      { created_at: r.created_at, run: { started_at: r.run_started_at, ended_at: r.run_ended_at } },
    );
  });

  if (wantsCsv(c.req.header("Accept"))) {
    return new Response(observationsToCsv(resources), {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": 'attachment; filename="observations.csv"',
        Vary: "Accept",
      },
    });
  }

  return collectionResponse(resources, {
    meta: { pagination: paginationMeta(pagination, total) },
    headers: { Vary: "Accept" },
  });
});
