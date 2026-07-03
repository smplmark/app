import { afterEach, describe, expect, it, vi } from "vitest";
import type { OidcClient } from "../../src/config";
import {
  buildAuthorizationUrl,
  discover,
  exchangeCode,
  type Discovery,
} from "../../src/auth/oidc";

afterEach(() => vi.unstubAllGlobals());

const client: OidcClient = {
  clientId: "cid",
  clientSecret: "secret",
  discoveryUrl: "https://oidc.test/.well-known/openid-configuration",
  scope: "openid email profile",
};

const discovery: Discovery = {
  authorization_endpoint: "https://oidc.test/authorize",
  token_endpoint: "https://oidc.test/token",
  jwks_uri: "https://oidc.test/jwks",
  issuer: "https://oidc.test",
};

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("buildAuthorizationUrl", () => {
  it("builds a URL with all OIDC params", () => {
    const url = new URL(
      buildAuthorizationUrl(discovery, client, {
        redirectUri: "https://app.test/cb",
        state: "st",
        nonce: "no",
      }),
    );
    expect(url.origin + url.pathname).toBe("https://oidc.test/authorize");
    expect(url.searchParams.get("client_id")).toBe("cid");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("redirect_uri")).toBe("https://app.test/cb");
    expect(url.searchParams.get("state")).toBe("st");
    expect(url.searchParams.get("nonce")).toBe("no");
  });
});

describe("discover", () => {
  it("fetches + caches the discovery document", async () => {
    const url = "https://disc-a.test/.well-known/openid-configuration";
    const spy = vi.fn(async () => jsonResponse(discovery));
    vi.stubGlobal("fetch", spy);
    expect((await discover(url)).token_endpoint).toBe("https://oidc.test/token");
    expect((await discover(url)).issuer).toBe("https://oidc.test"); // cached
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("throws on a non-2xx discovery response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({}, 500)));
    await expect(
      discover("https://disc-b.test/.well-known/openid-configuration"),
    ).rejects.toBeDefined();
  });
});

describe("exchangeCode", () => {
  it("posts the code and returns tokens", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ id_token: "idt", access_token: "at" })));
    const tokens = await exchangeCode(discovery, client, {
      code: "abc",
      redirectUri: "https://app.test/cb",
    });
    expect(tokens.id_token).toBe("idt");
  });

  it("throws on a failed exchange", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({}, 400)));
    await expect(
      exchangeCode(discovery, client, { code: "x", redirectUri: "https://app.test/cb" }),
    ).rejects.toBeDefined();
  });
});
