import { describe, expect, it } from "vitest";
import type { ResourceObject } from "../../src/http/jsonapi";
import { measurementsToCsv } from "../../src/serialize/csv";

const measurement = (
  id: string,
  created_at: string,
  run: string,
  target: string,
  metrics?: Record<string, unknown>,
  meta?: unknown,
): ResourceObject => ({
  type: "measurement",
  id,
  attributes: {
    created_at,
    run,
    target,
    ...(metrics ? { metrics } : {}),
    ...(meta !== undefined ? { meta } : {}),
  },
});

const rowsOf = (csv: string) => csv.split("\r\n");

describe("measurementsToCsv", () => {
  it("emits a header-only document for an empty result", () => {
    expect(measurementsToCsv([])).toBe("id,created_at,run,target,meta");
  });

  it("emits fixed columns, a metric column, and an (empty) meta column", () => {
    const csv = measurementsToCsv([
      measurement("1", "2026-07-01T00:00:00.000Z", "r1", "tg1", { skew_ms: 87 }),
    ]);
    expect(csv).toBe(
      "id,created_at,run,target,skew_ms,meta\r\n1,2026-07-01T00:00:00.000Z,r1,tg1,87,",
    );
  });

  it("unions metric keys across rows (sorted) and leaves gaps empty", () => {
    const csv = measurementsToCsv([
      measurement("1", "t1", "r1", "tg1", { skew_ms: 5 }),
      measurement("2", "t2", "r2", "tg2", { p95_ms: 12, throughput: 3 }),
    ]);
    const [header, row1, row2] = rowsOf(csv);
    expect(header).toBe("id,created_at,run,target,p95_ms,skew_ms,throughput,meta");
    expect(row1).toBe("1,t1,r1,tg1,,5,,");
    expect(row2).toBe("2,t2,r2,tg2,12,,3,");
  });

  it("quotes a cell containing a comma", () => {
    const csv = measurementsToCsv([measurement("1", "t1", "r1", "tg1", { label: "a,b" })]);
    expect(rowsOf(csv)[1]).toBe('1,t1,r1,tg1,"a,b",');
  });

  it("escapes embedded double-quotes by doubling them", () => {
    const csv = measurementsToCsv([measurement("1", "t1", "r1", "tg1", { label: 'a"b' })]);
    expect(rowsOf(csv)[1]).toBe('1,t1,r1,tg1,"a""b",');
  });

  it("quotes a cell containing a newline", () => {
    const csv = measurementsToCsv([measurement("1", "t1", "r1", "tg1", { label: "a\nb" })]);
    expect(rowsOf(csv)[1]).toBe('1,t1,r1,tg1,"a\nb",');
  });

  it("renders a meta object as a JSON cell", () => {
    const csv = measurementsToCsv([measurement("9", "t", "r", "tg", undefined, { commit: "abc" })]);
    expect(rowsOf(csv)[1]).toBe('9,t,r,tg,"{""commit"":""abc""}"');
  });
});
