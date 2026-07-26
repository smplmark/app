// Subject-type field defs (src/schema/subject_type): parseFieldDefs validates + normalizes a
// client-supplied `fields` list, validateSubjectValues checks a subject's details against it (open
// schema — undeclared keys pass through), and parseStoredFieldDefs tolerantly re-parses stored JSON.
import { describe, expect, it } from "vitest";
import { BadRequestError } from "../../src/errors";
import {
  fieldNameSlug,
  kebab,
  parseFieldDefs,
  parseStoredFieldDefs,
  validateSubjectValues,
} from "../../src/schema/subject_type";
import type { SubjectFieldDef } from "../../src/types";

function expect400(fn: () => void, match?: RegExp) {
  expect(fn).toThrow(BadRequestError);
  if (match) expect(fn).toThrow(match);
}

describe("kebab / fieldNameSlug", () => {
  it("slugs display names into keys/identifiers", () => {
    expect(kebab("GPU Model (v2)")).toBe("gpu-model-v2");
    expect(kebab("---")).toBe("");
    expect(fieldNameSlug("GPU Model (v2)")).toBe("gpu_model_v2");
    expect(fieldNameSlug("___")).toBe("");
  });
});

describe("parseFieldDefs", () => {
  it("returns [] for an omitted fields value", () => {
    expect(parseFieldDefs(undefined)).toEqual([]);
    expect(parseFieldDefs(null)).toEqual([]);
  });

  it("rejects a non-array fields value", () => {
    expect400(() => parseFieldDefs("nope"), /must be an array/);
  });

  it("rejects more than 40 fields", () => {
    const many = Array.from({ length: 41 }, (_, i) => ({ label: `F${i}`, type: "STRING" }));
    expect400(() => parseFieldDefs(many), /at most 40 fields/);
  });

  it("rejects a non-object field entry", () => {
    expect400(() => parseFieldDefs([null]), /fields\[0\] must be an object/);
    expect400(() => parseFieldDefs([[]]), /fields\[0\] must be an object/);
    expect400(() => parseFieldDefs([42]), /fields\[0\] must be an object/);
  });

  it("rejects a missing/blank label and an unknown type", () => {
    expect400(() => parseFieldDefs([{ type: "STRING" }]), /label must be a non-empty string/);
    expect400(() => parseFieldDefs([{ label: "  ", type: "STRING" }]), /label/);
    expect400(() => parseFieldDefs([{ label: "X", type: "TEXT" }]), /type must be one of/);
  });

  it("derives the name from the label, honoring an explicit name and falling back to field_N", () => {
    const defs = parseFieldDefs([
      { label: "GPU Model", type: "STRING" },
      { label: "Ignored", name: "vram_gb", type: "NUMBER" },
      { label: "!!!", type: "BOOLEAN" }, // slugs to nothing → positional fallback
      { label: "GPU Model", type: "STRING" }, // duplicate → suffixed
    ]);
    expect(defs.map((d) => d.name)).toEqual(["gpu_model", "vram_gb", "field_3", "gpu_model_2"]);
    expect(defs[0].required).toBe(false);
  });

  it("validates the optional description", () => {
    expect400(() => parseFieldDefs([{ label: "X", type: "STRING", description: 42 }]), /description must be a string/);
    expect400(
      () => parseFieldDefs([{ label: "X", type: "STRING", description: "d".repeat(501) }]),
      /at most 500 characters/,
    );
    const defs = parseFieldDefs([
      { label: "A", type: "STRING", description: "  keep me  " },
      { label: "B", type: "STRING", description: "   " }, // blank after trim → dropped
      { label: "C", type: "STRING", description: null }, // explicit null → skipped
    ]);
    expect(defs[0].description).toBe("keep me");
    expect(defs[1].description).toBeUndefined();
    expect(defs[2].description).toBeUndefined();
  });

  it("defaults a STRING max_length to 255 and validates a supplied one", () => {
    const defs = parseFieldDefs([
      { label: "A", type: "STRING" },
      { label: "B", type: "STRING", max_length: 40 },
    ]);
    expect(defs[0].max_length).toBe(255);
    expect(defs[1].max_length).toBe(40);
    for (const bad of [0, 256, 1.5, "40"]) {
      expect400(() => parseFieldDefs([{ label: "X", type: "STRING", max_length: bad }]), /max_length/);
    }
  });

  it("requires ENUM options: non-empty, unique, at most 100", () => {
    expect400(() => parseFieldDefs([{ label: "X", type: "ENUM" }]), /options must be a non-empty array/);
    expect400(() => parseFieldDefs([{ label: "X", type: "ENUM", options: [] }]), /non-empty array/);
    expect400(
      () => parseFieldDefs([{ label: "X", type: "ENUM", options: Array.from({ length: 101 }, (_, i) => `o${i}`) }]),
      /at most 100 values/,
    );
    expect400(() => parseFieldDefs([{ label: "X", type: "ENUM", options: ["a", "a "] }]), /must be unique/);
    expect400(() => parseFieldDefs([{ label: "X", type: "ENUM", options: ["a", ""] }]), /options\[1\]/);
    expect(parseFieldDefs([{ label: "X", type: "ENUM", options: [" a ", "b"] }])[0].options).toEqual(["a", "b"]);
  });
});

describe("validateSubjectValues", () => {
  const def = (over: Partial<SubjectFieldDef>): SubjectFieldDef => ({
    name: "f",
    label: "F",
    type: "STRING",
    required: false,
    ...over,
  });

  it("rejects a non-object details value and defaults an absent one to {}", () => {
    expect400(() => validateSubjectValues([], "nope"), /details must be an object/);
    expect400(() => validateSubjectValues([], ["nope"]), /details must be an object/);
    expect(validateSubjectValues([def({})], undefined)).toEqual({});
    expect(validateSubjectValues([def({})], null)).toEqual({});
  });

  it("enforces required-ness and skips empty optional values", () => {
    expect400(() => validateSubjectValues([def({ required: true })], {}), /"F" is required/);
    expect400(() => validateSubjectValues([def({ required: true })], { f: "" }), /required/);
    expect(validateSubjectValues([def({})], { f: null })).toEqual({});
  });

  it("validates STRING values against max_length", () => {
    expect(validateSubjectValues([def({ max_length: 3 })], { f: "abc" })).toEqual({ f: "abc" });
    expect(validateSubjectValues([def({})], { f: "unbounded" })).toEqual({ f: "unbounded" });
    expect400(() => validateSubjectValues([def({ max_length: 3 })], { f: "abcd" }), /at most 3 characters/);
    expect400(() => validateSubjectValues([def({})], { f: 42 }), /must be a string/);
  });

  it("coerces NUMBER values and rejects non-numeric ones", () => {
    const n = def({ type: "NUMBER" });
    expect(validateSubjectValues([n], { f: 42 })).toEqual({ f: 42 });
    expect(validateSubjectValues([n], { f: "42.5" })).toEqual({ f: 42.5 });
    expect400(() => validateSubjectValues([n], { f: true }), /must be a number/);
    expect400(() => validateSubjectValues([n], { f: "abc" }), /must be a number/);
    expect400(() => validateSubjectValues([n], { f: "   " }), /must be a number/);
  });

  it("accepts BOOLEAN values as booleans or 'true'/'false' strings only", () => {
    const b = def({ type: "BOOLEAN" });
    expect(validateSubjectValues([b], { f: true })).toEqual({ f: true });
    expect(validateSubjectValues([b], { f: false })).toEqual({ f: false });
    expect(validateSubjectValues([b], { f: "true" })).toEqual({ f: true });
    expect(validateSubjectValues([b], { f: "false" })).toEqual({ f: false });
    expect400(() => validateSubjectValues([b], { f: "yes" }), /must be true or false/);
    expect400(() => validateSubjectValues([b], { f: 1 }), /must be true or false/);
  });

  it("checks ENUM membership, tolerating a def with no options list", () => {
    const e = def({ type: "ENUM", options: ["a", "b"] });
    expect(validateSubjectValues([e], { f: "a" })).toEqual({ f: "a" });
    expect400(() => validateSubjectValues([e], { f: "c" }), /must be one of: a, b/);
    expect400(() => validateSubjectValues([e], { f: 42 }), /must be one of/);
    // A hand-edited stored def may lack options — every value is then out of range.
    expect400(() => validateSubjectValues([def({ type: "ENUM" })], { f: "a" }), /must be one of: \./);
  });

  it("requires DATE values to be parseable date strings", () => {
    const d = def({ type: "DATE" });
    expect(validateSubjectValues([d], { f: "2026-01-31" })).toEqual({ f: "2026-01-31" });
    expect400(() => validateSubjectValues([d], { f: 42 }), /must be a date/);
    expect400(() => validateSubjectValues([d], { f: "not-a-date" }), /must be a date/);
  });

  it("passes undeclared keys through verbatim (open schema)", () => {
    const out = validateSubjectValues([def({})], { f: "x", extra: [1, 2], gone: undefined });
    expect(out).toEqual({ f: "x", extra: [1, 2] });
  });
});

describe("parseStoredFieldDefs", () => {
  it("round-trips a stored array and maps everything else to []", () => {
    const defs: SubjectFieldDef[] = [{ name: "f", label: "F", type: "STRING", required: false }];
    expect(parseStoredFieldDefs(JSON.stringify(defs))).toEqual(defs);
    expect(parseStoredFieldDefs(null)).toEqual([]);
    expect(parseStoredFieldDefs("")).toEqual([]);
    expect(parseStoredFieldDefs('{"not":"an array"}')).toEqual([]);
    expect(parseStoredFieldDefs("{garbage")).toEqual([]);
  });
});
