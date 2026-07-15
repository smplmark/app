// Derived-metric formula compilation (src/schema/metric) and the math ops the engine adds for it
// (src/logic/evaluator). The compiler turns a lettered-step formula into JSON Logic; the ops make that
// JSON Logic evaluate. Together they cover the round trip: build → compile → apply.
import { describe, expect, it } from "vitest";
import { metricExprToJsonLogic, parseMetric } from "../../src/schema/metric";
import { applyRule } from "../../src/logic/evaluator";
import type { MetricFormula, MetricStepOp } from "../../src/types";

const f = (formula: MetricFormula) => metricExprToJsonLogic(formula);

describe("metricExprToJsonLogic", () => {
  it("compiles a single binary op over two metrics", () => {
    expect(
      f({ steps: [{ id: "A", kind: "OP", op: "ADD", a: { kind: "METRIC", name: "foo" }, b: { kind: "METRIC", name: "bar" } }], result: "A" }),
    ).toEqual({ "+": [{ var: "metrics.foo" }, { var: "metrics.bar" }] });
  });

  it("maps every operator to its JSON Logic symbol", () => {
    const pairs: Array<[MetricStepOp, string]> = [["ADD", "+"], ["SUB", "-"], ["MUL", "*"], ["DIV", "/"], ["MOD", "%"]];
    for (const [op, sym] of pairs) {
      expect(
        f({ steps: [{ id: "A", kind: "OP", op, a: { kind: "NUMBER", value: 6 }, b: { kind: "NUMBER", value: 4 } }], result: "A" }),
      ).toEqual({ [sym]: [6, 4] });
    }
  });

  it("compiles each unary function over its operand", () => {
    for (const [fn, name] of [["FLOOR", "floor"], ["ROUND", "round"], ["CEIL", "ceil"], ["ABS", "abs"]] as const) {
      expect(
        f({ steps: [{ id: "A", kind: "FN", fn, a: { kind: "METRIC", name: "x" } }], result: "A" }),
      ).toEqual({ [name]: [{ var: "metrics.x" }] });
    }
  });

  it("inlines a STEP operand by compiling the step it references", () => {
    // A = foo + bar; B = A + 1; result B  →  (foo + bar) + 1
    expect(
      f({
        steps: [
          { id: "A", kind: "OP", op: "ADD", a: { kind: "METRIC", name: "foo" }, b: { kind: "METRIC", name: "bar" } },
          { id: "B", kind: "OP", op: "ADD", a: { kind: "STEP", step: "A" }, b: { kind: "NUMBER", value: 1 } },
        ],
        result: "B",
      }),
    ).toEqual({ "+": [{ "+": [{ var: "metrics.foo" }, { var: "metrics.bar" }] }, 1] });
  });

  it("compiles CREATED_AT and expresses minute-skew as `created_at mod 60000`", () => {
    expect(
      f({ steps: [{ id: "A", kind: "OP", op: "MOD", a: { kind: "CREATED_AT" }, b: { kind: "NUMBER", value: 60000 } }], result: "A" }),
    ).toEqual({ "%": [{ var: "created_at" }, 60000] });
  });

  it("defaults the result to the last step when the named result is missing", () => {
    const steps: MetricFormula["steps"] = [
      { id: "A", kind: "OP", op: "MUL", a: { kind: "METRIC", name: "foo" }, b: { kind: "NUMBER", value: 2 } },
      { id: "B", kind: "FN", fn: "FLOOR", a: { kind: "STEP", step: "A" } },
    ];
    expect(f({ steps, result: "nope" })).toEqual({ floor: [{ "*": [{ var: "metrics.foo" }, 2] }] });
  });

  it("returns null for an empty or malformed formula", () => {
    expect(f({ steps: [], result: "A" })).toBeNull();
    expect(metricExprToJsonLogic({} as MetricFormula)).toBeNull();
  });

  it("compiles a dangling STEP reference to null", () => {
    expect(f({ steps: [{ id: "A", kind: "FN", fn: "ABS", a: { kind: "STEP", step: "Z" } }], result: "A" })).toEqual({ abs: [null] });
  });

  it("short-circuits a hand-edited cyclic reference to null rather than looping", () => {
    // A references B and B references A — impossible via the parser, but the compiler must not hang.
    expect(
      f({
        steps: [
          { id: "A", kind: "OP", op: "ADD", a: { kind: "STEP", step: "B" }, b: { kind: "NUMBER", value: 1 } },
          { id: "B", kind: "OP", op: "ADD", a: { kind: "STEP", step: "A" }, b: { kind: "NUMBER", value: 1 } },
        ],
        result: "A",
      }),
    ).toEqual({ "+": [{ "+": [null, 1] }, 1] });
  });
});

describe("parseMetric formula validation", () => {
  const ok = (formula: unknown) => parseMetric({ label: "X", type: "FORMULA", formula });
  const bad = (formula: unknown) => () => parseMetric({ label: "X", type: "FORMULA", formula });

  it("normalizes a well-formed multi-step formula (slugs metric names, coerces numbers)", () => {
    const m = ok({
      steps: [
        { id: "A", kind: "OP", op: "DIV", a: { kind: "METRIC", name: "Foo Bar" }, b: { kind: "NUMBER", value: "2" } },
        { id: "B", kind: "FN", fn: "FLOOR", a: { kind: "STEP", step: "A" } },
      ],
      result: "B",
    });
    expect(m.formula).toEqual({
      steps: [
        { id: "A", kind: "OP", op: "DIV", a: { kind: "METRIC", name: "foo_bar" }, b: { kind: "NUMBER", value: 2 } },
        { id: "B", kind: "FN", fn: "FLOOR", a: { kind: "STEP", step: "A" } },
      ],
      result: "B",
    });
  });

  it("defaults step ids by position and result to the last step, and accepts CREATED_AT", () => {
    const m = ok({ steps: [{ kind: "OP", op: "ADD", a: { kind: "CREATED_AT" }, b: { kind: "NUMBER", value: 1 } }] });
    expect(m.formula?.steps[0].id).toBe("A");
    expect(m.formula?.result).toBe("A");
  });

  it("rejects malformed formula structure", () => {
    expect(bad(null)).toThrow();                              // not an object
    expect(bad([])).toThrow();                                // an array
    expect(bad({})).toThrow();                                // missing steps
    expect(bad({ steps: [] })).toThrow();                     // empty steps
    expect(bad({ steps: [42] })).toThrow();                   // step not an object
    const step = { kind: "OP", op: "ADD", a: { kind: "NUMBER", value: 1 }, b: { kind: "NUMBER", value: 1 } };
    expect(bad({ steps: [{ id: "A", ...step }, { id: "A", ...step }] })).toThrow(); // duplicate id
    expect(bad({ steps: [{ id: "A", kind: "OP", op: "NOPE", a: { kind: "NUMBER", value: 1 }, b: { kind: "NUMBER", value: 1 } }] })).toThrow(); // bad op
    expect(bad({ steps: [{ id: "A", kind: "FN", fn: "NOPE", a: { kind: "NUMBER", value: 1 } }] })).toThrow(); // bad fn
    expect(bad({ steps: [{ id: "A", kind: "WAT", a: { kind: "NUMBER", value: 1 } }] })).toThrow(); // neither OP nor FN
    expect(bad({ steps: [{ id: "A", ...step }], result: "Z" })).toThrow(); // result names no step
  });

  it("rejects malformed operands", () => {
    const one = (a: unknown) => bad({ steps: [{ id: "A", kind: "FN", fn: "ABS", a }] });
    expect(one(null)).toThrow();                          // operand not an object
    expect(one({ kind: "METRIC" })).toThrow();            // missing metric name
    expect(one({ kind: "METRIC", name: "!!!" })).toThrow(); // metric name slugs to empty
    expect(one({ kind: "NUMBER", value: "abc" })).toThrow(); // non-finite number
    expect(one({ kind: "STEP", step: "A" })).toThrow();  // step reference with no earlier step
    expect(one({ kind: "WAT" })).toThrow();              // unknown operand kind
  });
});

describe("derived-metric math ops evaluate", () => {
  it("floor / ceil / round / abs", () => {
    expect(applyRule({ floor: [2.9] }, {})).toBe(2);
    expect(applyRule({ ceil: [2.1] }, {})).toBe(3);
    expect(applyRule({ round: [2.5] }, {})).toBe(3);
    expect(applyRule({ abs: [-4] }, {})).toBe(4);
  });

  it("evaluates a compiled percentage against a metrics context", () => {
    const expr = f({
      steps: [
        { id: "A", kind: "OP", op: "DIV", a: { kind: "METRIC", name: "hits" }, b: { kind: "METRIC", name: "lookups" } },
        { id: "B", kind: "OP", op: "MUL", a: { kind: "NUMBER", value: 100 }, b: { kind: "STEP", step: "A" } },
      ],
      result: "B",
    });
    expect(applyRule(expr, { metrics: { hits: 3, lookups: 4 } })).toBe(75);
  });

  it("evaluates minute-skew (`created_at mod 60000`) via the native modulo op", () => {
    const expr = f({ steps: [{ id: "A", kind: "OP", op: "MOD", a: { kind: "CREATED_AT" }, b: { kind: "NUMBER", value: 60000 } }], result: "A" });
    expect(applyRule(expr, { created_at: Date.UTC(2026, 6, 1, 14, 3, 0) + 87 })).toBe(87);
  });
});
