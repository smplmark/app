import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { apiGet } from "./helpers";

describe("app routing", () => {
  it("returns a JSON:API 404 for an unmatched /api route", async () => {
    const res = await apiGet("/api/v1/nonexistent");
    expect(res.status).toBe(404);
    expect(res.headers.get("Content-Type")).toContain("application/vnd.api+json");
    const doc = (await res.json()) as { errors: { status: string }[] };
    expect(doc.errors[0].status).toBe("404");
  });

  it("falls through to static assets for console pages", async () => {
    const res = await SELF.fetch("http://smplmark.test/login");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("smplmark");
  });

  it("serves a generated OpenAPI document at /api/openapi.json", async () => {
    const res = await apiGet("/api/openapi.json");
    expect(res.status).toBe(200);
    const doc = (await res.json()) as {
      openapi: string;
      paths: Record<string, { get?: { parameters?: { $ref?: string }[] } }>;
      components: { schemas: Record<string, unknown>; parameters: Record<string, unknown> };
    };
    expect(doc.openapi).toBe("3.0.3");
    expect(doc.paths["/api/v1/benchmarks"]).toBeDefined();
    expect(doc.paths["/api/v1/measurements"]).toBeDefined();
    expect(doc.paths["/api/v1/external_sources"]).toBeDefined();
    // The measurement-statistics surface is documented: the stats schemas + the meta[stats] param,
    // which the measurements list path references by $ref.
    expect(doc.components.schemas.MeasurementStats).toBeDefined();
    expect(doc.components.schemas.MetricStats).toBeDefined();
    expect(doc.components.parameters.MetaStats).toBeDefined();
    const measGet = doc.paths["/api/v1/measurements"].get;
    expect((measGet?.parameters ?? []).some((p) => p.$ref === "#/components/parameters/MetaStats")).toBe(true);
  });

  it("serves the Scalar API reference page", async () => {
    const res = await apiGet("/api-reference");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("/api/openapi.json");
    expect(body).toContain("--scalar-color-accent");
    // The site banner (cloned exactly) sits above the Scalar app, API Reference marked active.
    expect(body).toContain('header class="site"');
    expect(body).toContain("/img/logo-dark.png");
    expect(body).toContain('<a href="/api-reference" class="active">API Reference</a>');
    expect(body).toContain('class="reference-wrap"');
    // The logo links the bare website origin (no path); box-sizing matches the site's reset.
    expect(body).toContain('<a class="brand" href="https://www.smplmark.org" title="smplmark home" aria-label="smplmark home">');
    expect(body).toContain("box-sizing: border-box");
    // Theme-aware: a light Scalar palette exists, and the pre-paint script resolves the shared
    // cross-subdomain cookie / console theme before Scalar renders.
    expect(body).toContain(".light-mode");
    expect(body).toContain("--scalar-background-1: #ffffff");
    expect(body).toContain("smplmark-theme");
    expect(body).toContain("darkMode: dark");
    // A header light/dark switch is present and writes the shared cookie on toggle.
    expect(body).toContain('<button class="theme-toggle" type="button" role="switch"');
    expect(body).toContain("location.reload()");
  });
});
