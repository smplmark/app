// The Scalar API-reference page (src/openapi/scalar) — the banner origin defaults to production www.
import { describe, expect, it } from "vitest";
import { scalarHtml } from "../../src/openapi/scalar";

describe("scalarHtml", () => {
  it("points the banner at the production website by default and embeds the spec URL", () => {
    const html = scalarHtml("/api/openapi.json");
    expect(html).toContain('href="https://www.smplmark.org"');
    expect(html).toContain('data-url="/api/openapi.json"');
  });

  it("honors an explicit banner origin", () => {
    expect(scalarHtml("/spec.json", "http://localhost:8787")).toContain('href="http://localhost:8787"');
  });
});
