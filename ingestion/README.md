# Benchmark ingestion

Seeds smplmark with openly licensed benchmark results from third-party sources, under the built-in
`system` account with frozen `INGESTED` attribution. Due diligence per source lives in
[SOURCES.md](SOURCES.md) — read it before adding or re-pulling anything.

**Mental model: archive = warehouse, local D1 = workbench, remote D1 = storefront.** Rebuild the
workbench from the warehouse freely; restock the storefront from a validated workbench once,
deliberately.

## Stage A — pull (network → archive; run rarely)

```bash
node ingestion/pull.mjs blender     # one source
node ingestion/pull.mjs all
```

Downloads each source's complete data into `ingestion/archive/<source>/` (gitignored — it lives on
the operator's machine) with a `manifest.json` (source identity, license, `retrieved_at`, per-file
sha256). Polite client: identified UA, spaced requests, retries, and a robots.txt preflight that
refuses paths that have become disallowed.

## Stage B — import (archive → D1; run constantly while iterating)

```bash
node ingestion/import.mjs                       # local D1, non-held sources, default caps
node ingestion/import.mjs --source blender --limit 25   # fast representative sample
node ingestion/import.mjs --dry-run             # build SQL + counts only
node ingestion/import.mjs --full                # lift the per-source curation caps
node ingestion/import.mjs --remote              # deliberate promotion to production D1
```

Each run deletes **only** the system account's benchmark subtree (scoped cascade, child-first —
real accounts and the first-party benchmarks are never touched) and rebuilds it from the archive.
`--limit` samples representatively (even stride + edge cases), not head-of-file. Generated SQL
lands in `ingestion/build/` (gitignored) and executes via `wrangler d1 execute` — same code path
local and remote.

Sources listed in `HELD_SOURCES` (import.mjs) have license riders awaiting an explicit decision.
They need `--with-held` locally and are refused for `--remote`. Currently empty — clickbench
(CC-BY-NC-SA-4.0) cleared this list 2026-07-05 once smplmark.org's non-commercial status was
settled as permanent.

## Remote seeding and the D1 free tier

The only real limit is ~100k row-writes/day. `--dry-run` prints the row-write count first; the
build is split into numbered SQL files that execute sequentially, so a large seed can be stopped
and resumed (re-running the import is always safe — it's a full wipe-and-rebuild of the ingested
scope). Validate on local D1, then run one `--remote` pass with a small `--limit`, then the real
seed.

## Adding a source

1. Due diligence first: license + robots verdicts recorded in SOURCES.md (with quotes and URLs).
2. `ingestion/lib/sources/<key>.mjs` exporting `meta`, `robotsPaths`, `pull(ctx)`,
   `adapt(archive, options)` (pure — unit-testable against fixtures), and optionally
   `fullOptions`.
3. Add the key to `KNOWN_SOURCES` in pull.mjs + import.mjs.
4. Unit tests in `test/unit/ingestion_<key>.test.ts` with fixture archives under
   `test/fixtures/ingestion/<key>/`.
