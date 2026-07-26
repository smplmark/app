-- 0026 — publisher-declared license. An optional SPDX identifier (e.g. "CC-BY-4.0") the publisher
-- declares for the benchmark's published data. Nullable — most benchmarks have none, and INGESTED
-- benchmarks carry their source's license in the frozen attribution snapshot instead (which wins on
-- the read side; see serialize/resource.ts).
ALTER TABLE benchmark ADD COLUMN license TEXT;
