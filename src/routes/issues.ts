// Issues — the contact affordance on published/withdrawn benchmarks (public site and console).
// Filing an issue is NOT a delete: it records the report, notifies smplmark operators (best-effort
// email to support), and leaves the benchmark untouched. True removal happens only when an operator
// acts on the issue via the system endpoint (routes/jobs.ts).
//
// Unauthenticated by design — the reporter is usually a third party (a person named in the data,
// a rights holder), not the publisher — so it takes the strict IP rate limit like the other
// anonymous write surfaces.
import { Hono } from "hono";
import { emitAuditEvent } from "../audit/smpl_audit";
import { isPublicStatus } from "../authz";
import { getBenchmarkById } from "../data/benchmarks";
import { createIssue } from "../data/issues";
import { sendIssueReportedEmail } from "../email/resend";
import { NotFoundError } from "../errors";
import { requireString } from "../http/body";
import { resourceResponse } from "../http/jsonapi";
import type { AppBindings } from "../http/middleware";
import { rateLimit } from "../http/ratelimit";
import { LIMITS } from "../limits";
import { serializeIssue } from "../serialize/resource";
import { readAttributes } from "./shared";

export const issues = new Hono<AppBindings>();

issues.post("/", rateLimit((e) => e.RL_SENSITIVE), async (c) => {
  const attrs = await readAttributes(c);
  const benchmarkId = requireString(attrs, "benchmark");
  const requesterName = requireString(attrs, "requester_name", LIMITS.nameLength);
  const requesterEmail = requireString(attrs, "requester_email", LIMITS.nameLength);
  const reason = requireString(attrs, "reason", LIMITS.longTextLength);

  // Only world-visible benchmarks can be the object of an issue; a private id 404s without
  // leaking existence (there is nothing public to report).
  const benchmark = await getBenchmarkById(c.env.DB, benchmarkId);
  if (!benchmark || !isPublicStatus(benchmark.status)) throw new NotFoundError();

  const row = await createIssue(c.env.DB, {
    benchmark_id: benchmark.id,
    benchmark_key: benchmark.key,
    publisher_slug: benchmark.publisher_slug,
    requester_name: requesterName,
    requester_email: requesterEmail,
    reason,
  });

  // Route to operators: best-effort email (never wedges the request) + an internal audit event.
  // The reporter's identity lives in the issue row, the operator email, and the event's extra
  // payload (operator-queryable in Smpl Audit) — NEVER in the actor label: the owner-visible
  // History would otherwise hand the reporter's email to the publisher, the party the issue is
  // typically filed against.
  await sendIssueReportedEmail(c.env, {
    benchmarkName: benchmark.name,
    benchmarkRef: `${benchmark.publisher_slug}/${benchmark.key}`,
    benchmarkId: benchmark.id,
    requesterName,
    requesterEmail,
    reason,
    requestId: row.id,
  });
  emitAuditEvent(c, {
    event_type: "benchmark.issue_reported",
    resource_type: "issue",
    resource_id: row.id,
    benchmark_id: benchmark.id,
    visibility: "internal",
    description: "An issue was reported against this benchmark.",
    extra: { requester_name: requesterName, requester_email: requesterEmail, reason },
    actor: { type: "PUBLIC", id: null, label: null },
  });

  return resourceResponse(serializeIssue(row), { status: 201 });
});
