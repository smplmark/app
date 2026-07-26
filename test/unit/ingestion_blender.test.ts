import { describe, expect, it } from "vitest";
import { adapt, fullOptions, meta } from "../../ingestion/lib/sources/blender.mjs";

// A miniature fixture archive shaped exactly like the aggregation endpoint's datatables payloads.
const COLUMNS = [
  { display_name: "Device Name", sortable: true },
  { display_name: "Median Score" },
  { display_name: "Number of Benchmarks" },
];
const empty = { columns: COLUMNS, rows: [] };
const files: Record<string, unknown> = {
  "versions.json": ["5.1.1", "5.0.0"],
  "query-5-1-1-cpu.json": {
    columns: COLUMNS,
    rows: [
      ["AMD Ryzen 9 7950X", 320.5, 40],
      ["Apple M3 Max", 290.25, 25],
      ["Old Celeron", 12.0, 1],
    ],
  },
  "query-5-1-1-cuda.json": {
    columns: COLUMNS,
    rows: [["NVIDIA GeForce RTX 4090", 5000.1, 90]],
  },
  "query-5-1-1-optix.json": {
    columns: COLUMNS,
    rows: [
      ["NVIDIA GeForce RTX 4090", 11000.9, 120],
      // A junk row (null score) the parser must drop.
      ["Broken Device", null, 3],
    ],
  },
  "query-5-1-1-hip.json": empty,
  "query-5-1-1-metal.json": { columns: COLUMNS, rows: [["Apple M3 Max (GPU)", 1500, 30]] },
  "query-5-1-1-oneapi.json": empty,
  "query-5-0-0-cpu.json": {
    columns: COLUMNS,
    rows: [["AMD Ryzen 9 7950X", 300.0, 35]],
  },
  "query-5-0-0-cuda.json": empty,
  "query-5-0-0-optix.json": empty,
  "query-5-0-0-hip.json": empty,
  "query-5-0-0-metal.json": empty,
  "query-5-0-0-oneapi.json": empty,
};

const T_RETRIEVED = Date.UTC(2026, 6, 4);
const archive = {
  readJson: (name: string) => {
    if (!(name in files)) throw new Error(`fixture missing: ${name}`);
    return files[name];
  },
  manifest: { retrieved_at: T_RETRIEVED, files: [] },
};

describe("blender adapter", () => {
  it("declares CC0 provenance and the robots-allowed pull surface", () => {
    expect(meta.license).toBe("CC0-1.0");
    expect(meta.key).toBe("blender");
  });

  it("defaults to the latest version only, split into CPU and GPU benchmarks", () => {
    const [cpu, gpu] = adapt(archive as never);
    expect(cpu.key).toBe("blender-cpu");
    expect(cpu.category).toBe("HARDWARE");
    expect(cpu.tags).toContain("cpu");
    expect(cpu.measurementSchema).toMatchObject({ chart: { x: null, y: "median_score", x_kind: "CATEGORY" } });

    // Latest version (5.1.1) only: the 5.0.0 slice must NOT appear as a run.
    const ryzen = cpu.subjects.find((t: { key: string }) => t.key === "amd-ryzen-9-7950x");
    expect(ryzen).toBeDefined();
    expect(cpu.runs.map((r: { key: string }) => r.key)).toEqual(["v5-1-1"]);
    const ryzenMeas = cpu.measurements.filter(
      (m: { subject_key: string }) => m.subject_key === "amd-ryzen-9-7950x",
    );
    expect(ryzenMeas.map((m: { run_key: string }) => m.run_key)).toEqual(["v5-1-1"]);
    expect(ryzenMeas[0]).toEqual({
      run_key: "v5-1-1",
      subject_key: "amd-ryzen-9-7950x",
      created_at: T_RETRIEVED,
      metrics: { median_score: 320.5, submission_count: 40 },
    });

    // GPU: one device with two API runs; the null-score junk row is dropped.
    expect(gpu.key).toBe("blender-gpu");
    const rtx = gpu.subjects.find((t: { key: string }) => t.key === "nvidia-geforce-rtx-4090");
    expect(rtx).toBeDefined();
    const rtxRunKeys = gpu.measurements
      .filter((m: { subject_key: string }) => m.subject_key === "nvidia-geforce-rtx-4090")
      .map((m: { run_key: string }) => m.run_key)
      .sort();
    expect(rtxRunKeys).toEqual(["v5-1-1-cuda", "v5-1-1-optix"]);
    expect(gpu.subjects.some((t: { name: string }) => t.name === "Broken Device")).toBe(false);
  });

  it("ranks subjects by community submission count and caps at topDevices", () => {
    const [cpu] = adapt(archive as never, { topDevices: 2 });
    expect(cpu.subjects.map((t: { name: string }) => t.name)).toEqual([
      "AMD Ryzen 9 7950X",
      "Apple M3 Max",
    ]);
  });

  it("--full options lift the caps and include every version", () => {
    const [cpu] = adapt(archive as never, fullOptions);
    const ryzen = cpu.subjects.find((t: { key: string }) => t.key === "amd-ryzen-9-7950x");
    expect(ryzen).toBeDefined();
    const ryzenRunKeys = cpu.measurements
      .filter((m: { subject_key: string }) => m.subject_key === "amd-ryzen-9-7950x")
      .map((m: { run_key: string }) => m.run_key)
      .sort();
    expect(ryzenRunKeys).toEqual(["v5-0-0", "v5-1-1"]);
    expect(cpu.subjects.length).toBe(3);
  });
});
