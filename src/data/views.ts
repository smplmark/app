// The popularity beacon's write path: one all-time counter bump on the benchmark plus an upsert
// into that benchmark's UTC-day bucket (benchmark_view_day) — the buckets feed the rolling-window
// sorts, and views_total stays recoverable as their sum (the ingestion importer relies on that to
// preserve popularity across re-ingests).
export async function recordBenchmarkView(
  db: D1Database,
  benchmarkId: string,
): Promise<void> {
  const day = new Date().toISOString().slice(0, 10);
  await db.batch([
    db
      .prepare("UPDATE benchmark SET views_total = views_total + 1 WHERE id = ?")
      .bind(benchmarkId),
    db
      .prepare(
        "INSERT INTO benchmark_view_day (benchmark_id, day, views) VALUES (?, ?, 1) ON CONFLICT (benchmark_id, day) DO UPDATE SET views = views + 1",
      )
      .bind(benchmarkId, day),
  ]);
}
