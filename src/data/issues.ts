import type { IssueRow } from "../types";

export interface CreateIssueInput {
  benchmark_id: string;
  benchmark_key: string;
  publisher_slug: string;
  requester_name: string;
  requester_email: string;
  reason: string;
}

export async function createIssue(
  db: D1Database,
  input: CreateIssueInput,
): Promise<IssueRow> {
  const row: IssueRow = {
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
      "INSERT INTO issue (id, benchmark_id, benchmark_key, publisher_slug, requester_name, requester_email, reason, status, resolved_at, created_at) VALUES (?,?,?,?,?,?,?,?,NULL,?)",
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

/** Mark every open issue against a benchmark RESOLVED (called when the benchmark is removed). */
export async function resolveIssues(
  db: D1Database,
  benchmarkId: string,
  now: number,
): Promise<number> {
  const res = await db
    .prepare(
      "UPDATE issue SET status='RESOLVED', resolved_at=? WHERE benchmark_id=? AND status='OPEN'",
    )
    .bind(now, benchmarkId)
    .run();
  return res.meta.changes ?? 0;
}
