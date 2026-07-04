import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  apiGet,
  apiPost,
  apiPut,
  bearer,
  makeBenchmark,
  publish,
  register,
  resetDb,
  SKEW_SCHEMA,
  type Registered,
  type Resource,
} from "./helpers";

beforeEach(resetDb);

async function keysFor(url: string): Promise<string[]> {
  const res = await apiGet(url);
  expect(res.status).toBe(200);
  return ((await res.json()) as { data: Resource[] }).data.map(
    (b) => b.attributes.key as string,
  );
}

describe("filter[search]", () => {
  async function publishedFixtures(): Promise<Registered> {
    const owner = await register();
    const a = await makeBenchmark(owner.token, {
      key: "blender-cpu", name: "Blender Benchmark — CPU",
      description: "Cycles CPU render performance", tags: ["rendering", "cpu"],
      category: "HARDWARE",
    });
    const b = await makeBenchmark(owner.token, {
      key: "helm", name: "HELM Capabilities",
      about: "Frontier language models scored on five demanding scenarios",
      category: "ML_AI",
    });
    await publish(owner.token, owner.user_id, a.id);
    await publish(owner.token, owner.user_id, b.id);
    return owner;
  }

  it("matches name, about, tags, and category case-insensitively; ANDs terms", async () => {
    await publishedFixtures();
    expect(await keysFor("/api/v1/benchmarks?filter[search]=BLENDER")).toEqual(["blender-cpu"]);
    // about text
    expect(await keysFor("/api/v1/benchmarks?filter[search]=frontier%20scenarios")).toEqual(["helm"]);
    // tag word
    expect(await keysFor("/api/v1/benchmarks?filter[search]=rendering")).toEqual(["blender-cpu"]);
    // AND semantics: both terms must hit the same benchmark
    expect(await keysFor("/api/v1/benchmarks?filter[search]=blender%20language")).toEqual([]);
    // category word
    expect(await keysFor("/api/v1/benchmarks?filter[search]=ml_ai")).toEqual(["helm"]);
  });

  it("quoted phrases match contiguously; unquoted words match anywhere", async () => {
    await publishedFixtures();
    // "render performance" appears contiguously in blender's description only.
    expect(
      await keysFor("/api/v1/benchmarks?filter[search]=%22render%20performance%22"),
    ).toEqual(["blender-cpu"]);
    // The same words in the wrong order as a phrase → no match; as bare words → match.
    expect(
      await keysFor("/api/v1/benchmarks?filter[search]=%22performance%20render%22"),
    ).toEqual([]);
    expect(
      await keysFor("/api/v1/benchmarks?filter[search]=performance%20render"),
    ).toEqual(["blender-cpu"]);
  });

  it("treats LIKE metacharacters literally and 400s on oversized queries", async () => {
    const owner = await publishedFixtures();
    const c = await makeBenchmark(owner.token, {
      key: "pct", name: "100%_uptime probe",
    });
    await publish(owner.token, owner.user_id, c.id);
    expect(await keysFor("/api/v1/benchmarks?filter[search]=100%25_uptime")).toEqual(["pct"]);
    // A bare % must not act as a wildcard that matches everything.
    expect(await keysFor("/api/v1/benchmarks?filter[search]=zzz%25zzz")).toEqual([]);
    expect((await apiGet("/api/v1/benchmarks?filter[search]=" + "x".repeat(200))).status).toBe(400);
  });

  it("search_text follows updates and tag changes", async () => {
    const owner = await register();
    const bench = await makeBenchmark(owner.token, { key: "b", name: "Original", tags: ["oldtag"] });
    await publish(owner.token, owner.user_id, bench.id);
    expect(await keysFor("/api/v1/benchmarks?filter[search]=oldtag")).toEqual(["b"]);

    const put = await apiPut(
      `/api/v1/benchmarks/${bench.id}`,
      {
        data: {
          type: "benchmark",
          attributes: { name: "Renamed Xyzzy", observation_schema: SKEW_SCHEMA, tags: ["newtag"] },
        },
      },
      bearer(owner.token),
    );
    expect(put.status).toBe(200);
    expect(await keysFor("/api/v1/benchmarks?filter[search]=xyzzy%20newtag")).toEqual(["b"]);
    expect(await keysFor("/api/v1/benchmarks?filter[search]=oldtag")).toEqual([]);
  });
});

describe("view beacon + popularity sorts", () => {
  it("counts views for public benchmarks and surfaces them on the resource", async () => {
    const owner = await register();
    const bench = await makeBenchmark(owner.token);
    await publish(owner.token, owner.user_id, bench.id);

    for (let i = 0; i < 3; i++) {
      const res = await apiPost(`/api/v1/benchmarks/${bench.id}/actions/view`, undefined);
      expect(res.status).toBe(204);
    }
    const doc = (await (await apiGet(`/api/v1/benchmarks/${bench.id}`)).json()) as {
      data: Resource;
    };
    expect(doc.data.attributes.views).toBe(3);

    // Today's bucket exists with the same count.
    const day = new Date().toISOString().slice(0, 10);
    const bucket = await env.DB.prepare(
      "SELECT views FROM benchmark_view_day WHERE benchmark_id = ? AND day = ?",
    )
      .bind(bench.id, day)
      .first<{ views: number }>();
    expect(bucket?.views).toBe(3);
  });

  it("404s for private and unknown benchmarks (no existence leak)", async () => {
    const owner = await register();
    const bench = await makeBenchmark(owner.token);
    expect((await apiPost(`/api/v1/benchmarks/${bench.id}/actions/view`, undefined)).status).toBe(404);
    expect((await apiPost("/api/v1/benchmarks/missing/actions/view", undefined)).status).toBe(404);
  });

  it("windowed sorts use the day buckets; all-time uses the counter", async () => {
    const owner = await register();
    const oldie = await makeBenchmark(owner.token, { key: "oldie", name: "Oldie" });
    const hot = await makeBenchmark(owner.token, { key: "hot", name: "Hot" });
    await publish(owner.token, owner.user_id, oldie.id);
    await publish(owner.token, owner.user_id, hot.id);

    // Oldie: 10 views a year ago. Hot: 2 views today (via the real beacon).
    const yearAgo = new Date(Date.now() - 300 * 86_400_000).toISOString().slice(0, 10);
    await env.DB.prepare(
      "INSERT INTO benchmark_view_day (benchmark_id, day, views) VALUES (?, ?, 10)",
    )
      .bind(oldie.id, yearAgo)
      .run();
    await env.DB.prepare("UPDATE benchmark SET views_total = 10 WHERE id = ?")
      .bind(oldie.id)
      .run();
    await apiPost(`/api/v1/benchmarks/${hot.id}/actions/view`, undefined);
    await apiPost(`/api/v1/benchmarks/${hot.id}/actions/view`, undefined);

    expect(await keysFor("/api/v1/benchmarks?sort=-views_week")).toEqual(["hot", "oldie"]);
    expect(await keysFor("/api/v1/benchmarks?sort=-views_year")).toEqual(["oldie", "hot"]);
    expect(await keysFor("/api/v1/benchmarks?sort=-views")).toEqual(["oldie", "hot"]);
    // Windowed sort composes with filters.
    expect(await keysFor("/api/v1/benchmarks?sort=-views_week&filter[search]=hot")).toEqual(["hot"]);
    // Unknown sort field still 400s.
    expect((await apiGet("/api/v1/benchmarks?sort=-views_hourly")).status).toBe(400);
  });
});
