import { describe, expect, it } from "vitest";
import { AppError } from "../../src/errors";
import {
  attributesOf,
  optionalEnum,
  optionalStringOrNull,
  parseBearer,
  parseEpochMs,
  parseJsonBody,
  requireObject,
  requireString,
} from "../../src/http/body";

function expect400(fn: () => void) {
  expect(fn).toThrow(AppError);
  try {
    fn();
  } catch (e) {
    expect((e as AppError).status).toBe(400);
  }
}

describe("parseJsonBody", () => {
  it("returns undefined for an empty or whitespace body", () => {
    expect(parseJsonBody("")).toBeUndefined();
    expect(parseJsonBody("   \n")).toBeUndefined();
  });
  it("parses valid JSON", () => {
    expect(parseJsonBody('{"a":1}')).toEqual({ a: 1 });
  });
  it("rejects malformed JSON with 400", () => {
    expect400(() => parseJsonBody("{nope"));
  });
});

describe("attributesOf", () => {
  it("returns attributes from a well-formed document", () => {
    expect(attributesOf({ data: { attributes: { k: 1 } } })).toEqual({ k: 1 });
  });
  it("returns {} when attributes are absent", () => {
    expect(attributesOf({ data: {} })).toEqual({});
  });
  it.each([
    [null],
    [["x"]],
    ["str"],
    [{}], // data missing
    [{ data: null }],
    [{ data: [1] }],
    [{ data: { attributes: null } }],
    [{ data: { attributes: [1] } }],
  ])("rejects %o with 400", (body) => {
    expect400(() => attributesOf(body));
  });
});

describe("requireString", () => {
  it("returns a non-empty string", () => {
    expect(requireString({ k: "v" }, "k")).toBe("v");
  });
  it.each([[{}], [{ k: "" }], [{ k: 5 }]])("rejects %o with 400", (attrs) => {
    expect400(() => requireString(attrs as Record<string, unknown>, "k"));
  });
});

describe("optionalStringOrNull", () => {
  it("distinguishes absent / null / string", () => {
    expect(optionalStringOrNull({}, "k")).toBeUndefined();
    expect(optionalStringOrNull({ k: null }, "k")).toBeNull();
    expect(optionalStringOrNull({ k: "v" }, "k")).toBe("v");
  });
  it("rejects a non-string value with 400", () => {
    expect400(() => optionalStringOrNull({ k: 5 }, "k"));
  });
});

describe("optionalEnum", () => {
  const allowed = ["ALPHA", "BETA"] as const;
  it("returns undefined when absent; normalizes case-insensitively to the wire value", () => {
    expect(optionalEnum({}, "k", allowed)).toBeUndefined();
    expect(optionalEnum({ k: "BETA" }, "k", allowed)).toBe("BETA");
    expect(optionalEnum({ k: "beta" }, "k", allowed)).toBe("BETA");
    expect(optionalEnum({ k: "Alpha" }, "k", allowed)).toBe("ALPHA");
  });
  it.each([[{ k: "gamma" }], [{ k: 1 }]])("rejects %o with 400", (attrs) => {
    expect400(() => optionalEnum(attrs as Record<string, unknown>, "k", allowed));
  });
});

describe("requireObject", () => {
  it("returns a plain object", () => {
    expect(requireObject({ a: 1 }, "k")).toEqual({ a: 1 });
  });
  it.each([[null], [["x"]], ["str"], [5]])("rejects %o with 400", (v) => {
    expect400(() => requireObject(v, "k"));
  });
});

describe("parseEpochMs", () => {
  it("accepts an epoch-ms number (truncated)", () => {
    expect(parseEpochMs(1700000000123.9, "t")).toBe(1700000000123);
  });
  it("accepts an ISO-8601 string", () => {
    expect(parseEpochMs("2026-07-01T00:00:00Z", "t")).toBe(Date.UTC(2026, 6, 1));
  });
  it("treats a timezone-less ISO datetime as UTC", () => {
    expect(parseEpochMs("2026-07-01T12:00:00", "t")).toBe(Date.UTC(2026, 6, 1, 12));
  });
  it.each([["not-a-date"], [Infinity], [1e18], [-1e18], [null], [{}]])(
    "rejects %o with 400 (unparseable or out of Date range)",
    (v) => {
      expect400(() => parseEpochMs(v, "t"));
    },
  );
});

describe("parseBearer", () => {
  it.each([
    ["Bearer abc", "abc"],
    ["bearer abc", "abc"],
    ["Bearer   spaced", "spaced"],
  ])("extracts the token from %s", (header, token) => {
    expect(parseBearer(header)).toBe(token);
  });
  it.each([[null], [undefined], [""], ["Basic abc"], ["Bearer"], ["Bearer "]])(
    "returns null for %o",
    (header) => {
      expect(parseBearer(header)).toBeNull();
    },
  );
});
