-- 0025 — takedown requests. A published (or withdrawn) benchmark can never be self-serve deleted;
-- true removal is an operator action, reached through a takedown request filed from the public
-- benchmark page or the console. The row is the operator's work queue; a copy is emailed to support.
-- benchmark_id is a soft pointer (no FK): fulfilling a takedown deletes the benchmark, and the
-- request row must survive as the record of why.
CREATE TABLE takedown_request (
  id TEXT PRIMARY KEY,
  benchmark_id TEXT NOT NULL,
  -- Snapshotted at filing so the request stays legible after the benchmark is removed.
  benchmark_key TEXT NOT NULL,
  publisher_slug TEXT NOT NULL,
  requester_name TEXT NOT NULL,
  requester_email TEXT NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'RESOLVED')),
  resolved_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_takedown_request_benchmark ON takedown_request (benchmark_id);
