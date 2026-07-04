// @ts-check
// Stage A — pull a source's complete data into ingestion/archive/<source>/ (the durable source of
// truth; D1 is a rebuildable projection of it). The ONLY stage that touches the network. Polite:
// identified UA, ~600 ms between requests, retries with backoff, robots.txt preflight.
//
//   node ingestion/pull.mjs <source>|all
//
// Each pull rewrites the source's archive dir and manifest.json (source identity, license,
// retrieved_at, per-file sha256). Re-verify the license statements in SOURCES.md before re-pulling.
import { createHash } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { isPathAllowed, parseRobots } from "./lib/robots.mjs";

const ARCHIVE_ROOT = path.join(import.meta.dirname, "archive");
const USER_AGENT =
  "smplmark-ingestion/1.0 (+https://www.smplmark.org; contact: support@smplmark.org)";
const REQUEST_GAP_MS = 600;
const RETRIES = 3;

const KNOWN_SOURCES = ["blender", "helm", "openllm", "clickbench", "openml"];

let lastRequestAt = 0;
async function politeDelay() {
  const wait = lastRequestAt + REQUEST_GAP_MS - Date.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  lastRequestAt = Date.now();
}

/** Fetch with UA + spacing + backoff on 429/5xx/network errors. */
async function politeFetch(url, accept = "application/json") {
  for (let attempt = 1; ; attempt++) {
    await politeDelay();
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": USER_AGENT, Accept: accept },
        redirect: "follow",
        signal: AbortSignal.timeout(120_000),
      });
      if (res.ok) return res;
      if (attempt <= RETRIES && (res.status === 429 || res.status >= 500)) {
        await new Promise((resolve) => setTimeout(resolve, 2_000 * attempt));
        continue;
      }
      throw new Error(`GET ${url} → ${res.status}`);
    } catch (err) {
      if (attempt <= RETRIES && !(err instanceof Error && err.message.includes("→"))) {
        await new Promise((resolve) => setTimeout(resolve, 2_000 * attempt));
        continue;
      }
      throw err;
    }
  }
}

async function checkRobots(source) {
  const paths = source.robotsPaths ?? [];
  if (paths.length === 0) return;
  let text = null;
  try {
    const res = await politeFetch(`${source.meta.robotsOrigin}/robots.txt`, "text/plain");
    text = await res.text();
  } catch {
    // No robots.txt (404 throws above on non-ok) → nothing disallowed.
    text = null;
  }
  const rules = parseRobots(text);
  for (const p of paths) {
    if (!isPathAllowed(rules, p)) {
      throw new Error(
        `${source.meta.key}: robots.txt at ${source.meta.robotsOrigin} now disallows ${p} — refusing to pull. Update SOURCES.md.`,
      );
    }
  }
  console.log(`  robots.txt ok (${paths.length} path(s) checked)`);
}

function sha256Hex(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

async function pullSource(key) {
  const source = await import(`./lib/sources/${key}.mjs`);
  const dir = path.join(ARCHIVE_ROOT, key);
  console.log(`[${key}] pulling ${source.meta.name} → ${path.relative(process.cwd(), dir)}`);
  await checkRobots(source);

  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });

  /** @type {{name: string, url: string, sha256: string, bytes: number}[]} */
  const files = [];
  const urlsByName = new Map();

  const ctx = {
    async fetchJson(url) {
      const res = await politeFetch(url);
      const text = await res.text();
      ctx._lastUrl = url;
      try {
        return JSON.parse(text);
      } catch {
        throw new Error(`${key}: non-JSON response from ${url}: ${text.slice(0, 200)}`);
      }
    },
    async fetchText(url) {
      const res = await politeFetch(url, "*/*");
      ctx._lastUrl = url;
      return res.text();
    },
    async writeJson(name, data) {
      urlsByName.set(name, ctx._lastUrl ?? source.meta.url);
      const buf = Buffer.from(JSON.stringify(data));
      await writeFile(path.join(dir, name), buf);
      files.push({ name, url: urlsByName.get(name), sha256: sha256Hex(buf), bytes: buf.length });
      console.log(`  ${name} (${buf.length.toLocaleString()} B)`);
    },
    async writeText(name, text) {
      urlsByName.set(name, ctx._lastUrl ?? source.meta.url);
      const buf = Buffer.from(text);
      await writeFile(path.join(dir, name), buf);
      files.push({ name, url: urlsByName.get(name), sha256: sha256Hex(buf), bytes: buf.length });
      console.log(`  ${name} (${buf.length.toLocaleString()} B)`);
    },
    _lastUrl: null,
  };

  await source.pull(ctx);

  const manifest = {
    source: source.meta.key,
    source_name: source.meta.name,
    source_url: source.meta.url,
    license: source.meta.license,
    license_url: source.meta.licenseUrl,
    retrieved_at: Date.now(),
    files,
  };
  await writeFile(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
  console.log(`[${key}] done — ${files.length} file(s), manifest written`);
}

const arg = process.argv[2];
if (!arg) {
  console.error(`usage: node ingestion/pull.mjs <${KNOWN_SOURCES.join("|")}|all>`);
  process.exit(1);
}
const keys = arg === "all" ? KNOWN_SOURCES : [arg];
for (const key of keys) {
  if (!KNOWN_SOURCES.includes(key)) {
    console.error(`unknown source ${JSON.stringify(key)} — known: ${KNOWN_SOURCES.join(", ")}`);
    process.exit(1);
  }
}
try {
  await mkdir(ARCHIVE_ROOT, { recursive: true });
  for (const key of keys) await pullSource(key);
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
