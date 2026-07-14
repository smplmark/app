// Metrics — a reusable, account-owned catalogue of metric definitions (STORED values or DERIVED,
// computed-on-read). All endpoints need an account-scoped credential (a benchmark/run-scoped key can't
// reach the account's shared metric namespace); writes are write-tier (a viewer may read, not mutate).
// Metrics are linked to benchmarks many-to-many in a later change.
import { Hono, type Context } from "hono";
import { requireWrite } from "../authz";
import { countBenchmarksForMetric } from "../data/benchmark_metrics";
import {
  countMetricsForAccount,
  createMetric,
  deleteMetric,
  getMetricById,
  getMetricByName,
  listMetrics,
  updateMetric,
} from "../data/metrics";
import { ConflictError, ForbiddenError, NotFoundError } from "../errors";
import { collectionResponse, noContentResponse, resourceResponse } from "../http/jsonapi";
import { getAuth, requireAuth, type AppBindings } from "../http/middleware";
import { LIMITS } from "../limits";
import { paginationMeta } from "../query/pagination";
import { parseMetric } from "../schema/metric";
import { serializeMetric } from "../serialize/resource";
import type { AuthContext, MetricRow } from "../types";
import { readAttributes, readPagination, readSort } from "./shared";

const SORT_ALLOWED = ["name", "label", "type", "kind", "created_at", "updated_at"] as const;

export const metrics = new Hono<AppBindings>();

/** Managing metrics is an account-level concern (not reachable by a scoped key). */
function requireAccountScope(auth: AuthContext): void {
  if (auth.scope_type !== "ACCOUNT") {
    throw new ForbiddenError("Managing metrics requires an account-scoped credential.");
  }
}

/** Load an account-owned metric for a mutation, or 404. */
async function loadOwnedForWrite(c: Context<AppBindings>, id: string): Promise<MetricRow> {
  const auth = getAuth(c);
  requireAccountScope(auth);
  requireWrite(auth);
  const row = await getMetricById(c.env.DB, id);
  if (!row || row.account_id !== auth.account_id) throw new NotFoundError();
  return row;
}

/** Keep the metric name unique within the account, suffixing with `_2`, `_3`, … on collision. */
async function uniqueMetricName(db: D1Database, accountId: string, base: string): Promise<string> {
  if (!(await getMetricByName(db, accountId, base))) return base;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base}_${i}`;
    if (!(await getMetricByName(db, accountId, candidate))) return candidate;
  }
  return `${base}_${crypto.randomUUID().slice(0, 8)}`;
}

metrics.post("/", requireAuth, async (c) => {
  const auth = getAuth(c);
  requireAccountScope(auth);
  requireWrite(auth);
  if ((await countMetricsForAccount(c.env.DB, auth.account_id)) >= LIMITS.metricsPerAccount) {
    throw new ForbiddenError(`You have reached the limit of ${LIMITS.metricsPerAccount} metrics.`);
  }
  const attrs = await readAttributes(c);
  const parsed = parseMetric(attrs);
  const name = await uniqueMetricName(c.env.DB, auth.account_id, parsed.name);
  const row = await createMetric(c.env.DB, {
    account_id: auth.account_id,
    name,
    label: parsed.label,
    description: parsed.description,
    type: parsed.type,
    kind: parsed.kind,
    formula: parsed.formula ? JSON.stringify(parsed.formula) : null,
  });
  return resourceResponse(serializeMetric(row), { status: 201 });
});

metrics.get("/", requireAuth, async (c) => {
  const auth = getAuth(c);
  requireAccountScope(auth);
  const pagination = readPagination(c);
  const sort = readSort(c, "name", SORT_ALLOWED);
  const { rows, total } = await listMetrics(c.env.DB, {
    account_id: auth.account_id,
    sort,
    limit: pagination.limit,
    offset: pagination.offset,
    includeTotal: pagination.includeTotal,
  });
  return collectionResponse(rows.map(serializeMetric), {
    meta: { pagination: paginationMeta(pagination, total) },
  });
});

metrics.get("/:id", requireAuth, async (c) => {
  const auth = getAuth(c);
  requireAccountScope(auth);
  const row = await getMetricById(c.env.DB, c.req.param("id"));
  if (!row || row.account_id !== auth.account_id) throw new NotFoundError();
  return resourceResponse(serializeMetric(row));
});

metrics.put("/:id", requireAuth, async (c) => {
  const existing = await loadOwnedForWrite(c, c.req.param("id"));
  const attrs = await readAttributes(c);
  const parsed = parseMetric(attrs);
  const row = await updateMetric(c.env.DB, existing.id, {
    label: parsed.label,
    description: parsed.description,
    type: parsed.type,
    kind: parsed.kind,
    formula: parsed.formula ? JSON.stringify(parsed.formula) : null,
  });
  if (!row) throw new NotFoundError();
  return resourceResponse(serializeMetric(row));
});

metrics.delete("/:id", requireAuth, async (c) => {
  const existing = await loadOwnedForWrite(c, c.req.param("id"));
  // A metric snapshotted into a benchmark can't be deleted from the library while linked — unlink it
  // from those benchmarks first (keeps the join + each benchmark's schema snapshot consistent).
  const linked = await countBenchmarksForMetric(c.env.DB, existing.id);
  if (linked > 0) {
    throw new ConflictError(
      `This metric is linked to ${linked} benchmark${linked === 1 ? "" : "s"}; unlink it there before deleting.`,
    );
  }
  await deleteMetric(c.env.DB, existing.id);
  return noContentResponse();
});
