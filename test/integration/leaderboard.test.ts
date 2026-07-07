import { beforeEach, describe, expect, it } from "vitest";
import {
  apiGet,
  apiPost,
  bearer,
  makeBenchmark,
  makeMeasurement,
  makeRun,
  publish,
  register,
  resetDb,
  type Registered,
  type Resource,
} from "./helpers";

beforeEach(resetDb);

const SCHEMA = {
  metrics: [{ name: "score", type: "number", description: "score" }],
  derived: [],
  chart: { x: null, y: "score", x_kind: "CATEGORY" },
};

interface Sys {
  key: string;
  name: string;
  details: Record<string, unknown>;
  score: number;
}

const SYSTEMS: Sys[] = [
  { key: "alpha", name: "Alpha", details: { vendor: "AMD", sponsor: "Dell" }, score: 300 },
  { key: "bravo", name: "Bravo", details: { vendor: "Intel", sponsor: "Dell" }, score: 500 },
  { key: "charlie", name: "Charlie", details: { vendor: "AMD", sponsor: "HPE" }, score: 400 },
  { key: "delta", name: "Delta", details: { vendor: "Intel", sponsor: "Acme, Inc" }, score: 350 },
];

/** Build a published benchmark with SYSTEMS as targets (one run + one measurement each). */
async function seed(): Promise<{ owner: Registered; benchmark: Resource }> {
  const owner = await register();
  const benchmark = await makeBenchmark(owner.token, {
    key: "leaderboard-bench",
    name: "Leaderboard Bench",
    observation_schema: SCHEMA,
    category: "HARDWARE",
  });
  for (const s of SYSTEMS) {
    const t = await apiPost(
      "/api/v1/targets",
      { data: { type: "target", attributes: { benchmark: benchmark.id, key: s.key, name: s.name, details: s.details } } },
      bearer(owner.token),
    );
    expect(t.status).toBe(201);
    const target = ((await t.json()) as { data: Resource }).data;
    // Runs are benchmark children now; a run key is unique within the benchmark, so key it per system.
    const run = await makeRun(owner.token, benchmark.id, { key: s.key });
    await makeMeasurement(owner.token, run.id, target.id, { metrics: { score: s.score } });
  }
  await publish(owner.token, owner.user_id, benchmark.id);
  return { owner, benchmark };
}

interface Entry {
  id: string;
  attributes: { key: string; name: string; details: Record<string, unknown> | null; metrics: Record<string, number> };
}
interface Facet {
  field: string;
  values: { value: string; count: number }[];
  truncated: boolean;
}
async function board(id: string, query = ""): Promise<{ keys: string[]; total?: number; sort: string; facets: Facet[]; entries: Entry[] }> {
  const res = await apiGet(`/api/v1/benchmarks/${id}/leaderboard${query}`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { data: Entry[]; meta: { pagination: { total?: number }; sort: string; facets: Facet[] } };
  return {
    keys: body.data.map((e) => e.attributes.key),
    total: body.meta.pagination.total,
    sort: body.meta.sort,
    facets: body.meta.facets,
    entries: body.data,
  };
}

describe("benchmark leaderboard", () => {
  it("defaults to the chart metric, descending, and reports total + facets", async () => {
    const { benchmark } = await seed();
    const r = await board(benchmark.id, "?meta[total]=true");
    expect(r.sort).toBe("-score");
    expect(r.keys).toEqual(["bravo", "charlie", "delta", "alpha"]); // 500,400,350,300
    expect(r.total).toBe(4);
    expect(r.entries[0].attributes.metrics.score).toBe(500);

    const vendor = r.facets.find((f) => f.field === "vendor")!;
    expect(Object.fromEntries(vendor.values.map((v) => [v.value, v.count]))).toEqual({ AMD: 2, Intel: 2 });
    const sponsor = r.facets.find((f) => f.field === "sponsor")!;
    expect(Object.fromEntries(sponsor.values.map((v) => [v.value, v.count]))).toEqual({ Dell: 2, HPE: 1, "Acme, Inc": 1 });
  });

  it("sorts ascending when the sign is dropped", async () => {
    const { benchmark } = await seed();
    const r = await board(benchmark.id, "?sort=score");
    expect(r.keys).toEqual(["alpha", "delta", "charlie", "bravo"]); // 300,350,400,500
  });

  it("filters by a facet value (OR within a field), counting the filtered set", async () => {
    const { benchmark } = await seed();
    const amd = await board(benchmark.id, "?filter[facet.vendor]=AMD&meta[total]=true");
    expect(amd.total).toBe(2);
    expect(amd.keys).toEqual(["charlie", "alpha"]); // 400, 300

    const both = await board(benchmark.id, "?filter[facet.vendor]=AMD&filter[facet.vendor]=Intel&meta[total]=true");
    expect(both.total).toBe(4);
  });

  it("computes disjunctive facet counts: a filtered facet keeps its other values", async () => {
    const { benchmark } = await seed();
    // Filter vendor=AMD. The Vendor facet must still show BOTH vendors (its own filter is excluded
    // when counting it), so you can add Intel — while Sponsor (unfiltered) reflects the AMD filter.
    const r = await board(benchmark.id, "?filter[facet.vendor]=AMD");
    const vendor = r.facets.find((f) => f.field === "vendor")!;
    expect(Object.fromEntries(vendor.values.map((v) => [v.value, v.count]))).toEqual({ AMD: 2, Intel: 2 });
    const sponsor = r.facets.find((f) => f.field === "sponsor")!;
    // Only the two AMD rows (alpha=Dell, charlie=HPE) remain in the sponsor breakdown.
    expect(Object.fromEntries(sponsor.values.map((v) => [v.value, v.count]))).toEqual({ Dell: 1, HPE: 1 });

    // Cross-facet still ANDs: vendor=AMD AND sponsor=Dell → just alpha; the vendor facet, counted
    // with its own filter removed, now reflects the sponsor=Dell narrowing (Dell has 1 AMD, 1 Intel).
    const both = await board(benchmark.id, "?filter[facet.vendor]=AMD&filter[facet.sponsor]=Dell&meta[total]=true");
    expect(both.total).toBe(1);
    expect(both.keys).toEqual(["alpha"]);
    const v2 = both.facets.find((f) => f.field === "vendor")!;
    expect(Object.fromEntries(v2.values.map((v) => [v.value, v.count]))).toEqual({ AMD: 1, Intel: 1 });
  });

  it("treats a facet value with a comma literally (repeated params, no comma-splitting)", async () => {
    const { benchmark } = await seed();
    const r = await board(benchmark.id, `?filter[facet.sponsor]=${encodeURIComponent("Acme, Inc")}&meta[total]=true`);
    expect(r.total).toBe(1);
    expect(r.keys).toEqual(["delta"]);
  });

  it("free-text search matches the target name and details", async () => {
    const { benchmark } = await seed();
    expect((await board(benchmark.id, "?filter[search]=bravo")).keys).toEqual(["bravo"]);
    // details value ("HPE") is searchable too
    expect((await board(benchmark.id, "?filter[search]=hpe")).keys).toEqual(["charlie"]);
  });

  it("paginates", async () => {
    const { benchmark } = await seed();
    const page2 = await board(benchmark.id, "?page[size]=2&page[number]=2&meta[total]=true");
    expect(page2.keys).toEqual(["delta", "alpha"]); // 3rd and 4th of 500,400,350,300
    expect(page2.total).toBe(4);
  });

  it("downloads the entire current filter as CSV or JSON (not just a page)", async () => {
    const { benchmark } = await seed();
    const csv = await apiGet(`/api/v1/benchmarks/${benchmark.id}/leaderboard`, { Accept: "text/csv" });
    expect(csv.status).toBe(200);
    expect(csv.headers.get("content-type")).toContain("text/csv");
    const text = await csv.text();
    const lines = text.trim().split(/\r?\n/);
    expect(lines[0]).toContain("key,name,score"); // header: fixed cols + metric + detail cols
    expect(lines).toHaveLength(5); // header + all 4 systems (not paginated)
    expect(text).toContain('"Acme, Inc"'); // a comma-bearing value is RFC-4180 quoted

    const json = await apiGet(`/api/v1/benchmarks/${benchmark.id}/leaderboard?page[size]=2&format=json`);
    expect(json.status).toBe(200);
    expect(json.headers.get("content-disposition")).toContain(".json");
    expect(((await json.json()) as { data: unknown[] }).data).toHaveLength(4); // full set, page[size] ignored
  });

  it("rejects an unknown sort field and 404s a private/absent benchmark", async () => {
    const { benchmark } = await seed();
    expect((await apiGet(`/api/v1/benchmarks/${benchmark.id}/leaderboard?sort=nonsuch`)).status).toBe(400);
    expect((await apiGet("/api/v1/benchmarks/does-not-exist/leaderboard")).status).toBe(404);
  });
});
