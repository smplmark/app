# smplmark-app — project notes

smplmark is its own product (a benchmark publishing platform): the console SPA + auth + JSON:API,
served by a single Cloudflare Worker on D1. It is **separate** from the smplkit platform services
(app, config, flags, logging, audit) and their 6 SDKs that the global `~/.claude/CLAUDE.md` is mostly
about. The rules below are smplmark-specific and, where they overlap, take precedence for this repo.

## No customers yet — data is disposable

smplmark has no customers and no production data. Until that changes:

- **Don't preserve data across schema changes.** Migrations need not carry data-migration/back-fill
  steps, and wiping or rebuilding the local (or remote) D1 database to move forward is fine. Prefer a
  clean forward migration when it's easy, but data preservation is never a blocker.
- Don't factor "this would surprise existing users" or breaking-change risk into decisions or raise
  it as a reason to stop. (The other stop-and-ask categories — design, architecture, dependencies,
  scope — still apply.)

Revisit when smplmark onboards its first customer.

## No SDKs consume this API

Nothing downstream generates clients from smplmark's OpenAPI spec. The only consumers of the API are
this repo's own console frontend (`public/`) and the separate marketing/website repo. So:

- API contract changes here do **not** trigger SDK regeneration, and there is no SDK-impact or
  showcase blast radius to weigh (that machinery is the smplkit platform's, not smplmark's).
- The OpenAPI spec is generated at runtime by `buildOpenApiDocument` (`src/openapi/spec.ts`) and
  served at `/api/openapi.json`. There is no committed `openapi.json` to keep in sync — update the
  zod registry in `src/openapi/spec.ts` alongside any route/schema change and the spec follows.
- Still keep the spec honest and customer-quality (every field described, JSON:API envelopes for
  resources) — it's the public API reference on the docs page — but treat changes as internal.

Both facts above are expected to hold for a long time; API and database changes are routine here.

## smplkit MCP server — operate the platform via MCP

smplkit runs a **hosted MCP server** at `https://mcp.smplkit.com/api/mcp` that operates the whole platform — feature flags, config, log levels, audit search, and scheduled jobs — exposed as MCP tools (source: the `mcp` repo). When a task means *operating* the platform (reading job runs, flipping a flag, changing a config value, setting a log level, searching the audit log) rather than editing service source, prefer these MCP tools over ad-hoc curl or one-off SDK scripts.

If it isn't connected yet, tell the user and offer to add it:

    claude mcp add --transport http smplkit https://mcp.smplkit.com/api/mcp

First connect does a one-time browser sign-in (Google/Microsoft, WorkOS AuthKit OAuth) and refreshes itself after that. A committed `.mcp.json` at each repo root advertises the same server so Claude Code / Cursor auto-detect it.
