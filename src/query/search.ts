// filter[search] parsing (ADR-014's reserved free-text key): deliberately low-tech. The query is
// split into terms — double-quoted phrases stay contiguous, bare words match anywhere — and every
// term must appear (AND) as a case-insensitive substring of the benchmark's search_text column.
import { BadRequestError } from "../errors";

const MAX_TERMS = 8;
const MAX_TERM_LENGTH = 100;

/**
 * `fast gpu "blender 4.2"` → ["fast", "gpu", "blender 4.2"], lowercased. Unbalanced quotes treat
 * the trailing quote as literal-ish (everything after it becomes one phrase). Empty/whitespace
 * input → []. Oversized input → 400 (never 500 from client input).
 */
export function parseSearchQuery(raw: string): string[] {
  const terms: string[] = [];
  const re = /"([^"]*)"|(\S+)/g;
  for (const match of raw.matchAll(re)) {
    const term = (match[1] ?? match[2]).trim().toLowerCase();
    if (term.length === 0) continue;
    if (term.length > MAX_TERM_LENGTH) {
      throw new BadRequestError(
        `filter[search] terms must be at most ${MAX_TERM_LENGTH} characters.`,
      );
    }
    terms.push(term);
    if (terms.length > MAX_TERMS) {
      throw new BadRequestError(`filter[search] accepts at most ${MAX_TERMS} terms.`);
    }
  }
  return terms;
}

/** Escape a term for `LIKE ? ESCAPE '\'` (the term's %, _, \ must match literally). */
export function likePattern(term: string): string {
  return "%" + term.replace(/[\\%_]/g, (c) => "\\" + c) + "%";
}
