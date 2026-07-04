import { describe, expect, it } from "vitest";
// The ingestion lib is plain ESM JavaScript (Node-side tooling, gen-seed.mjs precedent); its pure
// modules are imported here so vitest covers the logic the importer runs.
import { LIMITS as WORKER_LIMITS } from "../../src/limits";
import { LIMITS as IMPORTER_LIMITS } from "../../ingestion/lib/limits.mjs";
import { epochMsOrNull, slugify, uniqueSlug } from "../../ingestion/lib/model.mjs";
import { isPathAllowed, parseRobots } from "../../ingestion/lib/robots.mjs";
import { sampleBenchmarks } from "../../ingestion/lib/sampler.mjs";
import {
  buildInsertSql,
  buildWipeSql,
  n,
  q,
  SYSTEM_ACCOUNT_ID,
} from "../../ingestion/lib/sql.mjs";

describe("limits parity", () => {
  it("the importer's mirror of src/limits.ts is identical", () => {
    expect(IMPORTER_LIMITS).toEqual(WORKER_LIMITS);
  });
});

describe("model helpers", () => {
  it("slugify: lowercases, strips punctuation, trims dashes, never empty", () => {
    expect(slugify("AMD Ryzen 9 7950X (16-Core)")).toBe("amd-ryzen-9-7950x-16-core");
    expect(slugify("  Intel(R) Core(TM) i9 ")).toBe("intel-r-core-tm-i9");
    expect(slugify("™☂")).toBe("unnamed");
    expect(slugify("x".repeat(100)).length).toBeLessThanOrEqual(80);
  });

  it("uniqueSlug: suffixes collisions deterministically", () => {
    const seen = new Map<string, number>();
    expect(uniqueSlug("GPU!", seen)).toBe("gpu");
    expect(uniqueSlug("gpu", seen)).toBe("gpu-2");
    expect(uniqueSlug("G.P.U", seen)).toBe("g-p-u");
  });

  it("epochMsOrNull: ISO, bare dates, garbage", () => {
    expect(epochMsOrNull("2026-07-04")).toBe(Date.UTC(2026, 6, 4));
    expect(epochMsOrNull("2026-07-04T12:00:00Z")).toBe(Date.UTC(2026, 6, 4, 12));
    expect(epochMsOrNull("2019-08-22 17:43:17")).not.toBeNull();
    expect(epochMsOrNull("not a date")).toBeNull();
    expect(epochMsOrNull("")).toBeNull();
    expect(epochMsOrNull(undefined)).toBeNull();
  });
});

describe("robots", () => {
  it("empty/missing robots.txt allows everything", () => {
    expect(isPathAllowed(parseRobots(null), "/anything")).toBe(true);
    expect(isPathAllowed(parseRobots(""), "/anything")).toBe(true);
  });

  it("blender's actual robots.txt: /snapshots/ blocked, query endpoint allowed", () => {
    const rules = parseRobots("User-agent: *\nDisallow: /snapshots/\n");
    expect(isPathAllowed(rules, "/snapshots/opendata-latest.zip")).toBe(false);
    expect(isPathAllowed(rules, "/benchmarks/query/")).toBe(true);
  });

  it("only the * group applies; comments and empty Disallow are handled", () => {
    const rules = parseRobots(
      "User-agent: gptbot\nDisallow: /\n\nUser-agent: *\nDisallow:  # allow all\n",
    );
    expect(isPathAllowed(rules, "/anywhere")).toBe(true);
  });

  it("longest match wins; Allow can carve out a Disallow; wildcards and $ anchor work", () => {
    const rules = parseRobots(
      "User-agent: *\nDisallow: /api/\nAllow: /api/v1/\nDisallow: /*/tree/\nDisallow: /private$\n",
    );
    expect(isPathAllowed(rules, "/api/internal")).toBe(false);
    expect(isPathAllowed(rules, "/api/v1/evaluation/list")).toBe(true);
    expect(isPathAllowed(rules, "/ClickHouse/ClickBench/tree/main")).toBe(false);
    expect(isPathAllowed(rules, "/private")).toBe(false);
    expect(isPathAllowed(rules, "/private/thing")).toBe(true);
  });

  it("consecutive user-agent lines share a group; a later group resets", () => {
    const rules = parseRobots(
      "User-agent: a\nUser-agent: *\nDisallow: /x/\n\nUser-agent: b\nDisallow: /y/\n",
    );
    expect(isPathAllowed(rules, "/x/1")).toBe(false);
    expect(isPathAllowed(rules, "/y/1")).toBe(true);
  });
});

describe("sql builders", () => {
  it("q escapes quotes; n rejects non-finite numbers", () => {
    expect(q("O'Brien's \"GPU\"")).toBe("'O''Brien''s \"GPU\"'");
    expect(q(null)).toBe("NULL");
    expect(n(12.5)).toBe("12.5");
    expect(n(null)).toBe("NULL");
    expect(() => n(Number.NaN)).toThrow(/finite/);
    expect(() => n("12" as unknown as number)).toThrow(/finite/);
  });

  it("wipe is scoped to the system account and never truncates", () => {
    const wipe = buildWipeSql();
    // Child-first order: observation → run → target → benchmark_tag → benchmark → orphan tags.
    expect(wipe.map((s) => s.split(" ")[2])).toEqual([
      "observation",
      "run",
      "target",
      "benchmark_tag",
      "benchmark",
      "tag",
    ]);
    for (const s of wipe.slice(0, 5)) {
      expect(s).toContain(SYSTEM_ACCOUNT_ID);
    }
    expect(wipe.join(" ")).not.toMatch(/DELETE FROM (observation|run|target|benchmark)\s*$/m);
  });

  const bench = (over: Record<string, unknown> = {}) => ({
    key: "demo",
    name: "Demo",
    description: "d",
    about: "a",
    methodology: "m",
    category: "HARDWARE" as const,
    tags: ["gpu"],
    sampleSchema: { metrics: [{ name: "score", type: "number" }], derived: [], chart: { x: null, y: "score", x_kind: "CATEGORY" } },
    targets: [
      {
        key: "t1",
        name: "Target 1 with 'quote'",
        runs: [
          {
            key: "r1",
            observations: [{ created_at: 1000, metrics: { score: 1.5 }, meta: { note: "x" } }],
          },
        ],
      },
    ],
    ...over,
  });
  const source = {
    key: "demo-src",
    name: "Demo Source",
    url: "https://example.org",
    license: "CC0-1.0",
    licenseUrl: "https://example.org/license",
    robotsOrigin: "https://example.org",
  };

  it("builds deterministic INGESTED inserts with frozen attribution", () => {
    const { statements, counts } = buildInsertSql([
      { benchmark: bench() as never, source, retrievedAt: 5000 },
    ]);
    const joined = statements.join("\n");
    expect(counts).toEqual({ benchmarks: 1, targets: 1, runs: 1, observations: 1, tag_links: 1, clamped: 0 });
    expect(joined).toContain("'INGESTED'");
    expect(joined).toContain('\'{"source_name":"Demo Source","source_url":"https://example.org","license":"CC0-1.0","retrieved_at":5000}\'');
    expect(joined).toContain("'ing-demo'");
    expect(joined).toContain("'ing-demo-t-t1'");
    expect(joined).toContain("'ing-demo-t-t1-r-r1'");
    expect(joined).toContain("Target 1 with ''quote''");
    // Benchmarks are born PUBLISHED, non-draft, under the system account.
    expect(joined).toMatch(/'PUBLISHED', 5000/);
    expect(joined).toContain("INSERT OR IGNORE INTO account");
    // Identical input → identical output (reviewable diffs).
    expect(buildInsertSql([{ benchmark: bench() as never, source, retrievedAt: 5000 }]).statements).toEqual(statements);
  });

  it("rejects duplicate keys loudly", () => {
    expect(() =>
      buildInsertSql([
        { benchmark: bench() as never, source, retrievedAt: 1 },
        { benchmark: bench() as never, source, retrievedAt: 1 },
      ]),
    ).toThrow(/duplicate benchmark key/);
    expect(() =>
      buildInsertSql([
        {
          benchmark: bench({
            targets: [
              { key: "t1", name: "a", runs: [] },
              { key: "t1", name: "b", runs: [] },
            ],
          }) as never,
          source,
          retrievedAt: 1,
        },
      ]),
    ).toThrow(/duplicate target key/);
  });

  it("enforces the platform count limits and key lengths, and clamps display strings", () => {
    // Too many runs on one target → throws (structural).
    expect(() =>
      buildInsertSql([
        {
          benchmark: bench({
            targets: [
              {
                key: "t1",
                name: "T",
                runs: Array.from({ length: WORKER_LIMITS.runsPerTarget + 1 }, (_, i) => ({
                  key: `r${i}`,
                  observations: [],
                })),
              },
            ],
          }) as never,
          source,
          retrievedAt: 1,
        },
      ]),
    ).toThrow(/runs exceeds the platform limit/);
    // Over-long key → throws (identity is never clamped).
    expect(() =>
      buildInsertSql([
        {
          benchmark: bench({
            targets: [{ key: "k".repeat(WORKER_LIMITS.keyLength + 1), name: "T", runs: [] }],
          }) as never,
          source,
          retrievedAt: 1,
        },
      ]),
    ).toThrow(/key exceeds/);
    // Over-long display name → clamped with an ellipsis and counted.
    const { statements, counts } = buildInsertSql([
      {
        benchmark: bench({
          targets: [
            { key: "t1", name: "N".repeat(WORKER_LIMITS.nameLength + 50), runs: [] },
          ],
        }) as never,
        source,
        retrievedAt: 1,
      },
    ]);
    expect(counts.clamped).toBe(1);
    expect(statements.join("\n")).toContain("N".repeat(WORKER_LIMITS.nameLength - 1) + "…");
  });

  it("chunks huge insert sets into multiple bounded statements", () => {
    const targets = Array.from({ length: 300 }, (_, i) => ({
      key: `t${i}`,
      name: `Target ${i}`,
      runs: [{ key: "r", observations: [{ created_at: 1, metrics: { score: i } }] }],
    }));
    const { statements } = buildInsertSql([
      { benchmark: bench({ targets }) as never, source, retrievedAt: 1 },
    ]);
    const targetInserts = statements.filter((s) => s.startsWith("INSERT INTO target"));
    expect(targetInserts.length).toBeGreaterThan(1);
    for (const s of statements) expect(s.length).toBeLessThan(100_000);
  });
});

describe("sampler", () => {
  const mk = (nTargets: number) => [
    {
      key: "b",
      name: "B",
      description: "",
      about: "",
      methodology: "",
      category: "OTHER" as const,
      tags: [],
      sampleSchema: {},
      targets: Array.from({ length: nTargets }, (_, i) => ({
        key: `t${i}`,
        name: `T${i}`,
        // t3 is multi-run; t7 carries a null metric; observation counts ramp with i.
        runs:
          i === 3
            ? [
                { key: "r1", observations: [{ created_at: 1, metrics: { s: 1 } }] },
                { key: "r2", observations: [{ created_at: 2, metrics: { s: 2 } }] },
              ]
            : [
                {
                  key: "r1",
                  observations: Array.from({ length: i + 1 }, (_, j) => ({
                    created_at: j,
                    metrics: { s: i === 7 ? (null as unknown as number) : j },
                  })),
                },
              ],
      })),
    },
  ];

  it("passes through when no limit or under the limit", () => {
    const benchmarks = mk(5);
    expect(sampleBenchmarks(benchmarks as never, undefined)).toBe(benchmarks);
    expect(sampleBenchmarks(benchmarks as never, 10)[0].targets.length).toBe(5);
  });

  it("samples representatively: exact size, spread across the list, edge cases included", () => {
    const [sampled] = sampleBenchmarks(mk(100) as never, 10);
    expect(sampled.targets.length).toBe(10);
    const keys = sampled.targets.map((t: { key: string }) => t.key);
    // Not head-of-file: something from the back half must be present.
    expect(keys.some((k: string) => Number(k.slice(1)) >= 50)).toBe(true);
    // Edge cases: the multi-run target and the null-metric target survive sampling.
    expect(keys).toContain("t3");
    expect(keys).toContain("t7");
    // Busiest (t99) and sparsest (t0) survive.
    expect(keys).toContain("t99");
    expect(keys).toContain("t0");
  });
});
