# smplmark — app

> **This is the `app` repo** — the logged-in console SPA, authentication, and the JSON:API, deployed
> as a single Cloudflare Worker on **app.smplmark.org**, owning the D1 database. The public marketing
> site and the published-benchmark viewer live in the separate **[`website`](https://github.com/smplmark/website)**
> repo on **www.smplmark.org**; that site reads published data from this API cross-origin (see the CORS
> allowance in `src/app.ts` / `isAllowedCorsOrigin` in `src/config.ts`).

A general-purpose, multi-tenant, publicly self-serve **benchmark host** on Cloudflare Workers + D1.
A stranger can sign up, define benchmarks / targets / runs, upload observations (by hand or via API),
and publish — with no special treatment relative to the first-party smplkit account. smplmark does
not validate the truth of the data, only its shape; once published, data is **append-only** and
cannot be quietly altered or removed.

The first real benchmark is smplkit's own **scheduler-latency**: each scheduler POSTs a bare-timestamp
beacon to a live run using a scoped API key; `skew_ms` (how far past the top of the minute the beacon
arrived) is **computed on read** from the timestamp.

- **Stack:** Cloudflare Workers + D1 (serverless SQLite), TypeScript, [Hono](https://hono.dev),
  [json-logic-js](https://github.com/jwadhams/json-logic-js) (derived metrics),
  [jose](https://github.com/panva/jose) (JWT + OIDC), [uPlot](https://github.com/leeoniya/uPlot)
  (charts), [Scalar](https://scalar.com) (API reference). No build step for the static UI.
- **API:** JSON:API (`application/vnd.api+json`), singular resource `type`, plural paths, parent refs
  as bare id attributes (no `relationships`), `snake_case` everywhere. Follows the smplkit API
  standard (`~/projects/app/docs/adrs/ADR-014-api-standards.md`).

## Data model

`account (1)→(N) benchmark (1)→(N) target (1)→(N) run (1)→(N) observation`, plus identity
(`user`, `user_identity`, `account_user`, `session`, `email_verification`, `invitation`) and `api_key`.

- **Roles (per `account_user`):** `VIEWER < MEMBER < ADMIN < OWNER` (mirrors smplkit). VIEWER reads;
  MEMBER edits benchmarks/targets/runs; ADMIN also manages members, invitations, API keys, and
  account settings; OWNER is the account creator (one per account, immutable). Role gating applies to
  session credentials — an API key's authority is bounded by its scope. Members are invited by email
  (`invitation`, 7-day token) via Resend and join on acceptance; a user in more than one account can
  switch between them.

- **Status lifecycle:** `PRIVATE → PUBLISHED → WITHDRAWN` (each transition one-way). PRIVATE is a
  fully-mutable workspace; PUBLISHED is world-visible and append-only; WITHDRAWN keeps the data
  public behind a "withdrawn on X because Y" banner. Invalidating a run is an annotation, never a
  removal — invalidated runs stay visible, flagged.
- **Interpretation freeze:** publishing freezes the semantic core of `sample_schema` (derived
  expressions + chart mapping); only cosmetic labels and prose stay editable.

## Local development

```bash
npm install
cp .dev.vars.example .dev.vars     # local secrets for `wrangler dev` (gitignored)
npm run cf-typegen                 # (re)generate worker-configuration.d.ts

npm run db:migrate:local           # apply migrations to the local D1
node scripts/gen-seed.mjs > scripts/seed.sql   # (re)generate the seed (crypto-derived columns)
npm run db:seed:local              # seed the dev login + accounts (no benchmarks — see below)
node ingestion/import.mjs          # optional: the full ingested dataset (offline, from ingestion/archive/)

npm run dev                        # wrangler dev — http://localhost:8788
```

Local-loop convention: this Worker on **:8788**, the website Worker on **:8787**. The website's
viewer targets `http://localhost:8788` automatically on localhost, so the two `npm run dev`s are
the whole loop (see the website repo's README "Local development").

Pages (this repo): `/login` · `/signup` · `/account` (dashboard) · `/account/{benchmarks,api-keys,
publishers,users,settings,profile}` (self-serve console), `/accept-invitation`, `/verify-email`,
`/api-reference` (Scalar). The bare root `/` redirects to `/account`; marketing/benchmark paths
(`/about`, `/benchmarks/{key}`, …) 301-redirect to the website. The public benchmark viewer
(`/benchmarks/{key}`) itself lives in the website repo.

**Hosting (production):** this Worker serves `app.smplmark.org` (console + auth + API) and owns the
D1 database. The website Worker serves `www.smplmark.org` + apex (marketing + published-benchmark
viewer) and reads this API cross-origin — so the public read endpoints answer CORS for the website's
origin (GET only; every write is same-origin from the console). Non-production hosts (localhost,
previews) behave the same. IP-based rate limiting (Cloudflare `ratelimit` bindings) guards login /
register / invite / contact.

**Dev credentials** (local only): log in at `/login` with `dev@smplkit.test` /
`smplmark-dev-password`. The seed deliberately creates no benchmarks — build one through the
console (create → mark ready → publish → mint a run-scoped key → POST beacons to
`/api/v1/observations`); that end-to-end flow is the product test drive. Ingested reference data
comes from `node ingestion/import.mjs`.

## API

All under `/api/v1`. Two credential sources on the same `Authorization: Bearer` header, dispatched by
prefix: an **API key** (`sm_api_…`, scoped ACCOUNT/BENCHMARK/RUN) or a **session JWT** (everything
else). Public reads of PUBLISHED/WITHDRAWN benchmarks need no credential; PRIVATE resources require a
covering credential. Cross-tenant references return **404** (never leaking existence).

| Group | Endpoints |
| --- | --- |
| Auth (JSON) | `POST /auth/register`, `/auth/login`, `/auth/verify-email`, `/auth/resend-verification`, `/auth/logout`; `GET /auth/oidc/{google\|microsoft}`, `/auth/callback/{provider}` |
| Users / Account | `GET·PUT /users/current`, `GET·PUT /accounts/current`, `GET /accounts/{id}`, `GET /account_users` |
| API keys | `POST·GET /api_keys`, `GET /api_keys/{id}` (reveal), `POST /api_keys/{id}/actions/rotate`, `DELETE /api_keys/{id}` (revoke) |
| Benchmarks | `POST·GET /benchmarks`, `GET·PUT·DELETE /benchmarks/{id}`, `POST /benchmarks/{id}/actions/publish`, `.../actions/withdraw` |
| Targets | `POST·GET /targets` (`filter[benchmark]` required), `GET·PUT·DELETE /targets/{id}` |
| Runs | `POST·GET /runs` (`filter[target]` required), `GET·PUT·DELETE /runs/{id}`, `POST /runs/{id}/actions/end`, `.../actions/invalidate` |
| Observations | `POST /observations` (flat; `run` is a required body field), `GET /observations` (exactly one of `filter[run\|target\|benchmark]`; optional `filter[created_at]` range; `Accept: text/csv` for CSV) |

`sort` (single field, `-` prefix, per-endpoint default + allowed set), `page[number]`/`page[size]`
(default/cap 1000), and `meta[total]` are honored on read-many endpoints. There is deliberately **no
`DELETE` on observations**, and no delete on runs/targets/benchmarks once PUBLISHED — the append-only
stance is structural, not cosmetic.

- **OpenAPI:** generated from the routes at the un-versioned `/api/openapi.json`; rendered by Scalar
  at `/api-reference`.

## Credentials & secrets

Runtime secrets are Worker bindings (`wrangler secret put <NAME>` in prod, `.dev.vars` locally, and
`vitest.config.ts` for tests). Required for full function: `APP_AUTH_SECRET` (session-JWT signing),
`KEY_ENCRYPTION_SECRET` (base64 32-byte AES-GCM key that encrypts API keys at rest for reveal),
`APP_URL` (public origin). Optional — unset ⇒ feature disabled gracefully:
`GOOGLE_OIDC_CLIENT_ID`/`_SECRET`, `MICROSOFT_OIDC_CLIENT_ID`/`_SECRET` (OIDC begin → 503),
`RESEND_API_KEY`/`RESEND_FROM` (verification email → best-effort no-op; a send failure never wedges
signup). Email verification gates *publishing*, not signup.

## Testing

```bash
npm test                 # vitest (unit + integration, via @cloudflare/vitest-pool-workers)
npm run test:coverage    # with coverage gates
npm run typecheck        # tsc for the worker + the node-context config
```

Coverage gates: **90%** global with **100%** on the pure modules (`src/query`, `src/logic`,
`src/serialize`, `src/auth/crypto.ts`).

## Schema management

`migrations/0001_init.sql` is a **one-time clean-slate squash** (there was no production data). The
moment the first real account exists in production, `0001` is frozen and every subsequent schema
change becomes a new forward-only migration (`0002_*`, …) — append-only forever. `scripts/seed.sql`
is generated by `scripts/gen-seed.mjs` (never edit it by hand).

## Deployment

CI (`.github/workflows/deploy.yml`) deploys this Worker to **app.smplmark.org** on every push to
`main`, gated on typecheck + tests: apply forward D1 migrations → `wrangler deploy` → sync secrets.
Auth is `CLOUDFLARE_API_TOKEN`, an **org-level** secret on `smplmark/*` (account id is pinned in
`wrangler.jsonc`).

### Secrets

The source of truth for the Worker's runtime secrets is **GitHub Actions repo secrets on
`smplmark/app`**; the deploy workflow's "Sync Worker secrets" step pushes them to the Worker on every
deploy via `wrangler secret bulk`, omitting any that are unset (so a missing one never clobbers a live
value). **Never `wrangler secret put` by hand** — that creates an unmanaged copy with no source of
truth. Locally, `.dev.vars` supplies them (tests use `vitest.config.ts`).

- Required: `APP_AUTH_SECRET` (session-JWT signing), `KEY_ENCRYPTION_SECRET` (base64 32-byte AES-GCM
  key for API keys at rest).
- Optional (unset → feature off): `RESEND_API_KEY`/`RESEND_FROM`, `GOOGLE_OIDC_CLIENT_ID`/`_SECRET`,
  `MICROSOFT_OIDC_CLIENT_ID`/`_SECRET`, `JOBS_TRIGGER_SECRET`.
- `APP_URL` is intentionally not configured — `appUrl()` derives the origin from the request, which is
  correct on the `app.smplmark.org` custom domain.

### History: the split from the combined Worker

smplmark started as one Worker (`smplmark`, now the website repo) serving all three custom domains.
This repo split the app off (console + auth + API + D1) onto `app.smplmark.org`; the website repo kept
`www` + apex. The D1 database was never moved (`smplmark`, `25d003c3-…`) — only which Worker binds it.
On the first CI deploy here, Cloudflare moved the `app.smplmark.org` custom domain onto this Worker
automatically. To rebuild from scratch: deploy this Worker (claims the domain), and the secret-sync
step provisions its secrets from the repo secrets above.

## Project layout

```
migrations/0001_init.sql   D1 schema (clean-slate squash)
scripts/gen-seed.mjs       generates scripts/seed.sql (crypto-derived columns)
public/                    static console SPA + auth pages (dashboard, benchmarks, publishers, …)
src/
  index.ts app.ts          worker entry + Hono app (routes, docs, static fallthrough)
  types.ts errors.ts config.ts   domain types, JSON:API errors, env/feature config
  http/                    envelope, error rendering, body parsing, dual-credential middleware
  auth/                    crypto (PBKDF2/AES/SHA-256), JWT, API keys, OIDC, scope cache
  authz/                   scope-coverage + authority-ceiling checks
  query/ logic/ schema/    range/sort/pagination, json-logic + compute-on-read, sample_schema
  serialize/               row → JSON:API resource, observations → CSV
  data/                    D1 access (the only layer touching env.DB)
  services/                account provisioning, session issuance
  email/ openapi/          Resend transport, generated spec + Scalar page
  routes/                  auth, users, accounts, account_users, api_keys, benchmarks, targets, runs, observations
```
