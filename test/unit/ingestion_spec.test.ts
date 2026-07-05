import { describe, expect, it } from "vitest";
import { adapt, fullOptions, meta, parseSuite, SUITES } from "../../ingestion/lib/sources/spec.mjs";

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

type Schema = { metrics: { name: string; unit?: string }[]; chart: { y: string } };
const schemaOf = (b: { observationSchema: object }) => b.observationSchema as Schema;
const metaOf = (o: { meta?: Record<string, unknown> }) => o.meta as Record<string, unknown>;
const byKey = (bs: ReturnType<typeof adapt>) => new Map(bs.map((b) => [b.key, b]));

describe("spec source metadata", () => {
  it("attributes SPEC under its Fair Use Rules and caps at the platform target limit", () => {
    expect(meta.key).toBe("spec");
    expect(meta.license).toBe("SPEC Fair Use Rules");
    expect(fullOptions.topResults).toBe(20_000);
    // Four CPU2017 pages + jbb2015 + hpc2021.
    expect(SUITES.map((s) => s.key).sort()).toEqual([
      "spec-cpu2017-fprate",
      "spec-cpu2017-fpspeed",
      "spec-cpu2017-intrate",
      "spec-cpu2017-intspeed",
      "spec-hpc2021",
      "spec-jbb2015",
    ]);
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

    const top = c.targets[0];
    expect(top.name).toBe("Box 9000 AMD EPYC 9754, 3.1GHz (ACME Corp)");
    const obs = top.runs[0].observations[0];
    expect(obs.metrics).toEqual({ base_score: 500, peak_score: 520 });
    expect(metaOf(obs).source_url).toBe(
      "https://www.spec.org/cpu2017/results/res2024q3/cpu2017-20240701-99999.html",
    );
    expect(top.runs[0].started_at).toBe(Date.UTC(2024, 6, 1));
    expect(top.runs[0].ended_at).toBe(Date.UTC(2024, 6, 1));
    expect(top.details).toMatchObject({ sponsor: "ACME Corp", copies: "256", cores: "128", chips: "2" });

    // The peak-less "Node Two" result carries base only; earliest date drives published_at.
    const node = c.targets.find((t) => t.name.startsWith("Node Two"))!;
    expect(node.runs[0].observations[0].metrics).toEqual({ base_score: 300 });
    expect(c.published_at).toBe(Date.UTC(2020, 0, 15));
  });

  it("maps SPECjbb2015: max-jOPS as the chart metric plus critical-jOPS", () => {
    const j = map.get("spec-jbb2015")!;
    expect(schemaOf(j).metrics.map((m) => m.name)).toEqual(["max_jops", "critical_jops"]);
    expect(schemaOf(j).chart.y).toBe("max_jops");
    const obs = j.targets[0].runs[0].observations[0];
    expect(obs.metrics).toEqual({ max_jops: 250000, critical_jops: 200000 });
    expect(j.targets[0].details).toMatchObject({ jvm: "Oracle Java SE 17" });
    expect(metaOf(obs).source_url).toBe("https://www.spec.org/jbb2015/results/res2021q2/jbb2015-20210601-00656.html");
  });

  it("honors the cap, keeping the highest-scoring slice", () => {
    const capped = byKey(adapt(archive, { topResults: 1 }));
    const c = capped.get("spec-cpu2017-intrate")!;
    expect(c.targets).toHaveLength(1);
    expect(c.targets[0].name).toBe("Box 9000 AMD EPYC 9754, 3.1GHz (ACME Corp)");
  });
});
