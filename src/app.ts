import { Hono } from "hono";
import { cors } from "hono/cors";
import { WWW_HOST, appUrl, isAllowedCorsOrigin } from "./config";
import { NotFoundError } from "./errors";
import { errorResponse } from "./http/jsonapi";
import type { AppBindings } from "./http/middleware";
import { buildOpenApiDocument } from "./openapi/spec";
import { scalarHtml } from "./openapi/scalar";
import { accounts } from "./routes/accounts";
import { accountUsers } from "./routes/account_users";
import { apiKeys } from "./routes/api_keys";
import { auth } from "./routes/auth";
import { benchmarks } from "./routes/benchmarks";
import { emails } from "./routes/emails";
import { invitations } from "./routes/invitations";
import { jobs } from "./routes/jobs";
import { observations } from "./routes/observations";
import { publisherDomains } from "./routes/publisher_domains";
import { publisherIdentities } from "./routes/publisher_identities";
import { runs } from "./routes/runs";
import { targets } from "./routes/targets";
import { users } from "./routes/users";

// ── Routing ──────────────────────────────────────────────────────────────────
// This Worker is the smplmark app — the console SPA + auth + JSON:API, served on app.smplmark.org.
// The marketing site and the published-benchmark viewer live in the separate website repo (www +
// apex). The console is the root here; marketing/benchmark paths that land on the app host are
// redirected to the website so old links resolve. Non-production hosts (localhost, *.workers.dev,
// previews) behave the same. The website reads published data from this API cross-origin (CORS below).

/** Paths whose canonical home is the marketing website (www); redirect stragglers there. */
function isPublicPage(p: string): boolean {
  const roots = ["/about", "/terms", "/privacy", "/benchmarks"];
  return roots.some((r) => p === r || p.startsWith(`${r}/`));
}

export function createApp() {
  const app = new Hono<AppBindings>();

  // CORS for the public API: the marketing website reads published data cross-origin. Only GETs are
  // allowed cross-origin — every write comes from the same-origin console, so a foreign origin can
  // read world-visible data but never mutate. Credentials are not allowed (published reads are
  // unauthenticated). Same-origin console requests are unaffected (CORS is browser-enforced).
  app.use(
    "/api/*",
    cors({
      origin: (origin) => (isAllowedCorsOrigin(origin) ? origin : null),
      allowMethods: ["GET"],
      allowHeaders: ["Accept", "Content-Type"],
      maxAge: 86400,
    }),
  );

  // Path normalization. `run_worker_first: true` routes every request here first.
  app.use("*", async (c, next) => {
    const url = new URL(c.req.url);
    const p = url.pathname;
    // The root serves the console (like smplkit): a logged-in visitor's hard-refresh renders the
    // dashboard in place — URL unchanged, no login flash. The console page's early auth gate
    // (account/index.html <head>) sends a logged-out visitor straight to /login before anything paints.
    if (p === "/") {
      const consoleUrl = new URL(url);
      consoleUrl.pathname = "/account";
      return c.env.ASSETS.fetch(new Request(consoleUrl, { method: "GET", headers: c.req.raw.headers }));
    }
    // Marketing + published benchmarks live on the website; send stragglers there.
    if (isPublicPage(p)) {
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
  app.route("/api/v1/targets", targets);
  app.route("/api/v1/runs", runs);
  app.route("/api/v1/observations", observations);
  app.route("/api/v1/publisher_identities", publisherIdentities);
  app.route("/api/v1/publisher_domains", publisherDomains);
  // System triggers for the Smpl Jobs scheduler (shared-secret auth; not in the public spec).
  app.route("/api/v1/jobs", jobs);

  // ── Docs (ADR-008): un-versioned generated spec + Scalar reference page ──
  app.get("/api/openapi.json", (c) =>
    c.json(buildOpenApiDocument(appUrl(c.env, c.req.url))),
  );
  app.get("/api-reference", (c) => c.html(scalarHtml("/api/openapi.json")));

  // Any thrown AppError (and unexpected errors) render as a JSON:API error document.
  app.onError((err) => errorResponse(err));

  // An unmatched API route is a JSON:API 404 (not the HTML 404 page).
  app.all("/api/*", () => errorResponse(new NotFoundError("No such endpoint.")));

  // Everything else falls through to Static Assets.
  app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

  return app;
}
