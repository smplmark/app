import { Hono } from "hono";
import { covers, isPublicStatus, requireWrite } from "../authz";
import { getBenchmarkById } from "../data/benchmarks";
import {
  deleteMeasurement,
  getMeasurementById,
  insertMeasurement,
  listMeasurements,
  type MeasurementScope,
} from "../data/measurements";
import { isSubjectLinked, isSubjectPublic } from "../data/benchmark_subjects";
import { getRunById } from "../data/runs";
import { getSubjectById } from "../data/subjects";
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
} from "../errors";
import { parseEpochMs, requireObject, requireString } from "../http/body";
import { wantsCsv } from "../http/content_negotiation";
import { collectionResponse, noContentResponse, resourceResponse } from "../http/jsonapi";
import {
  getAuth,
  getOptionalAuth,
  optionalAuth,
  requireAuth,
  type AppBindings,
} from "../http/middleware";
import { parseDateRange } from "../query/daterange";
import { paginationMeta } from "../query/pagination";
import { parseMeasurementSchema } from "../schema/measurement_schema";
import { measurementsToCsv } from "../serialize/csv";
import { serializeMeasurement } from "../serialize/resource";
import type { AuthContext, MeasurementSchema } from "../types";
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
  // A measurement names both the run (the occasion) and the subject (the thing measured).
  const runId = requireString(attrs, "run");
  const subjectId = requireString(attrs, "subject");

  // Authorize the RUN first, before the subject is ever looked up — so an uncovered/foreign run is an
  // indistinguishable 404 and the subject probe below can't leak cross-account existence (the no-leak
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
  // The caller covers the run's benchmark. Only now resolve the named subject and validate it is
  // linked to that same benchmark (D1 can't enforce the cross-pair rule; benchmark_subject does). A
  // missing subject and a subject not linked to the run's benchmark are rejected identically (same
  // 409) so neither leaks whether a foreign id exists.
  const subject = await getSubjectById(c.env.DB, subjectId);
  if (!subject || !(await isSubjectLinked(c.env.DB, benchmark.id, subject.id))) {
    throw new ConflictError("The subject is not linked to the run's benchmark.");
  }
  assertBenchmarkEditable(benchmark);
  // The append-only door is open by default, but closed things are actually closed: an ended run
  // and a closed benchmark refuse new measurements.
  if (benchmark.closed_at !== null) {
    throw new ConflictError("This benchmark is closed; no new measurements can be added.");
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
    subject_id: subject.id,
    created_at: createdAt,
    metrics: metricsJson,
    meta: metaJson,
    client_ip: clientIp,
  });

  const schema = parseMeasurementSchema(benchmark.measurement_schema);
  const resource = serializeMeasurement(
    { id, run_id: run.id, subject_id: subject.id, created_at: createdAt, metrics: metricsJson, meta: metaJson },
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
  const subject = c.req.query("filter[subject]");
  const benchmark = c.req.query("filter[benchmark]");
  const provided = [run, subject, benchmark].filter((x) => x !== undefined);
  if (provided.length !== 1) {
    throw new BadRequestError(
      "Provide exactly one of filter[run], filter[subject], filter[benchmark].",
    );
  }

  // A subject spans benchmarks (M:N), so it has no single owning benchmark — resolve its visibility
  // directly: the caller covers its account, or it's linked to at least one public benchmark.
  if (subject !== undefined) {
    const t = await getSubjectById(c.env.DB, subject);
    if (!t) throw new NotFoundError();
    const covered = auth !== undefined && covers(auth, { account_id: t.account_id });
    if (!covered && !(await isSubjectPublic(c.env.DB, t.id))) throw new NotFoundError();
    // A covered account caller sees all their measurements; anyone else sees only those recorded
    // under the subject's public benchmarks (a private sibling benchmark must not leak).
    return { subject, subjectPublicOnly: !covered };
  }

  // run / benchmark: resolve to the owning benchmark (for visibility) and the scope chain (coverage).
  let bench = null;
  let chain: { account_id: string; benchmark_id: string; run_id?: string } | null = null;
  if (run !== undefined) {
    const r = await getRunById(c.env.DB, run);
    if (r) {
      bench = await getBenchmarkById(c.env.DB, r.benchmark_id);
      if (bench) chain = { account_id: bench.account_id, benchmark_id: bench.id, run_id: r.id };
    }
  } else if (benchmark !== undefined) {
    bench = await getBenchmarkById(c.env.DB, benchmark);
    if (bench) chain = { account_id: bench.account_id, benchmark_id: bench.id };
  }

  if (!bench || !chain) throw new NotFoundError();
  if (!isPublicStatus(bench.status)) {
    if (!auth || !covers(auth, chain)) throw new NotFoundError();
  }
  return { run, benchmark };
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
  const schemaCache = new Map<string, MeasurementSchema>();
  const resources = rows.map((r) => {
    let schema = schemaCache.get(r.measurement_schema);
    if (schema === undefined) {
      schema = parseMeasurementSchema(r.measurement_schema);
      schemaCache.set(r.measurement_schema, schema);
    }
    return serializeMeasurement(
      { id: r.id, run_id: r.run_id, subject_id: r.subject_id, created_at: r.created_at, metrics: r.metrics, meta: r.meta },
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

// Delete a single measurement. Measurements are append-only once their benchmark is published (delete a
// run's data there by invalidating the whole run), so this is allowed only while the benchmark is a
// draft. The id is the measurement's rowid.
measurements.delete("/:id", requireAuth, async (c) => {
  const auth = getAuth(c);
  requireWrite(auth);
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id)) throw new NotFoundError();
  const measurement = await getMeasurementById(c.env.DB, id);
  if (!measurement) throw new NotFoundError();
  // Authorize through the run's benchmark (no-leak: an uncovered/foreign measurement is a 404).
  const run = await getRunById(c.env.DB, measurement.run_id);
  if (!run) throw new NotFoundError();
  const benchmark = await getBenchmarkById(c.env.DB, run.benchmark_id);
  if (
    !benchmark ||
    !covers(auth, { account_id: benchmark.account_id, benchmark_id: benchmark.id, run_id: run.id })
  ) {
    throw new NotFoundError();
  }
  assertBenchmarkEditable(benchmark);
  if (benchmark.status !== "PRIVATE") {
    throw new ConflictError(
      "Published measurements are append-only and cannot be deleted; invalidate the run instead.",
    );
  }
  await deleteMeasurement(c.env.DB, id);
  return noContentResponse();
});
