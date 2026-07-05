import { describe, expect, it } from "vitest";
import { adapt, fullOptions, meta, parseExport } from "../../ingestion/lib/sources/tpc.mjs";

// Minimal exports shaped like TPC's real bulk files: a title line, section labels ("Part N: …"),
// a header row, then result rows. Column ORDER is deliberately not the real order — the adapter
// keys on header names, and these fixtures prove that. Tabs for the .xlsx variant, commas for the
// .txt variant (TPC-H), including one row with an unescaped comma inside a text field.
const TAB = "\t";

const TPCC = [
  `${TAB}${TAB}TPC-C BENCHMARK RESULTS`,
  "These results are valid as of date: 7/18/2025",
  `${TAB}${TAB}TPC-C Results - Revision 5.X - Part 1: Active Results`,
  ["Result ID", "Short ID", "Company", "System", "Spec. Revision", "tpmC", "Price/Perf", "Total Sys. Cost", "Currency", "Database Software", "Operating System", "Server CPU Type", "Date Submitted", "Availability Date"].join(TAB),
  ["125012701", "1813", "Alibaba", "PolarDB Limitless", "5.11", "2055076649", "0.8", "1626643837", "CNY", "PolarDB MySQL 8.0", "Paladin Linux", "Xeon 8575C", "1/27/2025", "1/27/2025"].join(TAB),
  // Trailing empties omitted (real TPC-C rows do this) — fewer cells than the 14-col header.
  ["100000001", "1000", "Acme", "Box One", "5.0", "50000", "2.5", "120000", "USD"].join(TAB),
  `${TAB}${TAB}TPC-C Results - Revision 5.X - Part 2: Historical Results`,
  ["Result ID", "Short ID", "Company", "System", "Spec. Revision", "tpmC", "Price/Perf", "Total Sys. Cost", "Currency", "Database Software", "Operating System", "Server CPU Type", "Date Submitted", "Availability Date"].join(TAB),
  ["101053004", "1443", "Bull", "Escala", "5.0", "220807", "34.67", "7657157", "USD", "Oracle 8i", "AIX", "RS64", "5/28/2001", "5/28/2001"].join(TAB),
  // No tpmC → not a usable result, must be skipped.
  ["900000001", "9001", "NoPerf", "Ghost", "5.0", "", "1.0", "100", "USD", "X", "Y", "Z", "1/1/2020", "1/1/2020"].join(TAB),
  "",
].join("\r\n");

const TPCH = [
  "TPC-H BENCHMARK RESULTS",
  "These results are valid as of date 7/18/2025",
  `${TAB}${TAB}TPC-H Results - Revision 3.x - Part 1: 1000 GB Scale Factor`,
  // Header is 13 columns; data rows below carry 2 EXTRA trailing power columns (as real TPC-H
  // rows do) — name-keyed lookup must ignore them, not choke.
  ["Result ID", "Short ID", "Company", "System", "Spec. Revision", "Scale Factor", "QphH", "Price Perf", "Total Sys. Cost", "Currency", "Database Software", "Operating System", "CPU Type"].join(","),
  ["125042301", "3401", "HPE", "HPE ProLiant DL380", "3.0.1", "1000", "1184211.5", "263.13", "311596", "USD", "SQL Server 2022", "Windows 2025", "Xeon 6724P", "42.1", "1000"].join(","),
  // Unescaped comma inside System ("Super, System") shifts every later column right by one, so the
  // Currency column reads a number instead of an ISO code — the adapter must DROP this row.
  ["120010101", "3100", "Acme", "Super, System", "3.0", "1000", "999", "10", "5000", "USD", "DB", "OS", "CPU"].join(","),
  "",
].join("\r\n");

const T_RETRIEVED = Date.UTC(2026, 6, 5);
const archive = {
  manifest: { retrieved_at: T_RETRIEVED, files: [] },
  readText: (name: string) => {
    if (name === "tpcc_results.xlsx") return TPCC;
    if (name === "tpch_results_v3.txt") return TPCH;
    throw new Error(`fixture missing: ${name}`); // TPC-E / TPC-DS absent → those families skip
  },
  readJson: () => {
    throw new Error("tpc adapter reads text, not json");
  },
};

const byKey = (bs: ReturnType<typeof adapt>) => new Map(bs.map((b) => [b.key, b]));

// observationSchema is typed `object` on the shared IngestBenchmark shape; the adapters give it a
// known structure, so a narrow cast keeps the assertions readable.
type Schema = { metrics: { name: string; unit?: string }[]; chart: { y: string } };
const schemaOf = (b: { observationSchema: object }) => b.observationSchema as Schema;
const metaOf = (o: { meta?: Record<string, unknown> }) => o.meta as Record<string, unknown>;

describe("tpc source metadata", () => {
  it("attributes TPC under its Fair Use policy", () => {
    expect(meta.key).toBe("tpc");
    expect(meta.license).toBe("TPC Fair Use Policy");
    expect(meta.robotsOrigin).toBe("https://www.tpc.org");
    expect(fullOptions.topResults).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("parseExport", () => {
  it("classifies section lifecycle and keys columns by header name", () => {
    const rows = parseExport(TPCC, "\t");
    // 4 result rows (2 active + 2 historical); the header/title/blank lines are not rows.
    expect(rows).toHaveLength(4);
    expect(rows.map((r) => r.section)).toEqual(["active", "active", "historical", "historical"]);
    // Name lookup is order-independent and whitespace/punctuation-insensitive.
    expect(rows[0].get("tpmC")).toBe("2055076649");
    expect(rows[0].get("Short ID")).toBe("1813");
  });

  it("does not use column count to reject rows (tolerates trailing extras)", () => {
    const rows = parseExport(TPCH, ",");
    expect(rows).toHaveLength(2); // both data rows survive parsing; adapt() drops the shifted one
    expect(rows[0].get("QphH")).toBe("1184211.5");
  });
});

describe("tpc adapt", () => {
  const benches = adapt(archive, { topResults: Number.POSITIVE_INFINITY });
  const map = byKey(benches);

  it("emits one benchmark per family present in the archive", () => {
    expect([...map.keys()].sort()).toEqual(["tpc-c", "tpc-h"]);
  });

  it("maps TPC-C: skips perf-less rows, records lifecycle, throughput, and citation URL", () => {
    const c = map.get("tpc-c")!;
    expect(c.category).toBe("DATABASE");
    expect(schemaOf(c).metrics.map((m) => m.name)).toEqual(["tpmc", "price_per_tpmc"]);
    expect(schemaOf(c).chart.y).toBe("tpmc");
    // 3 usable results (the empty-tpmC "Ghost" row is dropped).
    expect(c.targets).toHaveLength(3);

    // Sorted by throughput desc → PolarDB first.
    const top = c.targets[0];
    expect(top.name).toBe("PolarDB Limitless (Alibaba)");
    const obs = top.runs[0].observations[0];
    expect(obs.metrics).toEqual({ tpmc: 2055076649, price_per_tpmc: 0.8 });
    expect(metaOf(obs)).toMatchObject({
      tpc_status: "active",
      source_url: "https://www.tpc.org/1813",
      total_system_cost: 1626643837,
      currency: "CNY",
    });
    // A TPC result is a completed, audited measurement.
    expect(top.runs[0].started_at).toBe(Date.UTC(2025, 0, 27));
    expect(top.runs[0].ended_at).toBe(Date.UTC(2025, 0, 27));

    // The historical Bull result keeps its lifecycle status; earliest date drives published_at.
    const bull = c.targets.find((t) => t.name.includes("Escala"))!;
    expect(metaOf(bull.runs[0].observations[0]).tpc_status).toBe("historical");
    expect(c.published_at).toBe(Date.UTC(2001, 4, 28));
  });

  it("maps TPC-H: scale factor metric, and DROPS the unescaped-comma row via the currency anchor", () => {
    const h = map.get("tpc-h")!;
    expect(schemaOf(h).metrics.map((m) => m.name)).toEqual(["qphh", "price_per_qphh", "scale_factor_gb"]);
    // Only the clean HPE row survives; the "Super, System" row is dropped (currency read "5000").
    expect(h.targets).toHaveLength(1);
    const obs = h.targets[0].runs[0].observations[0];
    expect(obs.metrics).toEqual({ qphh: 1184211.5, price_per_qphh: 263.13, scale_factor_gb: 1000 });
    expect(metaOf(obs).source_url).toBe("https://www.tpc.org/3401");
    expect(h.targets[0].runs[0].name).toBe("Scale factor 1000 GB");
  });

  it("honors the per-family default cap, keeping the highest-throughput slice", () => {
    const capped = byKey(adapt(archive, { topResults: 1 }));
    const c = capped.get("tpc-c")!;
    expect(c.targets).toHaveLength(1);
    expect(c.targets[0].name).toBe("PolarDB Limitless (Alibaba)"); // the single fastest result
  });
});
