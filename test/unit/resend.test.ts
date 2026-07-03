import { afterEach, describe, expect, it, vi } from "vitest";
import { sendVerificationEmail } from "../../src/email/resend";

afterEach(() => vi.unstubAllGlobals());

const cfg = { RESEND_API_KEY: "re_test", RESEND_FROM: "smplmark <x@y.z>" } as unknown as Env;
const input = { to: "a@b.com", verifyUrl: "https://smplmark.test/verify?token=x", displayName: "Ann" };

describe("sendVerificationEmail", () => {
  it("is a no-op (false) when Resend is unconfigured", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    expect(await sendVerificationEmail({} as Env, input)).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns true on a 2xx from Resend", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
    expect(await sendVerificationEmail(cfg, input)).toBe(true);
  });

  it("returns false on a non-2xx and handles a null display name / default from", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 500 })));
    expect(
      await sendVerificationEmail({ RESEND_API_KEY: "re_test" } as unknown as Env, {
        ...input,
        displayName: null,
      }),
    ).toBe(false);
  });

  it("returns false when the request throws", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );
    expect(await sendVerificationEmail(cfg, input)).toBe(false);
  });
});
