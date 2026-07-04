// @ts-check
// Minimal robots.txt evaluation for the Stage A pull: parse the `User-agent: *` group (sources
// won't carry a group for our specific agent) and answer "may we fetch this path?" with
// longest-match-wins semantics. Pure — pull.mjs supplies the fetched text.

/**
 * @typedef {{ allow: boolean, prefix: string }} RobotsRule
 */

/**
 * Extract the rules that apply to us: every `Allow`/`Disallow` line in `User-agent: *` groups.
 * A missing/empty robots.txt (pass "" or null) yields no rules — everything allowed.
 * @param {string | null | undefined} text
 * @returns {RobotsRule[]}
 */
export function parseRobots(text) {
  if (!text) return [];
  /** @type {RobotsRule[]} */
  const rules = [];
  let inStarGroup = false;
  let groupHasDirectives = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (line.length === 0) continue;
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const field = m[1].toLowerCase();
    const value = m[2].trim();
    if (field === "user-agent") {
      // Consecutive user-agent lines share the following directive block; a user-agent line
      // after directives starts a new group.
      if (groupHasDirectives) {
        inStarGroup = value === "*";
        groupHasDirectives = false;
      } else {
        inStarGroup = inStarGroup || value === "*";
      }
    } else if (field === "allow" || field === "disallow") {
      groupHasDirectives = true;
      if (!inStarGroup) continue;
      if (value === "") continue; // "Disallow:" (empty) means allow everything
      rules.push({ allow: field === "allow", prefix: value });
    }
  }
  return rules;
}

/**
 * Longest-match-wins (ties prefer allow). Supports the common `*` wildcard and `$` end anchor.
 * @param {RobotsRule[]} rules
 * @param {string} path e.g. "/benchmarks/query/"
 */
export function isPathAllowed(rules, path) {
  let best = null;
  for (const rule of rules) {
    if (!prefixMatches(rule.prefix, path)) continue;
    if (
      best === null ||
      rule.prefix.length > best.prefix.length ||
      (rule.prefix.length === best.prefix.length && rule.allow && !best.allow)
    ) {
      best = rule;
    }
  }
  return best === null ? true : best.allow;
}

/** @param {string} pattern @param {string} path */
function prefixMatches(pattern, path) {
  const anchored = pattern.endsWith("$");
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const regex = new RegExp(
    "^" + body.split("*").map(escapeRegExp).join(".*") + (anchored ? "$" : ""),
  );
  return regex.test(path);
}

/** @param {string} s */
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
