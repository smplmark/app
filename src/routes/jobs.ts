// System / ops triggers called by Smpl Jobs (the smplkit scheduler) or a smplmark operator, NOT by
// customers. These run cross-tenant, so they can't use the per-account API-key / session model;
// instead they authenticate with a shared Worker secret (JOBS_TRIGGER_SECRET) presented as
// `Authorization: Bearer <secret>`. Set it with `wrangler secret put JOBS_TRIGGER_SECRET` and
// configure the same value in Smpl Jobs.
//
// Deliberately absent from the public OpenAPI spec (the spec is customer-facing; this is an
// internal ops surface). Endpoints are idempotent so the scheduler can retry freely.
import { Hono } from "hono";
import { emitAuditEvent } from "../audit/smpl_audit";
import { timingSafeEqual } from "../auth/crypto";
import { jobsTriggerConfigured } from "../config";
import { deleteBenchmarkCascade, getBenchmarkById } from "../data/benchmarks";
import { resolveIssues } from "../data/issues";
import { BadRequestError, NotFoundError, ServiceUnavailableError, UnauthorizedError } from "../errors";
import { parseBearer } from "../http/body";
import type { AppBindings } from "../http/middleware";
import { sweepVerifiedDomains } from "../publish/sweep";
import { readJsonObject } from "./shared";

export const jobs = new Hono<AppBindings>();

/** Gate a system-job endpoint on the shared secret. 503 if unconfigured, 401 if the token is wrong. */
function requireJobsSecret(env: Env, authorization: string | undefined): void {
  if (!jobsTriggerConfigured(env)) {
    throw new ServiceUnavailableError("Scheduled jobs are not configured for this deployment.");
  }
  const presented = parseBearer(authorization);
  if (presented === null || !timingSafeEqual(presented, env.JOBS_TRIGGER_SECRET as string)) {
    throw new UnauthorizedError();
  }
}

/**
 * Re-check every TXT-verified publisher domain and lapse any whose DNS record has disappeared (the
 * periodic sweep, driven externally instead of by a Workers cron). Idempotent and bounded; never
 * touches a published benchmark's frozen attribution snapshot. Returns counts for the caller to log.
 */
jobs.post("/domain-recheck", async (c) => {
  requireJobsSecret(c.env, c.req.header("Authorization"));
  const result = await sweepVerifiedDomains(c.env.DB);
  return c.json(result);
});

/**
 * Operator-only TRUE delete of a benchmark — the only way a published record ever vanishes. Used to
 * act on reported issues and legal/PII removals; never exposed to publishers (their exit is
 * withdrawal). The removal itself is recorded in Smpl Audit (who, when, why) even though the
 * benchmark is gone — the one event that must outlive its resource. Plain-JSON body:
 * { benchmark_id, reason, removed_by? }.
 */
jobs.post("/benchmark-removal", async (c) => {
  requireJobsSecret(c.env, c.req.header("Authorization"));
  const body = await readJsonObject(c);
  const benchmarkId = typeof body.benchmark_id === "string" && body.benchmark_id.length > 0 ? body.benchmark_id : null;
  if (benchmarkId === null) throw new BadRequestError("benchmark_id is required.");
  const reason = typeof body.reason === "string" && body.reason.length > 0 ? body.reason : null;
  if (reason === null) throw new BadRequestError("reason is required.");
  const removedBy = typeof body.removed_by === "string" ? body.removed_by : null;

  const benchmark = await getBenchmarkById(c.env.DB, benchmarkId);
  if (!benchmark) throw new NotFoundError();

  // Record the removal BEFORE the delete: this event must exist even though the benchmark won't.
  emitAuditEvent(c, {
    event_type: "benchmark.removed",
    resource_type: "benchmark",
    resource_id: benchmark.id,
    benchmark_id: benchmark.id,
    visibility: "public",
    description: "Benchmark removed by smplmark operators in response to a reported issue.",
    extra: {
      reason,
      benchmark_key: benchmark.key,
      publisher_slug: benchmark.publisher_slug,
      status_at_removal: benchmark.status,
    },
    actor: { type: "OPERATOR", id: removedBy, label: removedBy },
  });
  await deleteBenchmarkCascade(c.env.DB, benchmark.id);
  const resolved = await resolveIssues(c.env.DB, benchmark.id, Date.now());
  return c.json({ deleted: true, benchmark_id: benchmark.id, issues_resolved: resolved });
});
