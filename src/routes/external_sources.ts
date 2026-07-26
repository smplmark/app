// The external-source catalog: which third-party sources smplmark republishes benchmark results
// from, and when data was last retrieved from each. Read-only — rows are maintained by the
// ingestion importer, never through the API.
import { Hono } from "hono";
import { listExternalSources } from "../data/external_sources";
import { collectionResponse } from "../http/jsonapi";
import { optionalAuth, type AppBindings } from "../http/middleware";
import { paginationMeta } from "../query/pagination";
import { serializeExternalSource } from "../serialize/resource";
import { readPagination, readSort } from "./shared";

const SORT_ALLOWED = ["name", "key", "retrieved_at", "benchmark_count"] as const;

export const externalSources = new Hono<AppBindings>();

externalSources.get("/", optionalAuth, async (c) => {
  const pagination = readPagination(c);
  const sort = readSort(c, "name", SORT_ALLOWED);
  const { rows, total } = await listExternalSources(c.env.DB, sort, pagination);
  return collectionResponse(rows.map(serializeExternalSource), {
    meta: { pagination: paginationMeta(pagination, total) },
  });
});
