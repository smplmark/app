import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { createAccount } from "../../src/data/accounts";
import { createBenchmark } from "../../src/data/benchmarks";
import { createSubjectType } from "../../src/data/subject_types";
import {
  listTagsForBenchmark,
  listTagsForBenchmarks,
  normalizeTagKey,
  optionalTags,
  setBenchmarkTags,
} from "../../src/data/tags";
import { AppError } from "../../src/errors";

const TABLES = ["benchmark_tag", "tag", "benchmark", "subject_type", "account"];
beforeEach(async () => {
  for (const t of TABLES) await env.DB.prepare(`DELETE FROM ${t}`).run();
});

async function bench(key: string): Promise<string> {
  const account =
    (await env.DB.prepare("SELECT id FROM account LIMIT 1").first<{ id: string }>()) ??
    (await createAccount(env.DB, { key: `acct-${crypto.randomUUID()}`, name: "A" }));
  const subjectType =
    (await env.DB.prepare("SELECT id FROM subject_type LIMIT 1").first<{ id: string }>()) ??
    (await createSubjectType(env.DB, { account_id: account.id, key: "st", name: "ST", fields: [] }));
  const row = await createBenchmark(env.DB, {
    account_id: account.id, key, name: key, description: null, about: null,
    methodology: null, license: null, subject_type: subjectType.id, measurement_schema: { metrics: [], derived: [] },
    category: "OTHER", created_by_user_id: null,
  });
  return row.id;
}

function expect400(fn: () => unknown) {
  try {
    fn();
    throw new Error("expected a 400");
  } catch (e) {
    expect(e).toBeInstanceOf(AppError);
    expect((e as AppError).status).toBe(400);
  }
}

describe("normalizeTagKey / optionalTags", () => {
  it("normalizes, dedupes, and preserves order", () => {
    expect(normalizeTagKey("  GPU ")).toBe("gpu");
    expect(optionalTags({ tags: ["B", "a", " b "] })).toEqual(["b", "a"]);
    expect(optionalTags({})).toBeUndefined();
    expect(optionalTags({ tags: [] })).toEqual([]);
    expect(optionalTags({ tags: ["a1", "dot.und_er-dash"] })).toEqual(["a1", "dot.und_er-dash"]);
  });

  it("rejects non-arrays, non-strings, bad slugs, and oversize sets", () => {
    expect400(() => optionalTags({ tags: "gpu" }));
    expect400(() => optionalTags({ tags: [1] }));
    expect400(() => optionalTags({ tags: [""] }));
    expect400(() => optionalTags({ tags: ["-x"] }));
    expect400(() => optionalTags({ tags: ["café"] }));
    expect400(() => optionalTags({ tags: ["x".repeat(41)] }));
    expect400(() => optionalTags({ tags: Array.from({ length: 21 }, (_, i) => `t${i}`) }));
  });
});

describe("setBenchmarkTags / listTagsForBenchmark(s)", () => {
  it("attaches, reuses shared tag rows, replaces as a set, and clears", async () => {
    const b1 = await bench("b1");
    const b2 = await bench("b2");

    await setBenchmarkTags(env.DB, b1, ["gpu", "rendering"]);
    await setBenchmarkTags(env.DB, b2, ["gpu"]);
    expect(await listTagsForBenchmark(env.DB, b1)).toEqual(["gpu", "rendering"]);
    expect(await listTagsForBenchmark(env.DB, b2)).toEqual(["gpu"]);

    // "gpu" is one shared tag row, not two.
    const tagCount = await env.DB.prepare("SELECT COUNT(*) AS n FROM tag").first<{ n: number }>();
    expect(tagCount?.n).toBe(2);

    // Replace is a full swap; clearing leaves no links.
    await setBenchmarkTags(env.DB, b1, ["olap"]);
    expect(await listTagsForBenchmark(env.DB, b1)).toEqual(["olap"]);
    await setBenchmarkTags(env.DB, b1, []);
    expect(await listTagsForBenchmark(env.DB, b1)).toEqual([]);
    expect(await listTagsForBenchmark(env.DB, b2)).toEqual(["gpu"]);
  });

  it("batch lookup maps ids to sorted keys and chunks large id lists", async () => {
    const b1 = await bench("b1");
    const b2 = await bench("b2");
    await setBenchmarkTags(env.DB, b1, ["zeta", "alpha"]);
    await setBenchmarkTags(env.DB, b2, ["solo"]);

    // 85 ids exercises the >80 chunking path; unknown ids simply don't appear in the map.
    const ids = [b1, b2, ...Array.from({ length: 83 }, (_, i) => `missing-${i}`)];
    const map = await listTagsForBenchmarks(env.DB, ids);
    expect(map.get(b1)).toEqual(["alpha", "zeta"]);
    expect(map.get(b2)).toEqual(["solo"]);
    expect(map.size).toBe(2);

    expect((await listTagsForBenchmarks(env.DB, [])).size).toBe(0);
  });
});
