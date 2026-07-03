// JSON:API pagination, ported from python-core's smplcore/pagination.py (ADR-014):
// `page[number]` (1-based, default 1), `page[size]` (default 1000, 1..1000), `meta[total]` bool.
import { BadRequestError } from "../errors";

export const DEFAULT_PAGE_SIZE = 1000;
export const MAX_PAGE_SIZE = 1000;

export interface Pagination {
  number: number;
  size: number;
  includeTotal: boolean;
  offset: number;
  limit: number;
}

const INT_RE = /^\d+$/;

function parseInt2(value: string, field: string): number {
  if (!INT_RE.test(value)) {
    throw new BadRequestError(`${field} must be a non-negative integer.`);
  }
  return Number(value);
}

export function parsePagination(
  pageNumber: string | null,
  pageSize: string | null,
  metaTotal: string | null,
): Pagination {
  let number = 1;
  if (pageNumber !== null) {
    number = parseInt2(pageNumber, "page[number]");
    if (number < 1) {
      throw new BadRequestError("page[number] must be at least 1.");
    }
  }

  let size = DEFAULT_PAGE_SIZE;
  if (pageSize !== null) {
    size = parseInt2(pageSize, "page[size]");
    if (size < 1 || size > MAX_PAGE_SIZE) {
      throw new BadRequestError(`page[size] must be between 1 and ${MAX_PAGE_SIZE}.`);
    }
  }

  let includeTotal = false;
  if (metaTotal !== null) {
    if (metaTotal === "true") includeTotal = true;
    else if (metaTotal === "false") includeTotal = false;
    else throw new BadRequestError("meta[total] must be 'true' or 'false'.");
  }

  return {
    number,
    size,
    includeTotal,
    offset: (number - 1) * size,
    limit: size,
  };
}

export interface PaginationMeta {
  page: number;
  size: number;
  total?: number;
  total_pages?: number;
}

/** Build the `meta.pagination` block. `total` is only emitted when the client asked for it. */
export function paginationMeta(p: Pagination, total?: number): PaginationMeta {
  const meta: PaginationMeta = { page: p.number, size: p.size };
  if (p.includeTotal && total !== undefined) {
    meta.total = total;
    meta.total_pages = total > 0 ? Math.ceil(total / p.size) : 0;
  }
  return meta;
}
