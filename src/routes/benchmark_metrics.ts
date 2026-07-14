// Link a library metric to a benchmark (M:N). Linking is snapshot-on-link: the metric's current
// definition is copied into the benchmark's measurement_schema — a MetricDecl for STORED, a DerivedDecl
// (with the compiled JSON Logic) for DERIVED — which is what the compute-on-read engine and the publish
// freeze read. Because a snapshot is an APPEND, linking is allowed even on a published benchmark; the
// interpretation freeze only forbids changing/removing existing entries. Unlinking removes the snapshot,
// so — like unlinking a subject — it's only allowed while the benchmark is PRIVATE.
import { Hono } from "hono";
import { covers, isPublicStatus, requireWrite } from "../authz";
import { getBenchmarkById } from "../data/benchmarks";
import {
  countLinksForBenchmark,
  createBenchmarkMetricLink,
  deleteBenchmarkMetricLink,
  getBenchmarkMetricById,
  isMetricLinked,
  listBenchmarkMetrics,
} from "../data/benchmark_metrics";
import { getMetricById } from "../data/metrics";
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
import { assertFrozenCompatible, parseMeasurementSchema } from "../schema/measurement_schema";
import { metricSnapshot } from "../schema/metric";
import { serializeBenchmarkMetric } from "../serialize/resource";
import type { MeasurementSchema } from "../types";
import { assertBenchmarkEditable, readAttributes, readPagination, readSort } from "./shared";

const SORT_ALLOWED = ["created_at"] as const;

export const benchmarkMetrics = new Hono<AppBindings>();

// Link a metric from the account library into a benchmark, snapshotting its definition into the
// benchmark's measurement_schema. Allowed while editable or already published (an append), but not while
// marked-ready or closed. The metric must belong to the benchmark's account.
benchmarkMetrics.post("/", requireAuth, async (c) => {
  const auth = getAuth(c);
  requireWrite(auth);
  const attrs = await readAttributes(c);
  const benchmarkId = requireString(attrs, "benchmark");
  const metricId = requireString(attrs, "metric");

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
    throw new ConflictError("This benchmark is closed; no new metrics can be added.");
  }
  // Resolve the metric only after the benchmark is covered. A missing metric and a metric in another
  // account are rejected identically (same 409) so neither leaks whether a foreign id exists.
  const metric = await getMetricById(c.env.DB, metricId);
  if (!metric || metric.account_id !== benchmark.account_id) {
    throw new ConflictError("The metric does not belong to this benchmark's account.");
  }
  if (await isMetricLinked(c.env.DB, benchmark.id, metric.id)) {
    throw new ConflictError("This metric is already linked to this benchmark.");
  }
  if ((await countLinksForBenchmark(c.env.DB, benchmark.id)) >= LIMITS.metricsPerBenchmark) {
    throw new ConflictError(
      `This benchmark has reached the limit of ${LIMITS.metricsPerBenchmark} metrics.`,
    );
  }

  // Append the metric's snapshot to the schema. Its name is the schema key (unique across stored +
  // derived); a clash with an existing name — e.g. a hand-authored metric — is a 409.
  const old = parseMeasurementSchema(benchmark.measurement_schema);
  const names = new Set([...old.metrics.map((m) => m.name), ...old.derived.map((d) => d.name)]);
  if (names.has(metric.name)) {
    throw new ConflictError(
      `A metric named ${JSON.stringify(metric.name)} is already defined on this benchmark.`,
    );
  }
  const snap = metricSnapshot(metric);
  const next: MeasurementSchema = {
    metrics: snap.metric ? [...old.metrics, snap.metric] : old.metrics,
    derived: snap.derived ? [...old.derived, snap.derived] : old.derived,
  };
  if (old.chart) next.chart = old.chart;
  // Belt-and-suspenders: an append is always freeze-compatible, but assert it on a published benchmark.
  if (benchmark.status !== "PRIVATE") assertFrozenCompatible(old, next);

  const row = await createBenchmarkMetricLink(c.env.DB, {
    benchmark_id: benchmark.id,
    metric_id: metric.id,
    schemaJson: JSON.stringify(next),
  });
  return resourceResponse(serializeBenchmarkMetric(row), { status: 201 });
});

benchmarkMetrics.get("/", optionalAuth, async (c) => {
  const auth = getOptionalAuth(c);
  const benchmarkId = c.req.query("filter[benchmark]");
  const metricId = c.req.query("filter[metric]");
  if (benchmarkId === undefined && metricId === undefined) {
    throw new NotFoundError(); // must be scoped to a benchmark or a metric
  }

  // Visibility resolves off whichever scope anchors the query. A metric is an account-private library
  // resource (never public), so a metric anchor always requires account coverage; a benchmark anchor is
  // visible to anyone once the benchmark is PUBLISHED/WITHDRAWN.
  if (benchmarkId !== undefined) {
    const benchmark = await getBenchmarkById(c.env.DB, benchmarkId);
    if (!benchmark) throw new NotFoundError();
    if (!isPublicStatus(benchmark.status)) {
      if (!auth || !covers(auth, { account_id: benchmark.account_id, benchmark_id: benchmark.id })) {
        throw new NotFoundError();
      }
    }
  } else if (metricId !== undefined) {
    const metric = await getMetricById(c.env.DB, metricId);
    if (!metric || !auth || !covers(auth, { account_id: metric.account_id })) {
      throw new NotFoundError();
    }
  }

  const pagination = readPagination(c);
  const sort = readSort(c, "created_at", SORT_ALLOWED);
  const { rows, total } = await listBenchmarkMetrics(c.env.DB, {
    benchmarkId,
    metricId,
    sort,
    limit: pagination.limit,
    offset: pagination.offset,
    includeTotal: pagination.includeTotal,
  });
  return collectionResponse(rows.map(serializeBenchmarkMetric), {
    meta: { pagination: paginationMeta(pagination, total) },
  });
});

// Unlink a metric from a benchmark, removing its snapshot from the measurement_schema. Removal is not an
// append, so — like deleting a subject — it's only allowed while the benchmark is PRIVATE.
benchmarkMetrics.delete("/:id", requireAuth, async (c) => {
  const auth = getAuth(c);
  requireWrite(auth);
  const link = await getBenchmarkMetricById(c.env.DB, c.req.param("id"));
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
      "Published benchmark data is append-only; a metric cannot be unlinked.",
    );
  }

  // Remove the metric's snapshot from the schema by its name. The metric row still exists (a linked
  // metric can't be deleted from the library), so its name is available.
  const old = parseMeasurementSchema(benchmark.measurement_schema);
  const metric = await getMetricById(c.env.DB, link.metric_id);
  let schemaJson = benchmark.measurement_schema;
  if (metric) {
    if (old.chart && (old.chart.x === metric.name || old.chart.y === metric.name)) {
      throw new ConflictError(
        "This metric is used by the benchmark chart; update the chart before unlinking it.",
      );
    }
    const next: MeasurementSchema = {
      metrics: old.metrics.filter((m) => m.name !== metric.name),
      derived: old.derived.filter((d) => d.name !== metric.name),
    };
    if (old.chart) next.chart = old.chart;
    schemaJson = JSON.stringify(next);
  }
  await deleteBenchmarkMetricLink(c.env.DB, {
    id: link.id,
    benchmark_id: link.benchmark_id,
    schemaJson,
  });
  return noContentResponse();
});
