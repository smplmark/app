import { afterEach, describe, expect, it, vi } from "vitest";
import {
  VERIFICATION_TOKEN_PREFIX,
  generateVerificationToken,
  lookupTxt,
  txtRecordsContain,
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
  it("is an exact match over the record set", () => {
    expect(txtRecordsContain(["a", "smplmark-verify=tok", "b"], "smplmark-verify=tok")).toBe(true);
    expect(txtRecordsContain(["smplmark-verify=other"], "smplmark-verify=tok")).toBe(false);
    expect(txtRecordsContain([], "smplmark-verify=tok")).toBe(false);
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
