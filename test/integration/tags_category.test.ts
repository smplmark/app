import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  addMember,
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

function post(token: string, attrs: Record<string, unknown>) {
  return apiPost(
    "/api/v1/benchmarks",
    { data: { type: "benchmark", attributes: { key: "b", name: "B", ...attrs } } },
    bearer(token),
  );
}

describe("benchmark category + tags", () => {
  it("defaults to category OTHER and no tags", async () => {
    const { token } = await register();
    const res = await post(token, {});
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: Resource };
    expect(data.attributes.category).toBe("OTHER");
    expect(data.attributes.tags).toEqual([]);
  });

  it("accepts category (case-insensitive) and normalized, deduped tags on create", async () => {
    const { token } = await register();
    const res = await post(token, {
      category: "hardware",
      tags: ["GPU", " rendering ", "gpu"],
    });
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: Resource };
    expect(data.attributes.category).toBe("HARDWARE");
    expect(data.attributes.tags).toEqual(["gpu", "rendering"]);

    // Round-trips through GET (read back from benchmark_tag, sorted).
    const got = await apiGet(`/api/v1/benchmarks/${data.id}`, bearer(token));
    const doc = (await got.json()) as { data: Resource };
    expect(doc.data.attributes.tags).toEqual(["gpu", "rendering"]);
    expect(doc.data.attributes.category).toBe("HARDWARE");
  });

  it("400s on a bad category, non-array tags, bad slugs, and too many tags", async () => {
    const { token } = await register();
    expect((await post(token, { category: "SPACESHIP" })).status).toBe(400);
    expect((await post(token, { tags: "gpu" })).status).toBe(400);
    expect((await post(token, { tags: [42] })).status).toBe(400);
    expect((await post(token, { tags: ["-leading-dash"] })).status).toBe(400);
    expect((await post(token, { tags: ["has space"] })).status).toBe(400);
    expect((await post(token, { tags: ["x".repeat(41)] })).status).toBe(400);
    expect(
      (await post(token, { tags: Array.from({ length: 21 }, (_, i) => `t${i}`) })).status,
    ).toBe(400);
  });

  it("PUT full-replaces tags and category (and clears them when omitted)", async () => {
    const { token } = await register();
    const bench = await makeBenchmark(token, { tags: ["one", "two"], category: "DATABASE" });

    const put = await apiPut(
      `/api/v1/benchmarks/${bench.id}`,
      {
        data: {
          type: "benchmark",
          attributes: {
            name: "Renamed",
            observation_schema: SKEW_SCHEMA,
            tags: ["three"],
            category: "NETWORK",
          },
        },
      },
      bearer(token),
    );
    expect(put.status).toBe(200);
    const updated = ((await put.json()) as { data: Resource }).data;
    expect(updated.attributes.tags).toEqual(["three"]);
    expect(updated.attributes.category).toBe("NETWORK");

    // Omitting tags/category is a full-replace back to the defaults.
    const cleared = await apiPut(
      `/api/v1/benchmarks/${bench.id}`,
      { data: { type: "benchmark", attributes: { name: "Renamed", observation_schema: SKEW_SCHEMA } } },
      bearer(token),
    );
    expect(cleared.status).toBe(200);
    const clearedData = ((await cleared.json()) as { data: Resource }).data;
    expect(clearedData.attributes.tags).toEqual([]);
    expect(clearedData.attributes.category).toBe("OTHER");
  });

  it("tags/category stay editable after publish (browse metadata, not semantic core)", async () => {
    const owner = await register();
    const bench = await makeBenchmark(owner.token, { tags: ["old"] });
    await publish(owner.token, owner.user_id, bench.id);

    const put = await apiPut(
      `/api/v1/benchmarks/${bench.id}`,
      {
        data: {
          type: "benchmark",
          attributes: {
            name: "Scheduler Latency",
            observation_schema: SKEW_SCHEMA,
            tags: ["new-tag"],
            category: "NETWORK",
          },
        },
      },
      bearer(owner.token),
    );
    expect(put.status).toBe(200);
    const updated = ((await put.json()) as { data: Resource }).data;
    expect(updated.attributes.tags).toEqual(["new-tag"]);
    expect(updated.attributes.category).toBe("NETWORK");
  });
});

describe("filter[tag] and filter[category]", () => {
  async function publishedTrio(): Promise<Registered> {
    const owner = await register();
    const a = await makeBenchmark(owner.token, {
      key: "a", name: "A", category: "HARDWARE", tags: ["gpu", "rendering"],
    });
    const b = await makeBenchmark(owner.token, {
      key: "b", name: "B", category: "DATABASE", tags: ["olap"],
    });
    const c = await makeBenchmark(owner.token, { key: "c", name: "C" });
    await publish(owner.token, owner.user_id, a.id);
    await publish(owner.token, owner.user_id, b.id);
    await publish(owner.token, owner.user_id, c.id);
    return owner;
  }

  it("filters the public list by tag, category, and both (AND)", async () => {
    await publishedTrio();

    const byTag = (await (await apiGet("/api/v1/benchmarks?filter[tag]=gpu")).json()) as {
      data: Resource[];
    };
    expect(byTag.data.map((r) => r.attributes.key)).toEqual(["a"]);

    const byCategory = (await (
      await apiGet("/api/v1/benchmarks?filter[category]=DATABASE")
    ).json()) as { data: Resource[] };
    expect(byCategory.data.map((r) => r.attributes.key)).toEqual(["b"]);

    // Case-insensitive enum input; tag input normalized like writes.
    const lower = (await (
      await apiGet("/api/v1/benchmarks?filter[category]=database")
    ).json()) as { data: Resource[] };
    expect(lower.data.map((r) => r.attributes.key)).toEqual(["b"]);
    const spacedTag = (await (
      await apiGet(`/api/v1/benchmarks?filter[tag]=${encodeURIComponent(" GPU ")}`)
    ).json()) as { data: Resource[] };
    expect(spacedTag.data.map((r) => r.attributes.key)).toEqual(["a"]);

    const both = (await (
      await apiGet("/api/v1/benchmarks?filter[tag]=gpu&filter[category]=DATABASE")
    ).json()) as { data: Resource[] };
    expect(both.data).toEqual([]);

    const none = (await (await apiGet("/api/v1/benchmarks?filter[tag]=nope")).json()) as {
      data: Resource[];
    };
    expect(none.data).toEqual([]);
  });

  it("400s on an unknown filter[category]", async () => {
    const res = await apiGet("/api/v1/benchmarks?filter[category]=SPACESHIP");
    expect(res.status).toBe(400);
  });

  it("carries tags on list responses and respects meta[total] with a tag filter", async () => {
    await publishedTrio();
    const res = await apiGet(
      "/api/v1/benchmarks?filter[tag]=rendering&meta[total]=true",
    );
    const doc = (await res.json()) as {
      data: Resource[];
      meta: { pagination: { total?: number } };
    };
    expect(doc.data.length).toBe(1);
    expect(doc.data[0].attributes.tags).toEqual(["gpu", "rendering"]);
    expect(doc.meta.pagination.total).toBe(1);
  });
});

describe("INGESTED benchmarks (importer-seeded)", () => {
  /** Insert a published INGESTED benchmark directly, the way the ingestion importer does. */
  async function insertIngested(): Promise<string> {
    const id = crypto.randomUUID();
    const snapshot = JSON.stringify({
      source_name: "Blender Open Data",
      source_url: "https://opendata.blender.org",
      license: "CC0",
      retrieved_at: 1783123200000,
    });
    await env.DB.prepare(
      "INSERT INTO account (id, key, name, created_at, allow_personal_publish) VALUES ('acct-system', 'system', 'smplmark', 1783123200000, 0)",
    ).run();
    await env.DB.prepare(
      `INSERT INTO benchmark (id, account_id, key, name, description, status, published_at,
         observation_schema, created_at, updated_at, draft, published_as_kind, attribution_snapshot, category)
       VALUES (?, 'acct-system', 'blender-open-data', 'Blender Open Data', 'Render performance', 'PUBLISHED',
         1783123200000, '{"metrics":[{"name":"median_score","type":"number"}],"derived":[]}',
         1783123200000, 1783123200000, 0, 'INGESTED', ?, 'HARDWARE')`,
    )
      .bind(id, snapshot)
      .run();
    return id;
  }

  it("serves an INGESTED benchmark publicly with full source provenance", async () => {
    const id = await insertIngested();
    const res = await apiGet(`/api/v1/benchmarks/${id}`);
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: Resource };
    expect(data.attributes.published_as).toEqual({
      kind: "INGESTED",
      source_name: "Blender Open Data",
      source_url: "https://opendata.blender.org",
      license: "CC0",
      retrieved_at: "2026-07-04T00:00:00.000Z",
    });
    expect(data.attributes.published_by).toBeNull();
    expect(data.attributes.category).toBe("HARDWARE");
  });

  it("the DB CHECK admits INGESTED (0004 rebuild) and rejects unknown kinds", async () => {
    await insertIngested();
    await expect(
      env.DB.prepare(
        `INSERT INTO benchmark (id, account_id, key, name, status, observation_schema, created_at, updated_at, draft, published_as_kind)
         VALUES (?, 'acct-system', 'bad', 'Bad', 'PUBLISHED', '{}', 0, 0, 0, 'ALIEN')`,
      )
        .bind(crypto.randomUUID())
        .run(),
    ).rejects.toThrow(/CHECK/);
  });

  it("withdraw authority for an INGESTED benchmark requires an admin (not the author rule)", async () => {
    // A member's own account with a benchmark force-marked INGESTED: the MEMBER author must be
    // rejected by the admin gate (under the personal rule the author would have passed).
    const owner = await register();
    const { user, memberToken } = await addMember(
      owner.token,
      owner.account_id,
      `member-${Date.now()}@example.com`,
      "MEMBER",
    );
    const bench = await makeBenchmark(memberToken);
    await publish(memberToken, user.user_id, bench.id);
    await env.DB.prepare(
      "UPDATE benchmark SET published_as_kind = 'INGESTED', attribution_snapshot = ? WHERE id = ?",
    )
      .bind(
        JSON.stringify({
          source_name: "S", source_url: "https://s", license: "CC0", retrieved_at: 0,
        }),
        bench.id,
      )
      .run();

    const denied = await apiPost(
      `/api/v1/benchmarks/${bench.id}/actions/withdraw`,
      { data: { type: "benchmark", attributes: { withdrawal_reason: "cleanup" } } },
      bearer(memberToken),
    );
    expect(denied.status).toBe(403);

    const allowed = await apiPost(
      `/api/v1/benchmarks/${bench.id}/actions/withdraw`,
      { data: { type: "benchmark", attributes: { withdrawal_reason: "cleanup" } } },
      bearer(owner.token),
    );
    expect(allowed.status).toBe(200);
  });
});
