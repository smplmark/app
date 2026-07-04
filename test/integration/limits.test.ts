import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { LIMITS } from "../../src/limits";
import {
  apiGet,
  apiPost,
  bearer,
  makeBenchmark,
  makeTarget,
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

  it("rejects over-limit target and run fields", async () => {
    const { token } = await register();
    const bench = await makeBenchmark(token);
    const longKey = "k".repeat(LIMITS.keyLength + 1);
    const t = await apiPost(
      "/api/v1/targets",
      { data: { type: "target", attributes: { benchmark: bench.id, key: longKey, name: "T" } } },
      bearer(token),
    );
    expect(t.status).toBe(400);
    const target = await makeTarget(token, bench.id);
    const r = await apiPost(
      "/api/v1/runs",
      {
        data: {
          type: "run",
          attributes: { target: target.id, key: "r", name: "n".repeat(LIMITS.nameLength + 1) },
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
      "id, account_id, key, name, status, sample_schema, created_at, updated_at, draft, category",
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

  it("caps targets per benchmark", async () => {
    const { token } = await register();
    const bench = await makeBenchmark(token);
    const now = Date.now();
    await bulkInsert(
      "target",
      "id, benchmark_id, key, name, created_at, updated_at",
      Array.from(
        { length: LIMITS.targetsPerBenchmark },
        (_, i) => `('bulk-t-${i}', '${bench.id}', 'bulk-t-${i}', 'T${i}', ${now}, ${now})`,
      ),
    );
    const res = await apiPost(
      "/api/v1/targets",
      { data: { type: "target", attributes: { benchmark: bench.id, key: "extra", name: "T" } } },
      bearer(token),
    );
    expect(res.status).toBe(409);
  });

  it("caps runs per target", async () => {
    const { token } = await register();
    const bench = await makeBenchmark(token);
    const target = await makeTarget(token, bench.id);
    const now = Date.now();
    await bulkInsert(
      "run",
      "id, target_id, key, created_at, updated_at",
      Array.from(
        { length: LIMITS.runsPerTarget },
        (_, i) => `('bulk-r-${i}', '${target.id}', 'bulk-r-${i}', ${now}, ${now})`,
      ),
    );
    const res = await apiPost(
      "/api/v1/runs",
      { data: { type: "run", attributes: { target: target.id, key: "extra" } } },
      bearer(token),
    );
    expect(res.status).toBe(409);
  });
});

describe("GET /runs?filter[benchmark]", () => {
  it("lists every run under a public benchmark across targets, in one request", async () => {
    const owner = await register();
    const bench = await makeBenchmark(owner.token);
    const t1 = await makeTarget(owner.token, bench.id, "t1");
    const t2 = await makeTarget(owner.token, bench.id, "t2");
    for (const [t, key] of [
      [t1, "r1"],
      [t1, "r2"],
      [t2, "r3"],
    ] as [Resource, string][]) {
      const res = await apiPost(
        "/api/v1/runs",
        { data: { type: "run", attributes: { target: t.id, key } } },
        bearer(owner.token),
      );
      expect(res.status).toBe(201);
    }
    await publish(owner.token, owner.user_id, bench.id);

    const res = await apiGet(`/api/v1/runs?filter[benchmark]=${bench.id}`);
    expect(res.status).toBe(200);
    const doc = (await res.json()) as { data: Resource[] };
    expect(doc.data.length).toBe(3);
    expect(new Set(doc.data.map((r) => r.attributes.target))).toEqual(new Set([t1.id, t2.id]));
  });

  it("400s on neither/both scope filters", async () => {
    expect((await apiGet("/api/v1/runs")).status).toBe(400);
    expect((await apiGet("/api/v1/runs?filter[target]=x&filter[benchmark]=y")).status).toBe(400);
  });

  it("hides private benchmarks from anonymous callers but serves the owner", async () => {
    const owner = await register();
    const bench = await makeBenchmark(owner.token);
    const target = await makeTarget(owner.token, bench.id);
    await apiPost(
      "/api/v1/runs",
      { data: { type: "run", attributes: { target: target.id, key: "r" } } },
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
