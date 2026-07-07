// @ts-check
// Stage B — build D1 from the archive. Idempotent and destructive WITHIN THE INGESTED SCOPE ONLY:
// every run wipes the system account's benchmark subtree (a scoped cascade — never a truncate;
// real accounts and their benchmarks are untouched) and rebuilds it from ingestion/archive/.
// Offline by design: never touches a source. Local D1 by default; --remote is the deliberate,
// quota-aware promotion to production.
//
//   node ingestion/import.mjs [--source <key>[,<key>…]] [--limit N] [--full] [--with-held]
//                             [--remote] [--dry-run]
//
//   --source     which archives to import (default: every non-held source with an archive present)
//   --limit N    representative sample of at most N targets per benchmark (iteration mode)
//   --full       lift each adapter's default curation caps (import everything in the archive)
//   --with-held  include sources in HELD_SOURCES (license riders awaiting Mike's call)
//   --remote     execute against production D1 (default: local). Mind the ~100k writes/day tier.
//   --dry-run    build build/import-*.sql and print row counts, but execute nothing
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { sampleBenchmarks } from "./lib/sampler.mjs";
import { buildInsertSql, buildWipeSql } from "./lib/sql.mjs";

const ARCHIVE_ROOT = path.join(import.meta.dirname, "archive");
const BUILD_ROOT = path.join(import.meta.dirname, "build");
const KNOWN_SOURCES = ["blender", "helm", "openllm", "clickbench", "openml", "tpc", "spec"];

// Sources whose license carries a rider needing an explicit business call before we publish them
// (see SOURCES.md). They still pull and import locally with --with-held; they never ride along by
// default, and never to --remote without the flag.
//
// clickbench cleared this list 2026-07-05: smplmark.org is permanently non-commercial (the .com is
// held defensively, unused), which satisfies CC-BY-NC-SA-4.0's NonCommercial clause outright.
const HELD_SOURCES = [];

// Keep any one wrangler execution comfortably inside D1's request limits; multiple files execute
// sequentially, which is also the natural checkpoint for spreading a big remote seed over time.
const MAX_STATEMENTS_PER_FILE = 400;

function parseArgs(argv) {
  const args = { sources: null, limit: undefined, full: false, withHeld: false, remote: false, dryRun: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--source") args.sources = String(argv[++i]).split(",");
    else if (a === "--limit") args.limit = Number(argv[++i]);
    else if (a === "--full") args.full = true;
    else if (a === "--with-held") args.withHeld = true;
    else if (a === "--remote") args.remote = true;
    else if (a === "--dry-run") args.dryRun = true;
    else {
      console.error(`unknown argument ${JSON.stringify(a)}`);
      process.exit(1);
    }
  }
  if (args.limit !== undefined && (!Number.isInteger(args.limit) || args.limit <= 0)) {
    console.error("--limit must be a positive integer");
    process.exit(1);
  }
  return args;
}

async function loadArchive(key) {
  const dir = path.join(ARCHIVE_ROOT, key);
  const manifestPath = path.join(dir, "manifest.json");
  if (!existsSync(manifestPath)) return null;
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  return {
    manifest,
    readJson: (name) => JSON.parse(readFileSync(path.join(dir, name), "utf8")),
    readText: (name) => readFileSync(path.join(dir, name), "utf8"),
  };
}

const args = parseArgs(process.argv);

const requested = args.sources ?? KNOWN_SOURCES.filter((s) => !HELD_SOURCES.includes(s));
for (const key of requested) {
  if (!KNOWN_SOURCES.includes(key)) {
    console.error(`unknown source ${JSON.stringify(key)} — known: ${KNOWN_SOURCES.join(", ")}`);
    process.exit(1);
  }
  if (HELD_SOURCES.includes(key) && !args.withHeld) {
    console.error(
      `${key} is HELD (license rider — see ingestion/SOURCES.md). Pass --with-held to import it anyway; never seed it to --remote without an explicit decision.`,
    );
    process.exit(1);
  }
}

/** @type {import("./lib/sql.mjs").ImportEntry[]} */
const entries = [];
for (const key of requested) {
  const archive = await loadArchive(key);
  if (!archive) {
    if (args.sources) {
      console.error(`${key}: no archive found — run \`node ingestion/pull.mjs ${key}\` first`);
      process.exit(1);
    }
    console.log(`[${key}] no archive — skipping`);
    continue;
  }
  const source = await import(`./lib/sources/${key}.mjs`);
  const adaptOptions = args.full ? source.fullOptions ?? {} : {};
  const benchmarks = source.adapt(archive, adaptOptions);
  for (const benchmark of benchmarks) {
    entries.push({ benchmark, source: source.meta, retrievedAt: archive.manifest.retrieved_at });
  }
  console.log(
    `[${key}] adapted ${benchmarks.length} benchmark(s): ${benchmarks
      .map((b) => `${b.key} (${b.targets.length} targets)`)
      .join(", ")}`,
  );
}
if (entries.length === 0) {
  console.error("nothing to import — no archives present");
  process.exit(1);
}

const sampled = entries.map((e) => ({ ...e }));
if (args.limit) {
  const capped = sampleBenchmarks(sampled.map((e) => e.benchmark), args.limit);
  sampled.forEach((e, i) => (e.benchmark = capped[i]));
}

const wipe = buildWipeSql();
const { statements, counts } = buildInsertSql(sampled);
const all = [...wipe, ...statements];
const totalInserts =
  counts.benchmarks + counts.targets + counts.runs + counts.measurements + counts.tag_links;
console.log(
  `SQL built: ${all.length} statements — ${counts.benchmarks} benchmarks, ${counts.targets} targets, ${counts.runs} runs, ${counts.measurements} measurements, ${counts.tag_links} tag links (~${totalInserts} row writes + wipe)` +
    (counts.clamped > 0 ? ` — ${counts.clamped} over-limit display string(s) clamped` : ""),
);

await rm(BUILD_ROOT, { recursive: true, force: true });
await mkdir(BUILD_ROOT, { recursive: true });
const files = [];
for (let i = 0; i < all.length; i += MAX_STATEMENTS_PER_FILE) {
  const name = `import-${String(files.length + 1).padStart(3, "0")}.sql`;
  await writeFile(
    path.join(BUILD_ROOT, name),
    all.slice(i, i + MAX_STATEMENTS_PER_FILE).map((s) => `${s};`).join("\n") + "\n",
  );
  files.push(name);
}
console.log(`wrote ${files.length} file(s) under ingestion/build/`);

if (args.dryRun) {
  console.log("--dry-run: not executing");
  process.exit(0);
}

if (args.remote) {
  const held = sampled.filter((e) => HELD_SOURCES.includes(e.source.key));
  if (held.length > 0) {
    console.error(
      `refusing --remote with held source(s): ${[...new Set(held.map((e) => e.source.key))].join(", ")} — see ingestion/SOURCES.md`,
    );
    process.exit(1);
  }
}

for (const name of files) {
  const target = args.remote ? "--remote" : "--local";
  console.log(`executing ${name} (${target})…`);
  const res = spawnSync(
    "npx",
    ["wrangler", "d1", "execute", "smplmark", target, "--yes", `--file=${path.join(BUILD_ROOT, name)}`],
    { stdio: "inherit", cwd: path.join(import.meta.dirname, "..") },
  );
  if (res.status !== 0) {
    console.error(`${name} failed (exit ${res.status}) — fix and re-run; the import is a full wipe-and-rebuild, so just re-run the whole import`);
    process.exit(res.status ?? 1);
  }
}
console.log(`import complete (${args.remote ? "REMOTE" : "local"} D1)`);
