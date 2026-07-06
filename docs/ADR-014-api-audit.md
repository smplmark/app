# ADR-014 API Standards Audit — `smplmark-app`

**Date:** 2026-07-06
**Auditor:** Claude Code (read-only audit — no code changed)
**Standard:** [`ADR-014: API Design Standards`](../../app/docs/adrs/ADR-014-api-standards.md) (smplkit services)
**Scope:** all `/api/v1/*` routes, their data/serialization layers, and the generated OpenAPI spec.

## Context & method

`smplmark-app` is a **TypeScript / Hono / Cloudflare Workers** service serving a JSON:API at `/api/v1/*`. ADR-014 is the **smplkit Python-services** standard, so its Python/FastAPI-specific *mechanics* (`smplcore.sort_param`, `jsonapi_body(request_model=…)`, `PLAIN_JSON_PATHS`, container/ALB health probes) don't apply literally. This repo has clearly modeled itself on the ADR — it ports the pagination, sort, date-range, JSON:API envelope, and error taxonomy — so the audit targets the **observable HTTP contract** (URLs, methods, status codes, pagination/sort/filter, field naming, enums, auth, spec text) against the ADR's intent.

The shared layer (`errors`, `http/*`, `query/*`, `serialize/*`, `config`, `app.ts`, `openapi/spec.ts`) was read directly; the route groups and spec were audited in depth and every load-bearing finding was verified against source.

**Overall:** the surface is largely conformant. The `api_keys` and `benchmarks` (list) routers are near-reference implementations. Deviations cluster in three themes: (1) the **`sort` contract is unevenly applied**, (2) **several list endpoints skip pagination**, and (3) **the leaderboard endpoint** and a few auth/system endpoints diverge from canonical shapes.

## Findings summary

| # | Severity | Area | Location |
|---|----------|------|----------|
| 1 | **HIGH** | `sort` param absent on 5 read-many endpoints | accounts, account_users, invitations, publisher_identities, publisher_domains |
| 2 | **HIGH** | Pagination + `meta.pagination` absent entirely on 3 lists (unbounded queries) | `accounts.ts:27`, `publisher_identities.ts:63`, `publisher_domains.ts:73` |
| 3 | **HIGH** | Spec `sort` param: no `enum`, no `default`, description advertises unsupported multi-field sort | `openapi/spec.ts:685-691` |
| 4 | **HIGH** | kebab-case URL paths (snake_case is mandated) | `auth.ts:177,191`, `jobs.ts:34` |
| 5 | **HIGH** | `Email.topic` enum is lowercase + not case-insensitively accepted | `emails.ts:16-33`, `spec.ts:335` |
| 6 | **MED** | "slug"/"slugs" in customer-facing spec descriptions | `spec.ts:436,460,1170` |
| 7 | **MED** | Leaderboard `?format=json` negotiation → non-JSON:API `application/json` body | `benchmarks.ts:304,327-342` |
| 8 | **MED** | `filter[facet.<field>]` repeatable-OR operator filter (undocumented filter form) | `benchmarks.ts:312,366-375` |
| 9 | **MED** | `GET /benchmarks/:id/leaderboard` — nested read-many path, not a singleton sub-resource | `benchmarks.ts:283` |
| 10 | **MED** | `POST /invitations/accept` — collection-level action, no `{id}`/`/actions/` | `invitations.ts:147` |
| 11 | **MED** | Catch-all `onError` does not log the exception/traceback | `app.ts:122` |
| 12 | **MED** | `POST /register` duplicate email → 400, but data layer throws 409 (inconsistent; 409 is correct) | `auth.ts:104-109` |
| 13 | **MED** | Status codes outside the ADR tables: `503` (oidc, emails), `410` (accept) | `spec.ts:797,1068,1050` |
| 14 | **MED** | Sub-schema-typed fields lack per-field `description` | `spec.ts:214,426,430,452` |
| 15 | **LOW** | `api_keys` rotate action returns 201 (table says 200) | `api_keys.ts:145` |
| 16 | **LOW** | `GET /accounts/:id` dual-resolution branch (own vs public) | `accounts.ts:65-75` |
| 17 | **LOW** | `targets`/`runs`/`observations` require a mandatory parent filter (targets → 404) | `targets.ts:91`, `runs.ts:115`, `observations.ts` |
| 18 | **LOW** | `POST /auth/switch` request field `account_id` carries `_id` suffix | `auth.ts:218` |
| 19 | **LOW** | Invitations `filter[token]` branch returns collection with no `meta.pagination` + ad-hoc fields | `invitations.ts:91,99,97-98` |
| 20 | **LOW** | Misc spec polish (tag ordering, ephemeral `email` resource id, `MetricDecl.type` example) | `spec.ts:1861`, `emails.ts:66`, `spec.ts:181` |
| — | **N/A** | Health probes `/api/liveness\|readiness\|startup` absent — ADR mechanism is container/ALB; doesn't map to a Worker | — |

---

## HIGH severity

### 1. `sort` parameter missing on five read-many endpoints
ADR *Collection Sorting*: **"Every read-many collection endpoint MUST accept a `sort` query parameter"** with a documented default and enumerated allowed set. `readSort`/`parseSort` is only wired into `benchmarks`, `runs`, `api_keys`, `external_sources`, `observations`, `targets`. Missing on:
- `GET /accounts` (memberships) — `accounts.ts:21`
- `GET /account_users` — `account_users.ts:21`
- `GET /invitations` — `invitations.ts:86`
- `GET /publisher_identities` — `publisher_identities.ts:57`
- `GET /publisher_domains` — `publisher_domains.ts:62`

Each hard-codes an `ORDER BY` in the data layer, so pagination is deterministic, but the client-facing `sort` contract is absent.

### 2. Pagination + `meta.pagination` absent on three lists (unbounded)
ADR *Collection Pagination*: **"Every read-many collection endpoint MUST accept `page[number]`/`page[size]`/`meta[total]`"** and **"every list response carries a `meta.pagination` block."** These three return a bare `{ data: [...] }` with no pagination params and no `LIMIT`/`OFFSET` (full unbounded result set):
- `GET /accounts` — `accounts.ts:27` (`collectionResponse(rows.map(...))`)
- `GET /publisher_identities` — `publisher_identities.ts:63`
- `GET /publisher_domains` — `publisher_domains.ts:73`

`external_sources.ts:20` is the correct pattern to mirror.

### 3. Spec `sort` parameter is broken and misleading
`openapi/spec.ts:685-691` defines one shared `sort` param as a free-form `z.string()` with description *"A comma-separated list of fields to sort by…"*. Three problems vs *Collection Sorting*: (a) **no `enum`** (ADR: "Spec MUST advertise both ascending and `-`-prefixed descending forms in the OpenAPI `enum`"); (b) **no `default`**; (c) the description **advertises comma-separated multi-field sort**, which `parseSort` does not implement and which the ADR explicitly **defers**. Because it's a single shared param, no per-endpoint allowed-set or default can be published.

### 4. kebab-case URL paths
ADR standardized **snake_case** for URL paths and explicitly rejects kebab-case:
- `POST /api/v1/auth/verify-email` — `auth.ts:177` → should be `verify_email`
- `POST /api/v1/auth/resend-verification` — `auth.ts:191` → `resend_verification`
- `POST /api/v1/jobs/domain-recheck` — `jobs.ts:34` → `domain_recheck`

Blast radius is small (auth utilities + an internal trigger), but the rule is unambiguous.

### 5. `Email.topic` enum is lowercase and not case-insensitively accepted
ADR *Enumerated Field Values*: constrained values are **SCREAMING_SNAKE_CASE** on the wire and **accepted case-insensitively**. `emails.ts:16-21` defines `technical`/`account`/`feature_request`/`other`; the handler matches `attrs.topic in TOPICS` (exact, case-sensitive), silently falls back to `"other"` on any mismatch, and echoes the lowercase value back (`emails.ts:70`). The spec mirrors this with a lowercase `z.enum` (`spec.ts:335`). Elsewhere `requireEnum`/`optionalEnum` handle this correctly — `topic` bypasses them.

---

## MEDIUM severity

- **6 — "slug" in customer-facing spec text.** ADR: *"'Slug' does not appear in any API response, request body, UI label, or documentation."* Three descriptions use it: `tags` response (`spec.ts:436`), `tags` request (`spec.ts:460`), `filter[tag]` param (`spec.ts:1170`). (The DB doesn't even use a `slug` column — it uses `key` — so this is pure copy leakage.)

- **7 — Leaderboard `?format=json`.** `benchmarks.ts:304` selects a JSON representation from a query param — contradicting the repo's own rule (`http/content_negotiation.ts:1`: *"format is chosen via the Accept header … not a ?format= param"*) — and returns a bare `application/json` `{ data }` with no envelope/meta (`benchmarks.ts:335`). The CSV branch (via `Accept`) is compliant. The interactive JSON:API branch is also served as `application/json` in the spec rather than `application/vnd.api+json` (`spec.ts:1246`), inconsistent with the same-shaped observations list.

- **8 — `filter[facet.<field>]`.** `benchmarks.ts:366-375` accepts repeatable `filter[facet.X]` keys with OR semantics. ADR *Collection Filtering* sanctions only `filter[field]` exact-match, `filter[search]`, and date ranges; richer operators are **deferred** and operator-suffix proliferation is explicitly discouraged.

- **9 — Leaderboard is a nested read-many path.** `benchmarks.ts:283` — `GET /benchmarks/{id}/leaderboard` returns a paginated/sorted/filtered collection of `leaderboard_entry` resources. That's not the ADR's *singleton sub-resource* (at-most-one, GET/PUT); the ADR prefers flat paths + `filter[parent]` (as `targets`/`runs`/`observations` do with `filter[benchmark]`). A design-level deviation.

- **10 — `POST /invitations/accept`.** `invitations.ts:147` — a collection-level verb with no `{id}` and no `/actions/` segment (contrast the correct `.../actions/revoke|resend`). Justified by token-based acceptance (the caller has a token, not an id), but it's off the canonical grid.

- **11 — Catch-all doesn't log.** ADR *Error Handling Robustness*: *"The catch-all handler must also log the full exception traceback."* `app.ts:122` is `app.onError((err) => errorResponse(err))` — no logging. Because `onError` intercepts, unexpected 500s never reach the Workers platform logger either, so tracebacks are lost. (The JSON:API 500 body itself is correct — Invariant 2 is satisfied.)

- **12 — `/register` duplicate → 400.** `auth.ts:104-109` throws `BadRequestError` (400) for an existing email, while the data layer's unique-violation path throws `ConflictError` (409). A pre-existing resource is a state conflict → 409 per the ADR error table; the two duplicate paths are inconsistent.

- **13 — Status codes outside the ADR tables.** `503` for unconfigured OIDC/messaging (`spec.ts:797`, `1068`) and `410` for an expired invitation (`spec.ts:1050`) are not in the ADR's Success/Error tables (200/201/204 · 400/401/403/404/409/500). Both are defensible operational signals, but strictly out-of-contract. (The OIDC `302` redirects are inherent to the browser flow and reasonably out of the JSON:API resource scope.)

- **14 — Missing per-field descriptions on composite fields.** ADR: *"Set `description` on every field."* Sub-schema-typed fields lack one at the point of use: `chart` (`spec.ts:214`), `published_as` (`spec.ts:426`), `observation_schema` (`spec.ts:430,452`). Scalar fields across entities are otherwise well-described.

---

## LOW severity / observations

- **15** — `api_keys` rotate returns **201** (`api_keys.ts:145`); the action table says 200. Defensible (mints a new key).
- **16** — `GET /accounts/:id` branches between own-account and public lookup (`accounts.ts:65-75`). Not the forbidden UUID-or-slug polymorphism (single UUID id type, 404 when absent) — just visibility-scoped fallback logic; worth a design glance.
- **17** — `targets`/`runs`/`observations` list endpoints make a parent `filter[...]` **mandatory**; `targets` signals absence with **404** (`targets.ts:91`), `runs`/`observations` with 400. Diverges from the "filters are optional narrowing" model; intentional tenancy/cardinality guards.
- **18** — `POST /auth/switch` reads `account_id` (with `_id` suffix) and points errors at `/account_id` (`auth.ts:218`); non-resource endpoint, but exposes DB-style naming where the rest of the API uses bare `account`.
- **19** — Invitations `filter[token]` branch returns `collectionResponse([...])` **without** a `meta.pagination` block (`invitations.ts:91,99`) and injects ad-hoc `account_name`/`invited_by_name` attributes (`invitations.ts:97-98`) not present on the base serializer/spec.
- **20** — Spec polish: tag list only approximately alphabetized (`spec.ts:1861`); `POST /emails` returns a non-persistent `email` resource with a random UUID and no `GET` (`emails.ts:66`); `MetricDecl.type` is a free string with a lowercase `"number"` example (`spec.ts:181`); `account_user` serialized `id` is composite (`account:user`) while the route param is `:userId`.
- **OIDC `provider` enum** (`google`/`microsoft`, `spec.ts:792`) — within the ADR's URL-path-segment carve-out; treating as compliant.

## Not applicable to the Worker runtime

- **Health probes** — ADR mandates `/api/liveness|readiness|startup`; **none exist**. But the ADR's semantics are Kubernetes/ALB ("restart the container", "remove from load balancer", "ALB target group health check"). A Cloudflare Worker has no container or ALB, so the requirement doesn't map. Flagged for completeness only; recommend the ADR carve out Workers explicitly (or add a trivial `/api/liveness` for uniformity). `/api/openapi.json` is correctly served as un-versioned plain-JSON infra and excluded from the spec.

---

## What's compliant (coverage)

- **URL structure:** every router mounts under `/api/v1/{resource_plural}` with snake_case resource names (`app.ts:94-107`).
- **JSON:API envelopes & content type:** `application/vnd.api+json` on responses; distinct `{Entity}Resource/Request/Response/ListResponse` schemas via the `registerEntity` factory, with **request bodies correctly wired to `{Entity}Request`** (the exact mistake the ADR warns about is avoided); no `Generic_TypeParam_` names.
- **Error handling:** 400 (never 422) for validation; client input can't force a 500 (body helpers); every error — including 500 — carries a JSON:API body; cross-tenant lookups return **404 not 403** consistently.
- **Field naming:** no `_id` suffixes, no `is_` prefixes anywhere in the serializers; filter names match response fields (`filter[account]`, `filter[publisher_identity]`, `filter[created_at]`).
- **Enums:** SCREAMING_SNAKE_CASE with case-insensitive acceptance via `requireEnum`/`optionalEnum` (the one exception is `Email.topic`, finding 5).
- **Pagination defaults** match the ADR (1-based, default/max 1000, opt-in `meta[total]`); **date-range interval grammar** implemented per spec; **CSV via `Accept`** header.
- **Search endpoints:** none exist and none are warranted — all search is query-string `filter[search]`, which the ADR says is the correct choice when filters fit in a query string.
- **api_keys** is the reference list implementation (pagination + sort + `meta.pagination` + canonical actions + 404 isolation); **jobs** is correctly excluded from the public spec.
