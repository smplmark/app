import { Hono } from "hono";
import { cors } from "hono/cors";
import { WWW_HOST, appUrl, devLoginEnabled, isAllowedCorsOrigin } from "./config";
import { AppError, NotFoundError } from "./errors";
import { errorResponse } from "./http/jsonapi";
import type { AppBindings } from "./http/middleware";
import { buildOpenApiDocument } from "./openapi/spec";
import { scalarHtml } from "./openapi/scalar";
import { accounts } from "./routes/accounts";
import { accountUsers } from "./routes/account_users";
import { apiKeys } from "./routes/api_keys";
import { auth } from "./routes/auth";
import { benchmarks } from "./routes/benchmarks";
import { benchmarkMetrics } from "./routes/benchmark_metrics";
import { benchmarkSubjects } from "./routes/benchmark_subjects";
import { emails } from "./routes/emails";
import { externalSources } from "./routes/external_sources";
import { invitations } from "./routes/invitations";
import { jobs } from "./routes/jobs";
import { measurements } from "./routes/measurements";
import { metrics } from "./routes/metrics";
import { publishers } from "./routes/publishers";
import { runs } from "./routes/runs";
import { subjects } from "./routes/subjects";
import { subjectTypes } from "./routes/subject_types";
import { takedownRequests } from "./routes/takedown_requests";
import { users } from "./routes/users";

// ── Routing ──────────────────────────────────────────────────────────────────
// This Worker is the smplmark app — the console SPA + auth + JSON:API, served on app.smplmark.org.
// The marketing site and the published-benchmark viewer live in the separate website repo (www +
// apex). The console is the root here; marketing/benchmark paths that land on the app host are
// redirected to the website so old links resolve. Non-production hosts (localhost, *.workers.dev,
// previews) behave the same. The website reads published data from this API cross-origin (CORS below).

/** Paths whose canonical home is the marketing website (www); redirect stragglers there. */
function isPublicPage(p: string): boolean {
  const roots = ["/about", "/terms", "/privacy"];
  return roots.some((r) => p === r || p.startsWith(`${r}/`));
}

/**
 * The console's benchmark section lives at the app-host root (not under /account, which is reserved
 * for account settings): `/benchmarks` is the signed-in list, `/benchmarks/{key}` a benchmark, and
 * `/benchmarks/{key}/runs/{runKey}` a run. These pretty paths have no matching asset file, so map
 * each to the static console shell it renders in; the page JS resolves the key(s) from the URL.
 * Returns the underlying asset path, or null when `p` isn't a console benchmark path.
 */
function consoleBenchmarkAsset(p: string): string | null {
  if (p === "/benchmarks" || p === "/benchmarks/") return "/account/benchmarks";
  if (/^\/benchmarks\/[^/]+\/runs\/[^/]+\/?$/.test(p)) return "/account/runs/detail";
  if (/^\/benchmarks\/[^/]+\/?$/.test(p)) return "/account/benchmarks/detail";
  return null;
}

export function createApp() {
  const app = new Hono<AppBindings>();

  // CORS for the public API: the marketing website reads published data cross-origin, and its
  // benchmark pages POST the unauthenticated view beacon. Auth-bearing writes all come from the
  // same-origin console, carry credentials CORS never grants here (credentials are not allowed),
  // and are gated by auth — CORS is the browser courtesy layer, not the security boundary.
  // Same-origin console requests are unaffected (CORS is browser-enforced).
  app.use(
    "/api/*",
    cors({
      origin: (origin) => (isAllowedCorsOrigin(origin) ? origin : null),
      allowMethods: ["GET", "POST"],
      allowHeaders: ["Accept", "Content-Type"],
      maxAge: 86400,
    }),
  );

  // Path normalization. `run_worker_first: true` routes every request here first.
  app.use("*", async (c, next) => {
    const url = new URL(c.req.url);
    const p = url.pathname;
    // The root renders in place with no redirect, like smplkit: a signed-in visitor sees the console
    // at "/", a signed-out visitor sees the login page at "/" — the URL stays app.smplmark.org either
    // way. The Worker picks which page to serve from the non-sensitive `sm_authed` cookie (set by
    // api.js alongside the real localStorage token). The cookie grants nothing: the console page still
    // requires a valid token, so a forged/stale cookie just falls back to login.
    if (p === "/") {
      const authed = /(?:^|;\s*)sm_authed=1(?:\s*;|\s*$)/.test(c.req.header("Cookie") ?? "");
      // Local dev only: a signed-out visitor is auto-signed-in as the lazily-created dev account (no
      // SSO), so hitting the app drops you straight into the console. Gated on DEV_LOGIN — never prod.
      if (!authed && devLoginEnabled(c.env)) {
        return c.redirect("/api/v1/auth/dev-login", 302);
      }
      const subject = new URL(url);
      subject.pathname = authed ? "/account" : "/login";
      const asset = await c.env.ASSETS.fetch(
        new Request(subject, { method: "GET", headers: c.req.raw.headers }),
      );
      // Same URL, two possible bodies → never let a shared cache serve one visitor's page to another.
      const res = new Response(asset.body, asset);
      res.headers.set("Cache-Control", "no-store");
      res.headers.append("Vary", "Cookie");
      return res;
    }
    // The console's benchmark pages live at pretty app-host paths (/benchmarks[/{key}[/runs/{run}]])
    // that map to a static shell; serve the shell and let the page JS resolve the keys. Like "/", the
    // response varies by auth (the shell requires a token client-side), so it must never be shared.
    const benchAsset = consoleBenchmarkAsset(p);
    if (benchAsset !== null) {
      const subject = new URL(url);
      subject.pathname = benchAsset;
      const asset = await c.env.ASSETS.fetch(
        new Request(subject, { method: "GET", headers: c.req.raw.headers }),
      );
      const res = new Response(asset.body, asset);
      res.headers.set("Cache-Control", "no-store");
      res.headers.append("Vary", "Cookie");
      return res;
    }
    // Marketing pages live on the website; send stragglers there. In the local loop (.dev.vars) that's
    // the local website Worker, not prod — hostname sniffing can't detect dev because wrangler dev
    // presents requests as the configured custom domain. The console benchmark shapes were served
    // above, so any remaining `/benchmarks/…` path is a public benchmark page (`/{publisher}/{key}`)
    // whose home is the website — redirect it there.
    if (isPublicPage(p) || p.startsWith("/benchmarks/")) {
      if (c.env.DEV_WWW_ORIGIN) {
        return c.redirect(new URL(p + url.search, c.env.DEV_WWW_ORIGIN).toString(), 301);
      }
      url.protocol = "https:";
      url.hostname = WWW_HOST;
      url.port = "";
      return c.redirect(url.toString(), 301);
    }
    await next();
  });

  // ── API (JSON:API, /api/v1) ──
  app.route("/api/v1/auth", auth);
  app.route("/api/v1/users", users);
  app.route("/api/v1/accounts", accounts);
  app.route("/api/v1/account_users", accountUsers);
  app.route("/api/v1/invitations", invitations);
  app.route("/api/v1/emails", emails);
  app.route("/api/v1/api_keys", apiKeys);
  app.route("/api/v1/benchmarks", benchmarks);
  app.route("/api/v1/subjects", subjects);
  app.route("/api/v1/subject_types", subjectTypes);
  app.route("/api/v1/metrics", metrics);
  app.route("/api/v1/benchmark_metrics", benchmarkMetrics);
  app.route("/api/v1/benchmark_subjects", benchmarkSubjects);
  app.route("/api/v1/runs", runs);
  app.route("/api/v1/measurements", measurements);
  app.route("/api/v1/external_sources", externalSources);
  app.route("/api/v1/publishers", publishers);
  app.route("/api/v1/takedown_requests", takedownRequests);
  // System triggers for the Smpl Jobs scheduler (shared-secret auth; not in the public spec).
  app.route("/api/v1/jobs", jobs);

  // ── Docs (ADR-008): un-versioned generated spec + Scalar reference page ──
  app.get("/api/openapi.json", (c) =>
    c.json(buildOpenApiDocument(appUrl(c.env, c.req.url))),
  );
  app.get("/api-reference", (c) =>
    // The banner's site links subject the website origin directly (bare origin on the logo);
    // in the local loop that's the local website Worker.
    c.html(scalarHtml("/api/openapi.json", c.env.DEV_WWW_ORIGIN || "https://www.smplmark.org")),
  );

  // Any thrown AppError (and unexpected errors) render as a JSON:API error document. AppErrors are
  // expected client-facing outcomes; anything else is a server fault, so log it — otherwise the cause
  // is swallowed into a bare "Internal Server Error" and is invisible in `wrangler tail`/Workers Logs.
  app.onError((err) => {
    if (!(err instanceof AppError)) console.error("Unhandled error:", err);
    return errorResponse(err);
  });

  // An unmatched API route is a JSON:API 404 (not the HTML 404 page).
  app.all("/api/*", () => errorResponse(new NotFoundError("No such endpoint.")));

  // Everything else falls through to Static Assets.
  app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

  return app;
}
