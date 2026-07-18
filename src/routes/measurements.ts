import { Hono } from "hono";
import { emitAuditEvent } from "../audit/smpl_audit";
import { covers, isPublicStatus, requireWrite } from "../authz";
import { getBenchmarkById, type BenchmarkRowWithPublisher } from "../data/benchmarks";
import {
  deleteMeasurement,
  getMeasurementById,
  insertMeasurement,
  listMeasurements,
  updateMeasurement,
  type MeasurementScope,
} from "../data/measurements";
import { isSubjectLinked, isSubjectPublic } from "../data/benchmark_subjects";
import { getRunById, resolveOwnedRun, resolveRunForRead } from "../data/runs";
import { resolveOwnedSubject, resolveSubjectForRead } from "../data/subjects";
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
import { canonical, parseMeasurementSchema } from "../schema/measurement_schema";
import { measurementsToCsv } from "../serialize/csv";
import { serializeMeasurement } from "../serialize/resource";
import type { AuthContext, MeasurementRow, MeasurementSchema, RunRow } from "../types";
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
  // invariant every loader in this repo upholds). The reference may be the run's key (resolved within
  // the caller's scope, since a key is unique only per benchmark) or a raw UUID.
  const run = await resolveOwnedRun(c.env.DB, auth, runId);
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
  // linked to that same benchmark (D1 can't enforce the cross-pair rule; benchmark_subject does). The
  // reference may be the subject's key (resolved within the benchmark's account) or a raw UUID. A
  // missing subject and a subject not linked to the run's benchmark are rejected identically (same
  // 409) so neither leaks whether a foreign id exists.
  const subject = await resolveOwnedSubject(c.env.DB, benchmark.account_id, subjectId);
  if (!subject || !(await isSubjectLinked(c.env.DB, benchmark.id, subject.id))) {
    throw new ConflictError("The subject is not linked to the run's benchmark.");
  }
  assertBenchmarkEditable(benchmark);
  // Measurements may land at any lifecycle stage — post-publish ingest and appends to an ended run
  // are allowed and audited (the record is auditable, not frozen). Only the publisher's explicit
  // "closed" signal refuses new data (it's reversible via reopen).
  if (benchmark.closed_at !== null) {
    throw new ConflictError("This benchmark is closed; no new measurements can be added.");
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

  const visibility = benchmark.status === "PRIVATE" ? "internal" : "public";
  emitAuditEvent(c, {
    event_type: "measurement.created",
    resource_type: "measurement",
    resource_id: String(id),
    benchmark_id: benchmark.id,
    visibility,
    description: "Measurement recorded.",
    extra: { run_id: run.id, subject_id: subject.id },
    actor: auth,
  });
  // Appending to a run that had already ended is legitimate but noteworthy — it gets its own
  // run-level event so the run's history shows the late addition.
  if (run.ended_at !== null) {
    emitAuditEvent(c, {
      event_type: "run.appended",
      resource_type: "run",
      resource_id: run.id,
      benchmark_id: benchmark.id,
      visibility,
      description: `Measurement added to run "${run.key}" after it ended.`,
      extra: { measurement_id: String(id) },
      actor: auth,
    });
  }

  const schema = parseMeasurementSchema(benchmark.measurement_schema);
  const resource = serializeMeasurement(
    { id, run_id: run.id, subject_id: subject.id, subject_key: subject.key, run_key: run.key, created_at: createdAt, metrics: metricsJson, meta: metaJson },
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
  // directly: the caller covers its account, or it's linked to at least one public benchmark. The
  // filter value may be the subject's key or a raw UUID; the scope filters on the resolved UUID.
  if (subject !== undefined) {
    const t = await resolveSubjectForRead(c.env.DB, auth?.account_id ?? null, subject);
    if (!t) throw new NotFoundError();
    const covered = auth !== undefined && covers(auth, { account_id: t.account_id });
    if (!covered && !(await isSubjectPublic(c.env.DB, t.id))) throw new NotFoundError();
    // A covered account caller sees all their measurements; anyone else sees only those recorded
    // under the subject's public benchmarks (a private sibling benchmark must not leak).
    return { subject: t.id, subjectPublicOnly: !covered };
  }

  // run / benchmark: resolve to the owning benchmark (for visibility) and the scope chain (coverage).
  let bench = null;
  let chain: { account_id: string; benchmark_id: string; run_id?: string } | null = null;
  // The filter[run] value may be the run's key or a raw UUID; the scope filters measurement.run_id
  // on the resolved UUID (mirrors the subject fix, which filters on the resolved subject UUID).
  let runId: string | undefined;
  if (run !== undefined) {
    const r = await resolveRunForRead(c.env.DB, auth ?? null, run);
    if (r) {
      runId = r.id;
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
  return { run: runId, benchmark };
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
      { id: r.id, run_id: r.run_id, subject_id: r.subject_id, subject_key: r.subject_key, run_key: r.run_key, created_at: r.created_at, metrics: r.metrics, meta: r.meta },
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

/** Load a measurement + its run/benchmark chain for a covered mutating caller, or 404 (no-leak). */
async function loadOwnedMeasurement(
  c: Parameters<typeof getAuth>[0],
  rawId: string,
): Promise<{ id: number; measurement: MeasurementRow & { subject_key: string }; run: RunRow; benchmark: BenchmarkRowWithPublisher }> {
  const auth = getAuth(c);
  requireWrite(auth);
  const id = Number(rawId);
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
  return { id, measurement, run, benchmark };
}

// Correct a measurement in place: full-replace of its created_at / metrics / meta (its run and
// subject are fixed — a measurement is an observation of that pair). Allowed at any lifecycle
// stage; on a published benchmark the correction is part of the public record, and the audit event
// carries before/after so the History can render exactly what changed.
measurements.put("/:id", requireAuth, async (c) => {
  const auth = getAuth(c);
  const { id, measurement, run, benchmark } = await loadOwnedMeasurement(c, c.req.param("id"));
  assertBenchmarkEditable(benchmark);
  const attrs = await readAttributes(c);
  const createdAt = "created_at" in attrs ? parseEpochMs(attrs.created_at, "created_at") : measurement.created_at;
  const metricsJson =
    "metrics" in attrs && attrs.metrics !== null
      ? JSON.stringify(validateMetrics(attrs.metrics))
      : null;
  const metaJson =
    "meta" in attrs && attrs.meta !== null
      ? JSON.stringify(requireObject(attrs.meta, "meta"))
      : null;

  await updateMeasurement(c.env.DB, id, { created_at: createdAt, metrics: metricsJson, meta: metaJson });

  // canonical(): key-order-only differences are not corrections (no spurious public events).
  const changes: Record<string, { before: unknown; after: unknown }> = {};
  if (measurement.created_at !== createdAt) {
    changes.created_at = { before: measurement.created_at, after: createdAt };
  }
  const oldMetrics = measurement.metrics === null ? null : JSON.parse(measurement.metrics);
  const newMetrics = metricsJson === null ? null : JSON.parse(metricsJson);
  if (canonical(oldMetrics) !== canonical(newMetrics)) {
    changes.metrics = { before: oldMetrics, after: newMetrics };
  }
  const oldMeta = measurement.meta === null ? null : JSON.parse(measurement.meta);
  const newMeta = metaJson === null ? null : JSON.parse(metaJson);
  if (canonical(oldMeta) !== canonical(newMeta)) {
    changes.meta = { before: oldMeta, after: newMeta };
  }
  if (Object.keys(changes).length > 0) {
    emitAuditEvent(c, {
      event_type: "measurement.corrected",
      resource_type: "measurement",
      resource_id: String(id),
      benchmark_id: benchmark.id,
      visibility: benchmark.status === "PRIVATE" ? "internal" : "public",
      description: "Measurement corrected.",
      changes,
      extra: { run_id: run.id, subject_id: measurement.subject_id },
      actor: auth,
    });
  }

  const schema = parseMeasurementSchema(benchmark.measurement_schema);
  return resourceResponse(
    serializeMeasurement(
      { id, run_id: run.id, subject_id: measurement.subject_id, subject_key: measurement.subject_key, run_key: run.key, created_at: createdAt, metrics: metricsJson, meta: metaJson },
      schema,
      { created_at: createdAt, run: { started_at: run.started_at, ended_at: run.ended_at } },
    ),
  );
});

// Delete a single measurement. Allowed only while the benchmark is a draft: a published
// measurement must never silently vanish — correct it in place (PUT, audited with before/after) or
// invalidate its run to retract it visibly. The id is the measurement's rowid.
measurements.delete("/:id", requireAuth, async (c) => {
  const { id, benchmark } = await loadOwnedMeasurement(c, c.req.param("id"));
  assertBenchmarkEditable(benchmark);
  if (benchmark.status !== "PRIVATE") {
    throw new ConflictError(
      "A published measurement can't be deleted — the public record must not vanish. Correct it in place or invalidate its run instead.",
    );
  }
  await deleteMeasurement(c.env.DB, id);
  return noContentResponse();
});
