import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { apiGet, resetDb, type Resource } from "./helpers";

beforeEach(resetDb);

async function seedSource(key: string, name: string, over: Record<string, unknown> = {}) {
  const row = {
    description: `${name} results.`,
    url: `https://example.org/${key}`,
    license: "CC0-1.0",
    benchmark_count: 1,
    retrieved_at: 1_783_000_000_000,
    ...over,
  };
  await env.DB.prepare(
    "INSERT INTO external_source (id, key, name, description, url, license, benchmark_count, retrieved_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(
      `src-${key}`,
      key,
      name,
      row.description,
      row.url,
      row.license,
      row.benchmark_count,
      row.retrieved_at,
      row.retrieved_at,
      row.retrieved_at,
    )
    .run();
}

describe("external sources catalog", () => {
  it("lists sources anonymously, ordered by name", async () => {
    await seedSource("zeta", "Zeta Bench");
    await seedSource("alpha", "Alpha Data", { license: null, benchmark_count: 21 });

    const res = await apiGet("/api/v1/external_sources");
    expect(res.status).toBe(200);
    const doc = (await res.json()) as { data: Resource[] };
    expect(doc.data.map((r) => r.attributes.name)).toEqual(["Alpha Data", "Zeta Bench"]);

    const alpha = doc.data[0];
    expect(alpha.type).toBe("external_source");
    expect(alpha.id).toBe("src-alpha");
    expect(alpha.attributes).toEqual({
      key: "alpha",
      name: "Alpha Data",
      description: "Alpha Data results.",
      url: "https://example.org/alpha",
      license: null,
      benchmark_count: 21,
      retrieved_at: new Date(1_783_000_000_000).toISOString(),
    });
  });

  it("returns an empty collection when nothing has been ingested", async () => {
    const res = await apiGet("/api/v1/external_sources");
    expect(res.status).toBe(200);
    const doc = (await res.json()) as { data: Resource[] };
    expect(doc.data).toEqual([]);
  });

  it("paginates with opt-in totals like every other collection", async () => {
    await seedSource("a", "A");
    await seedSource("b", "B");
    await seedSource("c", "C");

    const res = await apiGet(
      "/api/v1/external_sources?page[size]=2&page[number]=2&meta[total]=true",
    );
    expect(res.status).toBe(200);
    const doc = (await res.json()) as {
      data: Resource[];
      meta: { pagination: { total: number; total_pages: number } };
    };
    expect(doc.data.map((r) => r.attributes.key)).toEqual(["c"]);
    expect(doc.meta.pagination.total).toBe(3);
    expect(doc.meta.pagination.total_pages).toBe(2);

    expect((await apiGet("/api/v1/external_sources?page[size]=0")).status).toBe(400);
  });

  it("sorts by any documented field and 400s on unknown ones", async () => {
    await seedSource("older", "Older", { retrieved_at: 1_000, benchmark_count: 9 });
    await seedSource("newer", "Newer", { retrieved_at: 2_000, benchmark_count: 1 });

    const byRetrieved = (await (
      await apiGet("/api/v1/external_sources?sort=-retrieved_at")
    ).json()) as { data: Resource[] };
    expect(byRetrieved.data.map((r) => r.attributes.key)).toEqual(["newer", "older"]);

    const byCount = (await (
      await apiGet("/api/v1/external_sources?sort=-benchmark_count")
    ).json()) as { data: Resource[] };
    expect(byCount.data.map((r) => r.attributes.key)).toEqual(["older", "newer"]);

    expect((await apiGet("/api/v1/external_sources?sort=-created_at")).status).toBe(400);
  });
});
