// JSON Logic evaluation (ADR-022). Reuses json-logic-js — the same evaluator the typescript-sdk
// ships — and registers the one custom op smplmark needs. Registration runs once at module load.
import jsonLogic from "json-logic-js";

const MINUTE_MS = 60_000;

/**
 * `minute_offset_ms(created_at_ms)` — milliseconds from the top of the immediately-preceding
 * minute (spec §4): `ms − floor(ms / 60000) × 60000`. Floor-to-previous-minute: an early hit is
 * not attributed to the next minute. Compute-on-read, so this definition is freely revisable.
 */
export function minuteOffsetMs(ms: number): number {
  return ms - Math.floor(ms / MINUTE_MS) * MINUTE_MS;
}

jsonLogic.add_operation("minute_offset_ms", (ms: unknown): number => {
  return minuteOffsetMs(typeof ms === "number" ? ms : Number(ms));
});

/** Evaluate a JSON Logic rule against a data context. */
export function applyRule(rule: unknown, data: Record<string, unknown>): unknown {
  return jsonLogic.apply(rule as Parameters<typeof jsonLogic.apply>[0], data);
}
