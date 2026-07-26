// Tags: free-form curated slugs, many-to-many with benchmark (tag + benchmark_tag, 0004). Tag rows
// are created on first attach. Orphaned tags (no remaining benchmark_tag rows) carry no data beyond
// their key, so pruning and recreation are lossless.
import { BadRequestError } from "../errors";

/** Lowercase slug: alnum start, then alnum / "." / "_" / "-", at most 40 chars. */
const TAG_KEY = /^[a-z0-9][a-z0-9._-]{0,39}$/;
export const MAX_TAGS_PER_BENCHMARK = 20;

const TAGS_POINTER = { pointer: "/data/attributes/tags" };

/** Normalize one tag key the way both writes and filter[tag] see it: trimmed, lowercased. */
export function normalizeTagKey(raw: string): string {
  return raw.trim().toLowerCase();
}

/**
 * Parse a request's `tags` attribute: an array of slug strings, normalized (slugs, not
 * SCREAMING_SNAKE_CASE enums), deduped, order-preserving. Absent → undefined so callers apply the
 * full-replace default; anything malformed → 400.
 */
export function optionalTags(
  attrs: Record<string, unknown>,
): string[] | undefined {
  if (!("tags" in attrs)) return undefined;
  const v = attrs.tags;
  if (!Array.isArray(v)) {
    throw new BadRequestError("tags must be an array of strings.", TAGS_POINTER);
  }
  const out: string[] = [];
  for (const item of v) {
    if (typeof item !== "string") {
      throw new BadRequestError("tags must be an array of strings.", TAGS_POINTER);
    }
    const key = normalizeTagKey(item);
    if (!TAG_KEY.test(key)) {
      throw new BadRequestError(
        `${JSON.stringify(item)} is not a valid tag: 1-40 characters — lowercase letters, digits, ".", "_", "-" — starting with a letter or digit.`,
        TAGS_POINTER,
      );
    }
    if (!out.includes(key)) out.push(key);
  }
  if (out.length > MAX_TAGS_PER_BENCHMARK) {
    throw new BadRequestError(
      `A benchmark can carry at most ${MAX_TAGS_PER_BENCHMARK} tags.`,
      TAGS_POINTER,
    );
  }
  return out;
}

/**
 * Full-replace a benchmark's tag set. Creates missing tag rows on the fly (INSERT OR IGNORE keyed
 * on the unique tag.key), then swaps the benchmark_tag links in the same batch.
 */
export async function setBenchmarkTags(
  db: D1Database,
  benchmarkId: string,
  keys: string[],
): Promise<void> {
  const now = Date.now();
  const stmts: D1PreparedStatement[] = [];
  for (const key of keys) {
    stmts.push(
      db
        .prepare("INSERT OR IGNORE INTO tag (id, key, created_at) VALUES (?,?,?)")
        .bind(crypto.randomUUID(), key, now),
    );
  }
  stmts.push(
    db.prepare("DELETE FROM benchmark_tag WHERE benchmark_id = ?").bind(benchmarkId),
  );
  for (const key of keys) {
    stmts.push(
      db
        .prepare(
          "INSERT INTO benchmark_tag (benchmark_id, tag_id, created_at) SELECT ?, id, ? FROM tag WHERE key = ?",
        )
        .bind(benchmarkId, now, key),
    );
  }
  await db.batch(stmts);
}

/** A benchmark's tag keys, sorted. */
export async function listTagsForBenchmark(
  db: D1Database,
  benchmarkId: string,
): Promise<string[]> {
  const rows = await db
    .prepare(
      "SELECT tag.key AS key FROM benchmark_tag JOIN tag ON tag.id = benchmark_tag.tag_id WHERE benchmark_tag.benchmark_id = ? ORDER BY tag.key",
    )
    .bind(benchmarkId)
    .all<{ key: string }>();
  return rows.results.map((r) => r.key);
}

// D1 caps bound parameters per query (~100), and a list page can hold up to 1000 benchmarks —
// chunk the IN list well under the cap.
const IN_CHUNK = 80;

/** Tag keys for a page of benchmarks in one round-trip per chunk: id → sorted keys. */
export async function listTagsForBenchmarks(
  db: D1Database,
  benchmarkIds: string[],
): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>();
  for (let i = 0; i < benchmarkIds.length; i += IN_CHUNK) {
    const chunk = benchmarkIds.slice(i, i + IN_CHUNK);
    const placeholders = chunk.map(() => "?").join(",");
    const rows = await db
      .prepare(
        `SELECT benchmark_tag.benchmark_id AS benchmark_id, tag.key AS key FROM benchmark_tag JOIN tag ON tag.id = benchmark_tag.tag_id WHERE benchmark_tag.benchmark_id IN (${placeholders}) ORDER BY tag.key`,
      )
      .bind(...chunk)
      .all<{ benchmark_id: string; key: string }>();
    for (const r of rows.results) {
      const list = map.get(r.benchmark_id);
      if (list) {
        list.push(r.key);
      } else {
        map.set(r.benchmark_id, [r.key]);
      }
    }
  }
  return map;
}
