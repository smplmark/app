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
    // Naive timestamps (no offset) read as UTC — machine-local parsing would skew imports.
    expect(epochMsOrNull("2019-08-22 17:43:17")).toBe(Date.UTC(2019, 7, 22, 17, 43, 17));
    expect(epochMsOrNull("2019-02-21T18:47:13")).toBe(Date.UTC(2019, 1, 21, 18, 47, 13));
    expect(epochMsOrNull("2025-03-20T12:17:27.000Z")).toBe(Date.UTC(2025, 2, 20, 12, 17, 27));
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

  it("wipe is scoped to ingested data, prunes the legacy account, and never truncates", () => {
    const wipe = buildWipeSql();
    // Child-first order: measurement → benchmark_subject → run → subject → benchmark_tag → benchmark →
    // orphan tags → the now-orphaned legacy shared account.
    expect(wipe.map((s) => s.split(" ")[2])).toEqual([
      "measurement",
      "benchmark_subject",
      "run",
      "subject",
      "subject_type",
      "benchmark_tag",
      "benchmark",
      "tag",
      "account",
    ]);
    // Every subtree delete is scoped — by benchmark kind (INGESTED) or by the deterministic `ing-`
    // id prefix for the account-owned subjects/types — never a bare truncate. Publisher accounts stay intact.
    for (const s of wipe.slice(0, 7)) {
      expect(s).toMatch(/published_as_kind = 'INGESTED'|LIKE 'ing-/);
    }
    // Only the legacy shared account is touched, and only when it owns nothing.
    expect(wipe[8]).toContain("DELETE FROM account");
    expect(wipe[8]).toContain(SYSTEM_ACCOUNT_ID);
    expect(wipe[8]).toContain("NOT EXISTS");
    expect(wipe.join(" ")).not.toMatch(/DELETE FROM (measurement|benchmark_subject|run|subject|benchmark)\s*$/m);
  });

  const bench = (over: Record<string, unknown> = {}) => ({
    key: "demo",
    name: "Demo",
    description: "d",
    about: "a",
    methodology: "m",
    category: "HARDWARE" as const,
    tags: ["gpu"],
    measurementSchema: { metrics: [{ name: "score", type: "number" }], derived: [], chart: { x: null, y: "score", x_kind: "CATEGORY" } },
    subjects: [{ key: "t1", name: "Subject 1 with 'quote'" }],
    runs: [{ key: "r1" }],
    measurements: [{ run_key: "r1", subject_key: "t1", created_at: 1000, metrics: { score: 1.5 }, meta: { note: "x" } }],
    ...over,
  });
  const source = {
    key: "demo-src",
    publisher: { slug: "demo-pub", name: "Demo Publisher" },
    name: "Demo Source",
    description: "Demo results.",
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
    expect(counts).toEqual({ accounts: 1, subject_types: 1, benchmarks: 1, subjects: 1, benchmark_subjects: 1, runs: 1, measurements: 1, tag_links: 1, sources: 1, clamped: 0 });
    expect(joined).toContain("'INGESTED'");
    expect(joined).toContain('\'{"source_name":"Demo Source","source_url":"https://example.org","license":"CC0-1.0","retrieved_at":5000}\'');
    // Benchmark/run ids fold the publisher slug + benchmark key in; the subject is account-owned, so
    // its id is `ing-<slug>-t-<key>` (no benchmark segment) and it's linked in via benchmark_subject.
    expect(joined).toContain("'ing-demo-pub-demo'");
    expect(joined).toContain("INSERT INTO subject (id, account_id, subject_type_id, key, name, details, created_at, updated_at)");
    expect(joined).toContain("'ing-demo-pub-t-t1', 'acct-demo-pub', 'ing-st-demo-pub', 't1',");
    expect(joined).toContain("'ing-demo-pub-demo-r-r1'");
    // The M:N link joins the benchmark to the account-owned subject.
    expect(joined).toContain("INSERT INTO benchmark_subject (id, benchmark_id, subject_id, created_at)");
    expect(joined).toContain("('ing-demo-pub-demo-bt-ing-demo-pub-t-t1', 'ing-demo-pub-demo', 'ing-demo-pub-t-t1', 5000)");
    // The measurement names both the run and the (account-owned) subject ids.
    expect(joined).toContain("INSERT INTO measurement (run_id, subject_id, created_at, metrics, meta, client_ip)");
    expect(joined).toContain("('ing-demo-pub-demo-r-r1', 'ing-demo-pub-t-t1', 1000,");
    expect(joined).toContain("Subject 1 with ''quote''");
    // Benchmarks are born PUBLISHED, non-draft, owned by the publisher account.
    expect(joined).toMatch(/'PUBLISHED', 5000/);
    expect(joined).toContain("'ing-demo-pub-demo', 'acct-demo-pub', 'demo',");
    // …and CLOSED unconditionally (closed_at = retrievedAt): an ingested benchmark is a snapshot,
    // never a live feed, regardless of what the adapter emitted. The trailing column is closed_at.
    expect(joined).toContain("'HARDWARE', 5000)");
    // One idempotent publisher account per source, created before its benchmarks.
    expect(joined).toContain(
      "INSERT OR IGNORE INTO account (id, key, name, description, created_at, allow_personal_publish) VALUES ('acct-demo-pub', 'demo-pub', 'Demo Publisher', 'Demo results.', 5000, 0)",
    );
    // The source catalog is rebuilt alongside the benchmark subtree, on retrieved_at stamps.
    expect(joined).toContain("DELETE FROM external_source");
    expect(joined).toContain(
      "INSERT INTO external_source (id, key, name, description, url, license, license_url, benchmark_count, retrieved_at, created_at, updated_at) VALUES ('src-demo-src', 'demo-src', 'Demo Source', 'Demo results.', 'https://example.org', 'CC0-1.0', 'https://example.org/license', 1, 5000, 5000, 5000)",
    );
    // Identical input → identical output (reviewable diffs).
    expect(buildInsertSql([{ benchmark: bench() as never, source, retrievedAt: 5000 }]).statements).toEqual(statements);
  });

  it("prefers the source's publication date for published_at, falling back to retrieved_at", () => {
    const dated = buildInsertSql([
      { benchmark: bench({ published_at: 4321 }) as never, source, retrievedAt: 5000 },
    ]).statements.join("\n");
    expect(dated).toMatch(/'PUBLISHED', 4321/);
    // created_at/updated_at stay at retrieved_at — only the publication moment mirrors the source.
    expect(dated).toMatch(/'PUBLISHED', 4321, NULL, NULL, '.*', 5000, 5000/);
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
            subjects: [
              { key: "t1", name: "a" },
              { key: "t1", name: "b" },
            ],
          }) as never,
          source,
          retrievedAt: 1,
        },
      ]),
    ).toThrow(/duplicate subject key/);
    // Run keys are unique within the benchmark now (not per-subject).
    expect(() =>
      buildInsertSql([
        {
          benchmark: bench({ runs: [{ key: "r1" }, { key: "r1" }] }) as never,
          source,
          retrievedAt: 1,
        },
      ]),
    ).toThrow(/duplicate run key/);
  });

  it("rejects a measurement referencing an unknown run or subject", () => {
    expect(() =>
      buildInsertSql([
        {
          benchmark: bench({
            measurements: [{ run_key: "ghost", subject_key: "t1", created_at: 1, metrics: {} }],
          }) as never,
          source,
          retrievedAt: 1,
        },
      ]),
    ).toThrow(/unknown run/);
    expect(() =>
      buildInsertSql([
        {
          benchmark: bench({
            measurements: [{ run_key: "r1", subject_key: "ghost", created_at: 1, metrics: {} }],
          }) as never,
          source,
          retrievedAt: 1,
        },
      ]),
    ).toThrow(/unknown subject/);
  });

  it("collapses a comparative sweep to one run spanning many subjects", () => {
    const { counts, statements } = buildInsertSql([
      {
        benchmark: bench({
          subjects: [
            { key: "t1", name: "A" },
            { key: "t2", name: "B" },
            { key: "t3", name: "C" },
          ],
          runs: [{ key: "sweep" }],
          measurements: [
            { run_key: "sweep", subject_key: "t1", created_at: 1, metrics: { score: 1 } },
            { run_key: "sweep", subject_key: "t2", created_at: 1, metrics: { score: 2 } },
            { run_key: "sweep", subject_key: "t3", created_at: 1, metrics: { score: 3 } },
          ],
        }) as never,
        source,
        retrievedAt: 1,
      },
    ]);
    expect(counts.runs).toBe(1);
    expect(counts.subjects).toBe(3);
    expect(counts.measurements).toBe(3);
    const joined = statements.join("\n");
    // One run row, three measurements all naming it — and no subject segment in the run id.
    expect(joined).toContain("'ing-demo-pub-demo-r-sweep'");
    expect(joined).not.toContain("-t-t1-r-");
  });

  it("dedups a subject shared across a source's benchmarks by source_external_id (M:N)", () => {
    const shared = (key: string) =>
      bench({
        key,
        subjects: [{ key: "gpt4", name: "GPT-4", source_external_id: "openai/gpt-4" }],
        runs: [{ key: "r1" }],
        measurements: [{ run_key: "r1", subject_key: "gpt4", created_at: 1, metrics: { score: 1 } }],
      });
    const { counts, statements } = buildInsertSql([
      { benchmark: shared("b1") as never, source, retrievedAt: 1 },
      { benchmark: shared("b2") as never, source, retrievedAt: 1 },
    ]);
    // One shared account-owned subject row, linked into both benchmarks.
    expect(counts.accounts).toBe(1);
    expect(counts.benchmarks).toBe(2);
    expect(counts.subjects).toBe(1);
    expect(counts.benchmark_subjects).toBe(2);
    const joined = statements.join("\n");
    // Exactly one subject INSERT row for the shared id, and two distinct links to it.
    expect((joined.match(/'ing-demo-pub-t-gpt4', 'acct-demo-pub'/g) ?? []).length).toBe(1);
    expect(joined).toContain("('ing-demo-pub-b1-bt-ing-demo-pub-t-gpt4', 'ing-demo-pub-b1', 'ing-demo-pub-t-gpt4', 1)");
    expect(joined).toContain("('ing-demo-pub-b2-bt-ing-demo-pub-t-gpt4', 'ing-demo-pub-b2', 'ing-demo-pub-t-gpt4', 1)");
  });

  it("suffixes an account-unique key when two distinct subjects collide (no source_external_id)", () => {
    // Two benchmarks of one source each define a different subject that slugs to the same key.
    const b = (key: string, name: string) =>
      bench({
        key,
        subjects: [{ key: "node", name }],
        runs: [{ key: "r1" }],
        measurements: [{ run_key: "r1", subject_key: "node", created_at: 1, metrics: { score: 1 } }],
      });
    const { counts, statements } = buildInsertSql([
      { benchmark: b("b1", "Node A") as never, source, retrievedAt: 1 },
      { benchmark: b("b2", "Node B") as never, source, retrievedAt: 1 },
    ]);
    // No dedup: two distinct account subjects, the second suffixed to stay unique per account.
    expect(counts.subjects).toBe(2);
    expect(counts.benchmark_subjects).toBe(2);
    const joined = statements.join("\n");
    expect(joined).toContain("'ing-demo-pub-t-node', 'acct-demo-pub', 'ing-st-demo-pub', 'node',");
    expect(joined).toContain("'ing-demo-pub-t-node-2', 'acct-demo-pub', 'ing-st-demo-pub', 'node-2',");
    // The measurement still resolves via each benchmark's local key ("node") to the right subject.
    expect(joined).toContain("'ing-demo-pub-t-node-2', 1,");
  });

  it("allows the same (run, subject) pair more than once — repeated measurements are valid", () => {
    // A run can measure a subject multiple times (no unique constraint); two local keys folded onto
    // one subject by source_external_id, both measured under one run, is legitimate repeated data.
    const { counts } = buildInsertSql([
      {
        benchmark: bench({
          subjects: [
            { key: "ta", name: "A", source_external_id: "SAME" },
            { key: "tb", name: "B", source_external_id: "SAME" },
          ],
          runs: [{ key: "r1" }],
          measurements: [
            { run_key: "r1", subject_key: "ta", created_at: 1, metrics: { score: 1 } },
            { run_key: "r1", subject_key: "tb", created_at: 1, metrics: { score: 2 } },
          ],
        }) as never,
        source,
        retrievedAt: 1,
      },
    ]);
    expect(counts.subjects).toBe(1); // both fold onto one subject
    expect(counts.measurements).toBe(2); // …with two measurements under the one run
  });

  it("scopes benchmark-key uniqueness to the publisher: the same key under two sources coexists", () => {
    const other = {
      ...source,
      key: "other-src",
      publisher: { slug: "other-pub", name: "Other Publisher" },
    };
    const { statements, counts } = buildInsertSql([
      { benchmark: bench() as never, source, retrievedAt: 1 },
      { benchmark: bench() as never, source: other, retrievedAt: 1 },
    ]);
    expect(counts.benchmarks).toBe(2);
    expect(counts.accounts).toBe(2);
    const joined = statements.join("\n");
    // One shared key ("demo"), two distinct owners and slug-folded ids — no collision.
    expect(joined).toContain("'ing-demo-pub-demo', 'acct-demo-pub', 'demo',");
    expect(joined).toContain("'ing-other-pub-demo', 'acct-other-pub', 'demo',");
  });

  it("enforces the platform count limits and key lengths, and clamps display strings", () => {
    // Too many runs in one benchmark → throws (structural).
    expect(() =>
      buildInsertSql([
        {
          benchmark: bench({
            runs: Array.from({ length: WORKER_LIMITS.runsPerBenchmark + 1 }, (_, i) => ({
              key: `r${i}`,
            })),
            measurements: [],
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
            subjects: [{ key: "k".repeat(WORKER_LIMITS.keyLength + 1), name: "T" }],
            measurements: [],
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
          subjects: [{ key: "t1", name: "N".repeat(WORKER_LIMITS.nameLength + 50) }],
        }) as never,
        source,
        retrievedAt: 1,
      },
    ]);
    expect(counts.clamped).toBe(1);
    expect(statements.join("\n")).toContain("N".repeat(WORKER_LIMITS.nameLength - 1) + "…");
  });

  it("chunks huge insert sets into multiple bounded statements", () => {
    const subjects = Array.from({ length: 300 }, (_, i) => ({ key: `t${i}`, name: `Subject ${i}` }));
    const measurements = Array.from({ length: 300 }, (_, i) => ({
      run_key: "r",
      subject_key: `t${i}`,
      created_at: 1,
      metrics: { score: i },
    }));
    const { statements } = buildInsertSql([
      { benchmark: bench({ subjects, runs: [{ key: "r" }], measurements }) as never, source, retrievedAt: 1 },
    ]);
    const subjectInserts = statements.filter((s) => s.startsWith("INSERT INTO subject"));
    expect(subjectInserts.length).toBeGreaterThan(1);
    for (const s of statements) expect(s.length).toBeLessThan(100_000);
  });
});

describe("sampler", () => {
  // Flat model: t3 is measured under two runs (multi-run edge case); t7's measurements carry a null
  // metric (sparse edge case); every other subject's measurement count ramps with i.
  const mk = (nSubjects: number) => {
    const measurements: {
      run_key: string;
      subject_key: string;
      created_at: number;
      metrics: Record<string, number | null>;
    }[] = [];
    for (let i = 0; i < nSubjects; i++) {
      if (i === 3) {
        measurements.push({ run_key: "r1", subject_key: "t3", created_at: 1, metrics: { s: 1 } });
        measurements.push({ run_key: "r2", subject_key: "t3", created_at: 2, metrics: { s: 2 } });
      } else {
        for (let j = 0; j <= i; j++) {
          measurements.push({
            run_key: "r1",
            subject_key: `t${i}`,
            created_at: j,
            metrics: { s: i === 7 ? null : j },
          });
        }
      }
    }
    return [
      {
        key: "b",
        name: "B",
        description: "",
        about: "",
        methodology: "",
        category: "OTHER" as const,
        tags: [],
        measurementSchema: {},
        subjects: Array.from({ length: nSubjects }, (_, i) => ({ key: `t${i}`, name: `T${i}` })),
        runs: [{ key: "r1" }, { key: "r2" }],
        measurements,
      },
    ];
  };

  it("passes through when no limit or under the limit", () => {
    const benchmarks = mk(5);
    expect(sampleBenchmarks(benchmarks as never, undefined)).toBe(benchmarks);
    expect(sampleBenchmarks(benchmarks as never, 10)[0].subjects.length).toBe(5);
  });

  it("samples representatively: exact size, spread across the list, edge cases included", () => {
    const [sampled] = sampleBenchmarks(mk(100) as never, 10);
    expect(sampled.subjects.length).toBe(10);
    const keys = sampled.subjects.map((t: { key: string }) => t.key);
    // Not head-of-file: something from the back half must be present.
    expect(keys.some((k: string) => Number(k.slice(1)) >= 50)).toBe(true);
    // Edge cases: the multi-run subject and the null-metric subject survive sampling.
    expect(keys).toContain("t3");
    expect(keys).toContain("t7");
    // Busiest (t99) and sparsest (t0) survive.
    expect(keys).toContain("t99");
    expect(keys).toContain("t0");
  });

  it("at a limit smaller than the edge-case count, keeps the highest-priority edges and prunes orphans", () => {
    // 4 distinct edge cases (busiest t99, sparsest t0, multi-run t3, sparse-metric t7); limit 2 keeps
    // the two ordering-independent priority edges, exactly 2 subjects — not an arbitrary index slice.
    const [sampled] = sampleBenchmarks(mk(100) as never, 2);
    expect(sampled.subjects.length).toBe(2);
    expect(sampled.subjects.map((t: { key: string }) => t.key).sort()).toEqual(["t0", "t99"]);
    // Measurements/runs are trimmed to the kept subjects — no measurement names a dropped subject, and
    // no run survives without a measurement (r2 only measured t3, which was trimmed).
    const keptKeys = new Set(sampled.subjects.map((t: { key: string }) => t.key));
    expect(sampled.measurements.every((m: { subject_key: string }) => keptKeys.has(m.subject_key))).toBe(true);
    const usedRuns = new Set(sampled.measurements.map((m: { run_key: string }) => m.run_key));
    expect(sampled.runs.map((r: { key: string }) => r.key)).toEqual(["r1"]);
    expect([...usedRuns]).toEqual(["r1"]);
  });
});
