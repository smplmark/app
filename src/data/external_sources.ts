// The external-source catalog: read-only rows maintained by the ingestion importer (there is no
// API write surface — every import run rebuilds the table alongside the system account's rows).
import { orderByClause, type Sort } from "../query/sort";
import type { ExternalSourceRow } from "../types";

const COLUMNS: Record<string, string> = {
  name: "name",
  key: "key",
  retrieved_at: "retrieved_at",
  benchmark_count: "benchmark_count",
};

export async function listExternalSources(
  db: D1Database,
  sort: Sort,
  page: { limit: number; offset: number; includeTotal: boolean },
): Promise<{ rows: ExternalSourceRow[]; total?: number }> {
  const order = orderByClause(sort, (f) => COLUMNS[f], "id");
  const rows = (
    await db
      .prepare(`SELECT * FROM external_source ${order} LIMIT ? OFFSET ?`)
      .bind(page.limit, page.offset)
      .all<ExternalSourceRow>()
  ).results;

  let total: number | undefined;
  if (page.includeTotal) {
    const r = await db
      .prepare("SELECT COUNT(*) AS n FROM external_source")
      .first<{ n: number }>();
    total = r?.n ?? 0;
  }
  return { rows, total };
}
