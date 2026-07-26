// Periodic re-check of VERIFIED publishers (a Workers cron trigger; see wrangler.jsonc + src/index.ts).
// A publisher whose TXT record has disappeared flips VERIFIED → LAPSED, which blocks NEW publishes under
// it but never touches a benchmark's frozen attribution_snapshot — the historical public record is
// immutable. A transient DNS failure never lapses a publisher (we only act on a successful lookup that
// is missing the token). A LAPSED publisher returns to VERIFIED on a later successful verify action.
import {
  listVerifiedPublishersPage,
  setPublisherStatus,
} from "../data/publishers";
import { domainHasVerificationToken } from "./dns";

const DEFAULT_PAGE_SIZE = 100;
/** Safety cap so a runaway table can never make a single cron invocation unbounded. */
const DEFAULT_MAX_PAGES = 50;

export interface SweepResult {
  checked: number;
  lapsed: number;
  /** True if the cap was hit and some VERIFIED domains were left unchecked this run. */
  truncated: boolean;
}

export interface SweepOptions {
  /** Rows per page (default 100). */
  pageSize?: number;
  /** Max pages per invocation — the safety bound (default 50). */
  maxPages?: number;
}

/**
 * Re-check every VERIFIED domain (paginated). Bounded to keep a single cron run cheap; the table is
 * low-cardinality. Returns counts for observability. `opts` is only for tests to exercise the bound.
 */
export async function sweepVerifiedDomains(
  db: D1Database,
  opts: SweepOptions = {},
): Promise<SweepResult> {
  const pageSize = opts.pageSize ?? DEFAULT_PAGE_SIZE;
  const maxPages = opts.maxPages ?? DEFAULT_MAX_PAGES;
  const now = Date.now();
  let checked = 0;
  let lapsed = 0;
  let truncated = false;

  for (let page = 0; ; page++) {
    if (page >= maxPages) {
      // If a full page came back on the last allowed page, more rows may remain unchecked.
      truncated = true;
      break;
    }
    const rows = await listVerifiedPublishersPage(db, pageSize, page * pageSize);
    if (rows.length === 0) break;

    for (const row of rows) {
      let found: boolean;
      try {
        found = await domainHasVerificationToken(row.domain, row.verification_token);
      } catch {
        // The check itself was inconclusive (network / resolver) — never lapse on ambiguity.
        continue;
      }
      checked++;
      if (!found) {
        await setPublisherStatus(db, row.id, { status: "LAPSED", verified_at: row.verified_at, last_checked_at: now });
        lapsed++;
      } else {
        await setPublisherStatus(db, row.id, { status: "VERIFIED", verified_at: row.verified_at, last_checked_at: now });
      }
    }

    if (rows.length < pageSize) break;
  }

  return { checked, lapsed, truncated };
}
