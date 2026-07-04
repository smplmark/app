import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

// Routing for the app Worker (src/app.ts). This deployment serves the console + auth + API on
// app.smplmark.org; the marketing site and published-benchmark viewer live in the separate website
// repo (www + apex). The console is the root; marketing/benchmark paths redirect to the website. The
// website reads published data cross-origin, so the public API answers CORS for allowed origins.
function fetchNoFollow(url: string, init?: RequestInit) {
  return SELF.fetch(url, { redirect: "manual", ...init });
}

const WWW = "https://www.smplmark.org";

describe("app routing", () => {
  it("serves the login page at the root (no redirect)", async () => {
    const res = await fetchNoFollow("http://smplmark.test/");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('id="login-form"');
    expect(body).toContain("Sign in to smplmark");
  });

  it("redirects marketing pages to the website (301)", async () => {
    const res = await fetchNoFollow("https://app.smplmark.org/about");
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe(`${WWW}/about`);
  });

  it("redirects published benchmark pages to the website (301)", async () => {
    const res = await fetchNoFollow("https://app.smplmark.org/benchmarks/scheduler-latency");
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe(`${WWW}/benchmarks/scheduler-latency`);
  });

  it("serves the API directly (no host partition)", async () => {
    const res = await fetchNoFollow("http://smplmark.test/api/v1/benchmarks");
    expect(res.status).toBe(200);
  });
});

describe("public API CORS", () => {
  it("answers a preflight from the website origin", async () => {
    const res = await fetchNoFollow("http://smplmark.test/api/v1/benchmarks", {
      method: "OPTIONS",
      headers: {
        Origin: WWW,
        "Access-Control-Request-Method": "GET",
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe(WWW);
    expect(res.headers.get("access-control-allow-methods")).toContain("GET");
  });

  it("allows a cross-origin GET from the website origin", async () => {
    const res = await SELF.fetch("http://smplmark.test/api/v1/benchmarks", {
      headers: { Origin: WWW },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe(WWW);
  });

  it("does not allow an unknown origin", async () => {
    const res = await SELF.fetch("http://smplmark.test/api/v1/benchmarks", {
      headers: { Origin: "https://evil.example" },
    });
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("does not offer cross-origin writes (GET only)", async () => {
    const res = await fetchNoFollow("http://smplmark.test/api/v1/benchmarks", {
      method: "OPTIONS",
      headers: {
        Origin: WWW,
        "Access-Control-Request-Method": "POST",
      },
    });
    // The allowed-methods list is GET only, so a browser blocks the cross-origin POST.
    expect(res.headers.get("access-control-allow-methods")).not.toContain("POST");
  });
});
