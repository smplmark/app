import { afterEach, describe, expect, it, vi } from "vitest";
import {
  VERIFICATION_TOKEN_PREFIX,
  domainHasVerificationToken,
  generateVerificationToken,
  lookupTxt,
  txtRecordsContain,
  verificationNames,
} from "../../src/publish/dns";

afterEach(() => vi.unstubAllGlobals());

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/dns-json" } });

/** Capture the outbound request so we can assert the DoH URL + header. */
function stubDoh(body: unknown, status = 200) {
  const fetchMock = vi.fn(async () => json(body, status));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** Stub DoH so each queried DNS name returns its own TXT records (missing name → resolves empty). */
function stubDohByName(map: Record<string, string[]>) {
  const fetchMock = vi.fn(async (url: string) => {
    const name = new URL(url).searchParams.get("name") ?? "";
    return json({ Answer: (map[name] ?? []).map((r) => ({ type: 16, data: `"${r}"` })) });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("generateVerificationToken", () => {
  it("is prefixed and high-entropy (distinct per call)", () => {
    const a = generateVerificationToken();
    const b = generateVerificationToken();
    expect(a.startsWith(VERIFICATION_TOKEN_PREFIX)).toBe(true);
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThan(VERIFICATION_TOKEN_PREFIX.length + 10);
  });
});

describe("txtRecordsContain", () => {
  it("matches the token, tolerating surrounding whitespace and wrapping quotes", () => {
    expect(txtRecordsContain(["a", "smplmark-verify=tok", "b"], "smplmark-verify=tok")).toBe(true);
    expect(txtRecordsContain(["  smplmark-verify=tok  "], "smplmark-verify=tok")).toBe(true);
    expect(txtRecordsContain(['"smplmark-verify=tok"'], "smplmark-verify=tok")).toBe(true);
  });
  it("does not match a different token, an empty set, or an empty needle", () => {
    expect(txtRecordsContain(["smplmark-verify=other"], "smplmark-verify=tok")).toBe(false);
    expect(txtRecordsContain([], "smplmark-verify=tok")).toBe(false);
    expect(txtRecordsContain(["smplmark-verify=tok"], "")).toBe(false);
  });
});

describe("verificationNames", () => {
  it("is the domain root plus the _smplmark-verify subdomain", () => {
    expect(verificationNames("example.com")).toEqual(["example.com", "_smplmark-verify.example.com"]);
  });
});

describe("domainHasVerificationToken", () => {
  const TOK = "smplmark-verify=tok";

  it("verifies when the token is at the domain root", async () => {
    stubDohByName({ "example.com": [TOK] });
    expect(await domainHasVerificationToken("example.com", TOK)).toBe(true);
  });

  it("verifies when the token is at the _smplmark-verify subdomain", async () => {
    stubDohByName({ "_smplmark-verify.example.com": [TOK] });
    expect(await domainHasVerificationToken("example.com", TOK)).toBe(true);
  });

  it("returns false when neither accepted name has the token (both resolve cleanly)", async () => {
    stubDohByName({ "example.com": ["v=spf1 ~all"] });
    expect(await domainHasVerificationToken("example.com", TOK)).toBe(false);
  });

  it("does NOT accept the token at an arbitrary subdomain (subdomain tenants must not claim the parent)", async () => {
    stubDohByName({ "tenant.example.com": [TOK] });
    expect(await domainHasVerificationToken("example.com", TOK)).toBe(false);
  });

  it("throws (inconclusive) when a query fails and the token wasn't found on the other name", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      const name = new URL(url).searchParams.get("name");
      return name === "example.com" ? json({}, 500) : json({ Answer: [] });
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(domainHasVerificationToken("example.com", TOK)).rejects.toThrow(/inconclusive/);
  });

  it("still verifies when one query fails but the other has the token", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      const name = new URL(url).searchParams.get("name");
      return name === "example.com"
        ? json({}, 500)
        : json({ Answer: [{ type: 16, data: `"${TOK}"` }] });
    });
    vi.stubGlobal("fetch", fetchMock);
    expect(await domainHasVerificationToken("example.com", TOK)).toBe(true);
  });
});

describe("lookupTxt", () => {
  it("queries Cloudflare DoH with the dns-json Accept header", async () => {
    const fetchMock = stubDoh({ Answer: [] });
    await lookupTxt("example.com");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("https://cloudflare-dns.com/dns-query?name=example.com&type=TXT");
    expect((init.headers as Record<string, string>).Accept).toBe("application/dns-json");
  });

  it("returns TXT values, unquoting and filtering to type 16", async () => {
    stubDoh({
      Answer: [
        { type: 16, data: '"smplmark-verify=abc"' },
        { type: 5, data: "cname.example.com" }, // ignored (not TXT)
        { type: 16, data: '"v=spf1 include:_spf.example.com ~all"' },
      ],
    });
    expect(await lookupTxt("example.com")).toEqual([
      "smplmark-verify=abc",
      "v=spf1 include:_spf.example.com ~all",
    ]);
  });

  it("joins chunked (multi-quoted) TXT rdata", async () => {
    stubDoh({ Answer: [{ type: 16, data: '"smplmark-" "verify=chunked"' }] });
    expect(await lookupTxt("example.com")).toEqual(["smplmark-verify=chunked"]);
  });

  it("returns [] when the domain resolves with no Answer array", async () => {
    stubDoh({ Status: 3 });
    expect(await lookupTxt("nope.example.com")).toEqual([]);
  });

  it("falls back to raw rdata when it isn't quoted", async () => {
    stubDoh({ Answer: [{ type: 16, data: "smplmark-verify=raw" }] });
    expect(await lookupTxt("example.com")).toEqual(["smplmark-verify=raw"]);
  });

  it("throws on a non-2xx resolver response (so callers never lapse on ambiguity)", async () => {
    stubDoh({}, 502);
    await expect(lookupTxt("example.com")).rejects.toThrow(/failed with status 502/);
  });

  it("propagates a network error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );
    await expect(lookupTxt("example.com")).rejects.toThrow(/network down/);
  });
});
