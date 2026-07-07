import { describe, expect, it } from "vitest";
import { adapt, discoverQuarters, fullOptions, meta, parseSuite, SUITES } from "../../ingestion/lib/sources/spec.mjs";

// Miniature result pages shaped like SPEC's real tables: repeating header rows (no result link),
// class-keyed data cells, the system name ahead of a <br> + disclosures span, and "--" for a
// peak score that wasn't run. Column classes match the SUITES config exactly.
const CPU2017 = `
<table><thead><tr><th>Test Sponsor</th><th>System Name</th></tr></thead><tbody>
<tr>
  <td class="test_sponsor">ACME Corp</td>
  <td class="hw_model">Box 9000 AMD EPYC 9754, 3.1GHz<br />
    <span class="disclosures"><a href="res2024q3/cpu2017-20240701-99999.html">HTML</a> | <a href="res2024q3/cpu2017-20240701-99999.csv">CSV</a></span></td>
  <td class="base_copies">256</td>
  <td class="hw_ncores">128</td>
  <td class="hw_nchips">2</td>
  <td class="hw_nthreadspercore">2</td>
  <td class="basemean">500&nbsp;</td>
  <td class="peakmean">520&nbsp;</td>
</tr>
<tr><th>Test Sponsor</th><th>System Name</th></tr>
<tr>
  <td class="test_sponsor">Smith &amp; Sons</td>
  <td class="hw_model">Node Two<br /><span class="disclosures"><a href="res2020q1/cpu2017-20200115-11111.html">HTML</a></span></td>
  <td class="base_copies">64</td>
  <td class="hw_ncores">32</td>
  <td class="hw_nchips">1</td>
  <td class="hw_nthreadspercore">2</td>
  <td class="basemean">300&nbsp;</td>
  <td class="peakmean">--</td>
</tr>
<tr>
  <td class="test_sponsor">No Score Inc</td>
  <td class="hw_model">Ghost<br /><span class="disclosures"><a href="res2020q1/cpu2017-20200201-22222.html">HTML</a></span></td>
  <td class="basemean">--</td>
  <td class="peakmean">--</td>
</tr>
</tbody></table>`;

const JBB = `
<table><tbody>
<tr>
  <td class="test.testedBy">Foo Ltd</td>
  <td class="product.SUT.hw.system.hw_1.name">Server X<br /><span class="disclosures"><a href="res2021q2/jbb2015-20210601-00656.html">HTML</a></span></td>
  <td class="product.SUT.sw.jvm.jvm_1.name">Oracle Java SE 17</td>
  <td class="product.SUT.sw.jvm.jvm_1.version">HotSpot 17.0.2</td>
  <td class="result.metric.max-jOPS">250000</td>
  <td class="result.metric.critical-jOPS">200000</td>
</tr>
</tbody></table>`;

// A crawled quarter page (power_ssj2008): result links are BARE (no resYYYYqN/ prefix), and the
// quarter comes from the file name the pull saved it under.
const POWER_LANDING = `<html><body>
<a href="res2024q3/">2024 Q3</a> | <a href="res2024q4/">2024 Q4</a> | <a href="res2024q4">dupe</a> | <a href="/other/">x</a>
</body></html>`;
const POWER_Q = `
<table><tbody>
<tr>
  <td class="wkld_ssj_global_config_hw_vendor">Dell Inc.</td>
  <td class="wkld_ssj_global_config_hw_model">PowerEdge R7725<br /><span class="disclosures"><a href="power_ssj2008-20241007-01464.html">HTML</a></span></td>
  <td class="hwnodes">1</td>
  <td class="wkld_ssj_global_config_hw_cpu">AMD EPYC 9965</td>
  <td class="aggregate_config_cpu_chips">2</td>
  <td class="aggregate_config_cpu_cores">384</td>
  <td class="metric_performance_power_ratio">35,920</td>
</tr>
</tbody></table>`;

const T_RETRIEVED = Date.UTC(2026, 6, 5);
const archive = {
  manifest: { retrieved_at: T_RETRIEVED, files: [] },
  readText: (name: string) => {
    if (name === "rint2017.html") return CPU2017;
    if (name === "jbb2015.html") return JBB;
    throw new Error(`fixture missing: ${name}`); // other CPU2017 pages + hpc2021 absent → skipped
  },
  readJson: () => {
    throw new Error("spec adapter reads text, not json");
  },
};

// A crawl-suite archive: manifest.files lists the quarter files, readText serves them.
const crawlArchive = {
  manifest: { retrieved_at: T_RETRIEVED, files: [{ name: "power_ssj2008-res2024q4.html", url: "", sha256: "", bytes: 0 }] },
  readText: (name: string) => {
    if (name === "power_ssj2008-res2024q4.html") return POWER_Q;
    throw new Error(`fixture missing: ${name}`);
  },
  readJson: () => {
    throw new Error("no json");
  },
};

type Schema = { metrics: { name: string; unit?: string }[]; chart: { y: string } };
const schemaOf = (b: { observationSchema: object }) => b.observationSchema as Schema;
const metaOf = (o: { meta?: Record<string, unknown> }) => o.meta as Record<string, unknown>;
const byKey = (bs: ReturnType<typeof adapt>) => new Map(bs.map((b) => [b.key, b]));

// Each SPEC benchmark is flat: sibling targets/runs/measurements. A measurement names one run + one
// target; find the measurement for a given target by joining on its (single) run.
type Bench = ReturnType<typeof adapt>[number];
const measurementForTarget = (b: Bench, targetKey: string) => {
  const m = b.measurements.find((x) => x.target_key === targetKey);
  if (!m) throw new Error(`no measurement for target ${targetKey}`);
  return m;
};
const runForKey = (b: Bench, runKey: string) => {
  const r = b.runs.find((x) => x.key === runKey);
  if (!r) throw new Error(`no run ${runKey}`);
  return r;
};

describe("spec source metadata", () => {
  it("attributes SPEC under its Fair Use Rules and caps at the platform target limit", () => {
    expect(meta.key).toBe("spec");
    expect(meta.license).toBe("SPEC Fair Use Rules");
    expect(fullOptions.topResults).toBe(20_000);
    // Four CPU2017 pages + jbb2015 + hpc2021 (aggregate) + power_ssj2008 + storage2020 (crawled).
    expect(SUITES.map((s) => s.key).sort()).toEqual([
      "spec-cpu2017-fprate",
      "spec-cpu2017-fpspeed",
      "spec-cpu2017-intrate",
      "spec-cpu2017-intspeed",
      "spec-hpc2021",
      "spec-jbb2015",
      "spec-power-ssj2008",
      "spec-storage2020",
    ]);
    // Aggregate suites carry a single page path; crawl suites carry a landing to enumerate quarters.
    expect(SUITES.find((s) => s.key === "spec-cpu2017-intrate")!.path).toBeDefined();
    expect(SUITES.find((s) => s.key === "spec-power-ssj2008")!.landing).toBe("/power_ssj2008/results/");
    expect(SUITES.find((s) => s.key === "spec-storage2020")!.category).toBe("STORAGE");
  });
});

describe("parseSuite", () => {
  it("skips header-repeat rows and reads the result id, quarter, and date from the disclosure link", () => {
    const rows = parseSuite(CPU2017, SUITES.find((s) => s.key === "spec-cpu2017-intrate")!);
    expect(rows).toHaveLength(3); // 3 data rows; the mid-table <th> header row is not one
    expect(rows[0].resultBase).toBe("cpu2017-20240701-99999");
    expect(rows[0].quarter).toBe("2024q3");
    expect(rows[0].date).toBe("2024-07-01");
    expect(rows[0].system).toBe("Box 9000 AMD EPYC 9754, 3.1GHz"); // text before <br>, entity-free
    expect(rows[1].sponsor).toBe("Smith & Sons"); // &amp; decoded
  });

  it("reads BARE result links on a crawled quarter page, tagging the caller-supplied quarter", () => {
    const suite = SUITES.find((s) => s.key === "spec-power-ssj2008")!;
    const rows = parseSuite(POWER_Q, suite, "2024q4");
    expect(rows).toHaveLength(1);
    expect(rows[0].resultBase).toBe("power_ssj2008-20241007-01464");
    expect(rows[0].quarter).toBe("2024q4");
    expect(rows[0].date).toBe("2024-10-07");
    expect(rows[0].sponsor).toBe("Dell Inc.");
  });
});

describe("discoverQuarters", () => {
  it("extracts distinct, sorted quarter directories from a landing page", () => {
    expect(discoverQuarters(POWER_LANDING)).toEqual(["res2024q3", "res2024q4"]);
  });
});

describe("spec adapt — crawl suite", () => {
  it("reads every quarter file listed in the manifest and cites the quarter-qualified result URL", () => {
    const power = byKey(adapt(crawlArchive, { topResults: 5000 })).get("spec-power-ssj2008")!;
    expect(power.category).toBe("HARDWARE");
    expect(schemaOf(power).metrics.map((m) => m.name)).toEqual(["overall_ssj_ops_per_watt"]);
    expect(power.targets).toHaveLength(1);
    // 1:1 per independent result: one target, one run, one measurement.
    expect(power.runs).toHaveLength(1);
    expect(power.measurements).toHaveLength(1);
    const t = power.targets[0];
    expect(t.name).toBe("PowerEdge R7725 (Dell Inc.)");
    const meas = measurementForTarget(power, t.key);
    expect(meas.run_key).toBe("r-power_ssj2008-20241007-01464");
    expect(runForKey(power, meas.run_key)).toBeDefined();
    expect(meas.metrics).toEqual({ overall_ssj_ops_per_watt: 35920 });
    expect(metaOf(meas).source_url).toBe(
      "https://www.spec.org/power_ssj2008/results/res2024q4/power_ssj2008-20241007-01464.html",
    );
    expect(t.details).toMatchObject({ cpu: "AMD EPYC 9965", chips: "2", cores: "384", nodes: "1" });
  });
});

describe("spec adapt", () => {
  const map = byKey(adapt(archive, { topResults: 5000 }));

  it("emits one benchmark per result page present, category HARDWARE", () => {
    expect([...map.keys()].sort()).toEqual(["spec-cpu2017-intrate", "spec-jbb2015"]);
    expect(map.get("spec-cpu2017-intrate")!.category).toBe("HARDWARE");
  });

  it("maps CPU2017: base+peak, drops score-less rows, omits absent peak, cites the result page", () => {
    const c = map.get("spec-cpu2017-intrate")!;
    expect(schemaOf(c).metrics.map((m) => m.name)).toEqual(["base_score", "peak_score"]);
    expect(schemaOf(c).chart.y).toBe("base_score");
    // "Ghost" (base "--") is dropped; 2 usable results remain, sorted by base desc.
    expect(c.targets).toHaveLength(2);
    // 1:1 per independent result: run/target/measurement counts match.
    expect(c.runs).toHaveLength(2);
    expect(c.measurements).toHaveLength(2);

    const top = c.targets[0];
    expect(top.name).toBe("Box 9000 AMD EPYC 9754, 3.1GHz (ACME Corp)");
    const topMeas = measurementForTarget(c, top.key);
    expect(topMeas.metrics).toEqual({ base_score: 500, peak_score: 520 });
    expect(metaOf(topMeas).source_url).toBe(
      "https://www.spec.org/cpu2017/results/res2024q3/cpu2017-20240701-99999.html",
    );
    const topRun = runForKey(c, topMeas.run_key);
    expect(topRun.started_at).toBe(Date.UTC(2024, 6, 1));
    expect(topRun.ended_at).toBe(Date.UTC(2024, 6, 1));
    expect(top.details).toMatchObject({ sponsor: "ACME Corp", copies: "256", cores: "128", chips: "2" });

    // The peak-less "Node Two" result carries base only; earliest date drives published_at.
    const node = c.targets.find((t) => t.name.startsWith("Node Two"))!;
    expect(measurementForTarget(c, node.key).metrics).toEqual({ base_score: 300 });
    expect(c.published_at).toBe(Date.UTC(2020, 0, 15));
  });

  it("maps SPECjbb2015: max-jOPS as the chart metric plus critical-jOPS", () => {
    const j = map.get("spec-jbb2015")!;
    expect(schemaOf(j).metrics.map((m) => m.name)).toEqual(["max_jops", "critical_jops"]);
    expect(schemaOf(j).chart.y).toBe("max_jops");
    const meas = measurementForTarget(j, j.targets[0].key);
    expect(meas.metrics).toEqual({ max_jops: 250000, critical_jops: 200000 });
    expect(j.targets[0].details).toMatchObject({ jvm: "Oracle Java SE 17" });
    expect(metaOf(meas).source_url).toBe("https://www.spec.org/jbb2015/results/res2021q2/jbb2015-20210601-00656.html");
  });

  it("honors the cap, keeping the highest-scoring slice", () => {
    const capped = byKey(adapt(archive, { topResults: 1 }));
    const c = capped.get("spec-cpu2017-intrate")!;
    expect(c.targets).toHaveLength(1);
    expect(c.targets[0].name).toBe("Box 9000 AMD EPYC 9754, 3.1GHz (ACME Corp)");
  });
});
