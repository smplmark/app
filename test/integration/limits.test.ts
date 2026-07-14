import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { LIMITS } from "../../src/limits";
import {
  apiGet,
  apiPost,
  bearer,
  makeAccountSubject,
  makeBenchmark,
  publish,
  register,
  resetDb,
  type Resource,
} from "./helpers";

beforeEach(resetDb);

/** Bulk-insert n rows via multi-row INSERTs (no bind-param limits; fast in miniflare). */
async function bulkInsert(table: string, columns: string, rows: string[]): Promise<void> {
  for (let i = 0; i < rows.length; i += 80) {
    await env.DB.prepare(
      `INSERT INTO ${table} (${columns}) VALUES ${rows.slice(i, i + 80).join(",")}`,
    ).run();
  }
}

describe("string-size limits (400)", () => {
  it("rejects over-limit benchmark fields", async () => {
    const { token } = await register();
    const post = (attrs: Record<string, unknown>) =>
      apiPost("/api/v1/benchmarks", { data: { type: "benchmark", attributes: attrs } }, bearer(token));
    expect((await post({ key: "k".repeat(LIMITS.keyLength + 1), name: "n" })).status).toBe(400);
    expect((await post({ key: "k", name: "n".repeat(LIMITS.nameLength + 1) })).status).toBe(400);
    expect(
      (await post({ key: "k", name: "n", description: "d".repeat(LIMITS.descriptionLength + 1) })).status,
    ).toBe(400);
    expect(
      (await post({ key: "k", name: "n", about: "a".repeat(LIMITS.longTextLength + 1) })).status,
    ).toBe(400);
    // At the limit is fine.
    expect(
      (await post({ key: "k".repeat(LIMITS.keyLength), name: "n".repeat(LIMITS.nameLength) })).status,
    ).toBe(201);
  });

  it("rejects over-limit subject and run fields", async () => {
    const { token } = await register();
    const bench = await makeBenchmark(token);
    const longKey = "k".repeat(LIMITS.keyLength + 1);
    const t = await apiPost(
      "/api/v1/subjects",
      { data: { type: "subject", attributes: { key: longKey, name: "T" } } },
      bearer(token),
    );
    expect(t.status).toBe(400);
    const r = await apiPost(
      "/api/v1/runs",
      {
        data: {
          type: "run",
          attributes: { benchmark: bench.id, key: "r", name: "n".repeat(LIMITS.nameLength + 1) },
        },
      },
      bearer(token),
    );
    expect(r.status).toBe(400);
  });
});

describe("count ceilings (409)", () => {
  it("caps benchmarks per account", async () => {
    const { token, account_id } = await register();
    const now = Date.now();
    await bulkInsert(
      "benchmark",
      "id, account_id, key, name, status, measurement_schema, created_at, updated_at, draft, category",
      Array.from(
        { length: LIMITS.benchmarksPerAccount },
        (_, i) => `('bulk-${i}', '${account_id}', 'bulk-${i}', 'B${i}', 'PRIVATE', '{}', ${now}, ${now}, 1, 'OTHER')`,
      ),
    );
    const res = await apiPost(
      "/api/v1/benchmarks",
      { data: { type: "benchmark", attributes: { key: "one-too-many", name: "N" } } },
      bearer(token),
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { errors: { detail: string }[] };
    expect(body.errors[0].detail).toContain(String(LIMITS.benchmarksPerAccount));
  });

  it("caps subjects linked to a benchmark", async () => {
    const { token, account_id } = await register();
    const bench = await makeBenchmark(token);
    const now = Date.now();
    const n = LIMITS.subjectsPerBenchmark;
    // Fill the benchmark to its link ceiling: n account-owned subjects, each linked once.
    await bulkInsert(
      "subject",
      "id, account_id, key, name, created_at, updated_at",
      Array.from(
        { length: n },
        (_, i) => `('bulk-t-${i}', '${account_id}', 'bulk-t-${i}', 'T${i}', ${now}, ${now})`,
      ),
    );
    await bulkInsert(
      "benchmark_subject",
      "id, benchmark_id, subject_id, created_at",
      Array.from({ length: n }, (_, i) => `('bulk-bt-${i}', '${bench.id}', 'bulk-t-${i}', ${now})`),
    );
    // One more subject, then linking it exceeds the per-benchmark cap.
    const extraId = (await makeAccountSubject(token, "extra")).id;
    const res = await apiPost(
      "/api/v1/benchmark_subjects",
      { data: { type: "benchmark_subject", attributes: { benchmark: bench.id, subject: extraId } } },
      bearer(token),
    );
    expect(res.status).toBe(409);
  });

  // Runs are per-benchmark now; the count ceiling (LIMITS.runsPerBenchmark = 20k) is too large to
  // bulk-insert, so the collision this test guards is run-key uniqueness *within a benchmark* (409).
  // runsPerSubject no longer exists — a run is a benchmark child, not a subject child.
  it("rejects a duplicate run key within a benchmark", async () => {
    const { token } = await register();
    const bench = await makeBenchmark(token);
    const post = () =>
      apiPost(
        "/api/v1/runs",
        { data: { type: "run", attributes: { benchmark: bench.id, key: "dup" } } },
        bearer(token),
      );
    expect((await post()).status).toBe(201);
    expect((await post()).status).toBe(409);
  });
});

describe("GET /runs?filter[benchmark]", () => {
  it("lists every run under a public benchmark in one request", async () => {
    const owner = await register();
    const bench = await makeBenchmark(owner.token);
    for (const key of ["r1", "r2", "r3"]) {
      const res = await apiPost(
        "/api/v1/runs",
        { data: { type: "run", attributes: { benchmark: bench.id, key } } },
        bearer(owner.token),
      );
      expect(res.status).toBe(201);
    }
    await publish(owner.token, owner.user_id, bench.id);

    const res = await apiGet(`/api/v1/runs?filter[benchmark]=${bench.id}`);
    expect(res.status).toBe(200);
    const doc = (await res.json()) as { data: Resource[] };
    expect(doc.data.length).toBe(3);
    expect(new Set(doc.data.map((r) => r.attributes.key))).toEqual(new Set(["r1", "r2", "r3"]));
  });

  it("404s when the benchmark scope filter is missing", async () => {
    // Runs are benchmark-scoped: filter[benchmark] is required, and its absence 404s (mirrors subjects.ts).
    expect((await apiGet("/api/v1/runs")).status).toBe(404);
  });

  it("hides private benchmarks from anonymous callers but serves the owner", async () => {
    const owner = await register();
    const bench = await makeBenchmark(owner.token);
    await apiPost(
      "/api/v1/runs",
      { data: { type: "run", attributes: { benchmark: bench.id, key: "r" } } },
      bearer(owner.token),
    );

    expect((await apiGet(`/api/v1/runs?filter[benchmark]=${bench.id}`)).status).toBe(404);
    const owned = await apiGet(`/api/v1/runs?filter[benchmark]=${bench.id}`, bearer(owner.token));
    expect(owned.status).toBe(200);
    expect(((await owned.json()) as { data: Resource[] }).data.length).toBe(1);

    const other = await register();
    expect(
      (await apiGet(`/api/v1/runs?filter[benchmark]=${bench.id}`, bearer(other.token))).status,
    ).toBe(404);
    expect((await apiGet("/api/v1/runs?filter[benchmark]=missing")).status).toBe(404);
  });
});
