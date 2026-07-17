// Takedown requests — the contact affordance on published/withdrawn benchmarks (public site and
// console). Filing one is NOT a delete: it records the request, notifies smplmark operators
// (best-effort email to support), and leaves the benchmark untouched. True removal happens only
// when an operator fulfills the request via the system endpoint (routes/jobs.ts).
//
// Unauthenticated by design — the requester is usually a third party (a person named in the data,
// a rights holder), not the publisher — so it takes the strict IP rate limit like the other
// anonymous write surfaces.
import { Hono } from "hono";
import { emitAuditEvent } from "../audit/smpl_audit";
import { isPublicStatus } from "../authz";
import { getBenchmarkById } from "../data/benchmarks";
import { createTakedownRequest } from "../data/takedown_requests";
import { sendTakedownRequestEmail } from "../email/resend";
import { NotFoundError } from "../errors";
import { requireString } from "../http/body";
import { resourceResponse } from "../http/jsonapi";
import type { AppBindings } from "../http/middleware";
import { rateLimit } from "../http/ratelimit";
import { LIMITS } from "../limits";
import { serializeTakedownRequest } from "../serialize/resource";
import { readAttributes } from "./shared";

export const takedownRequests = new Hono<AppBindings>();

takedownRequests.post("/", rateLimit((e) => e.RL_SENSITIVE), async (c) => {
  const attrs = await readAttributes(c);
  const benchmarkId = requireString(attrs, "benchmark");
  const requesterName = requireString(attrs, "requester_name", LIMITS.nameLength);
  const requesterEmail = requireString(attrs, "requester_email", LIMITS.nameLength);
  const reason = requireString(attrs, "reason", LIMITS.longTextLength);

  // Only world-visible benchmarks can be the object of a takedown; a private id 404s without
  // leaking existence (there is nothing public to take down).
  const benchmark = await getBenchmarkById(c.env.DB, benchmarkId);
  if (!benchmark || !isPublicStatus(benchmark.status)) throw new NotFoundError();

  const row = await createTakedownRequest(c.env.DB, {
    benchmark_id: benchmark.id,
    benchmark_key: benchmark.key,
    publisher_slug: benchmark.publisher_slug,
    requester_name: requesterName,
    requester_email: requesterEmail,
    reason,
  });

  // Route to operators: best-effort email (never wedges the request) + an internal audit event.
  // The requester's identity lives in the takedown_request row, the operator email, and the
  // event's extra payload (operator-queryable in Smpl Audit) — NEVER in the actor label: the
  // owner-visible History would otherwise hand the requester's email to the publisher, the party
  // the takedown is typically filed against.
  await sendTakedownRequestEmail(c.env, {
    benchmarkName: benchmark.name,
    benchmarkRef: `${benchmark.publisher_slug}/${benchmark.key}`,
    benchmarkId: benchmark.id,
    requesterName,
    requesterEmail,
    reason,
    requestId: row.id,
  });
  emitAuditEvent(c, {
    event_type: "benchmark.takedown_requested",
    resource_type: "takedown_request",
    resource_id: row.id,
    benchmark_id: benchmark.id,
    visibility: "internal",
    description: "A takedown of this benchmark was requested.",
    extra: { requester_name: requesterName, requester_email: requesterEmail, reason },
    actor: { type: "PUBLIC", id: null, label: null },
  });

  return resourceResponse(serializeTakedownRequest(row), { status: 201 });
});
