import type { TakedownRequestRow } from "../types";

export interface CreateTakedownRequestInput {
  benchmark_id: string;
  benchmark_key: string;
  publisher_slug: string;
  requester_name: string;
  requester_email: string;
  reason: string;
}

export async function createTakedownRequest(
  db: D1Database,
  input: CreateTakedownRequestInput,
): Promise<TakedownRequestRow> {
  const row: TakedownRequestRow = {
    id: crypto.randomUUID(),
    benchmark_id: input.benchmark_id,
    benchmark_key: input.benchmark_key,
    publisher_slug: input.publisher_slug,
    requester_name: input.requester_name,
    requester_email: input.requester_email,
    reason: input.reason,
    status: "OPEN",
    resolved_at: null,
    created_at: Date.now(),
  };
  await db
    .prepare(
      "INSERT INTO takedown_request (id, benchmark_id, benchmark_key, publisher_slug, requester_name, requester_email, reason, status, resolved_at, created_at) VALUES (?,?,?,?,?,?,?,?,NULL,?)",
    )
    .bind(
      row.id,
      row.benchmark_id,
      row.benchmark_key,
      row.publisher_slug,
      row.requester_name,
      row.requester_email,
      row.reason,
      row.status,
      row.created_at,
    )
    .run();
  return row;
}

/** Mark every open request against a benchmark RESOLVED (called when a takedown is fulfilled). */
export async function resolveTakedownRequests(
  db: D1Database,
  benchmarkId: string,
  now: number,
): Promise<number> {
  const res = await db
    .prepare(
      "UPDATE takedown_request SET status='RESOLVED', resolved_at=? WHERE benchmark_id=? AND status='OPEN'",
    )
    .bind(now, benchmarkId)
    .run();
  return res.meta.changes ?? 0;
}
