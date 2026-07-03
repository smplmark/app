// System / ops triggers called by Smpl Jobs (the smplkit scheduler), NOT by customers. These run
// cross-tenant, so they can't use the per-account API-key / session model; instead they authenticate
// with a shared Worker secret (JOBS_TRIGGER_SECRET) presented as `Authorization: Bearer <secret>`.
// Set it with `wrangler secret put JOBS_TRIGGER_SECRET` and configure the same value in Smpl Jobs.
//
// Deliberately absent from the public OpenAPI spec (ADR-014: the spec is customer-facing; this is an
// internal ops surface). Endpoints are idempotent so the scheduler can retry freely.
import { Hono } from "hono";
import { timingSafeEqual } from "../auth/crypto";
import { jobsTriggerConfigured } from "../config";
import { ServiceUnavailableError, UnauthorizedError } from "../errors";
import { parseBearer } from "../http/body";
import type { AppBindings } from "../http/middleware";
import { sweepVerifiedDomains } from "../publish/sweep";

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
