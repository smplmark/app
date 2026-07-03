import { afterEach, describe, expect, it, vi } from "vitest";
import {
  sendContactAutoresponse,
  sendContactSupportEmail,
  sendInvitationEmail,
  sendVerificationEmail,
} from "../../src/email/resend";

const CONFIGURED = { RESEND_API_KEY: "re_test" } as unknown as Env;
const UNCONFIGURED = {} as unknown as Env;

function stubFetch(ok: boolean) {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(init.body as string) });
      return new Response(null, { status: ok ? 200 : 500 });
    }),
  );
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe("resend email", () => {
  it("no-ops (false) when RESEND_API_KEY is absent", async () => {
    const calls = stubFetch(true);
    expect(await sendVerificationEmail(UNCONFIGURED, { to: "a@b.com", verifyUrl: "https://x/y", displayName: "A" })).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("sends a verification email when configured", async () => {
    const calls = stubFetch(true);
    expect(await sendVerificationEmail(CONFIGURED, { to: "a@b.com", verifyUrl: "https://x/y", displayName: null })).toBe(true);
    expect(calls[0].url).toContain("resend.com");
    expect(String(calls[0].body.from)).toContain("support@smplmark.org");
  });

  it("sends an invitation email with an accept link", async () => {
    const calls = stubFetch(true);
    const ok = await sendInvitationEmail(CONFIGURED, {
      to: "invitee@b.com",
      acceptUrl: "https://app.smplmark.org/accept-invitation?token=t",
      accountName: "Acme <script>",
      inviterName: "Jane",
      role: "MEMBER",
    });
    expect(ok).toBe(true);
    expect(String(calls[0].body.html)).toContain("accept-invitation");
    expect(String(calls[0].body.html)).not.toContain("<script>"); // escaped
  });

  it("sends the contact ticket (reply-to sender) and the auto-response", async () => {
    const calls = stubFetch(true);
    await sendContactSupportEmail(CONFIGURED, {
      fromUserEmail: "u@b.com",
      userName: "U",
      accountName: "Acct",
      accountId: "a1",
      userId: "u1",
      topicLabel: "Technical support",
      message: "help me",
    });
    expect(calls[0].body.to).toBe("support@smplmark.org");
    expect(calls[0].body.reply_to).toBe("u@b.com");

    calls.length = 0;
    await sendContactAutoresponse(CONFIGURED, { to: "u@b.com", firstName: "U", topicLabel: "Technical support", message: "help me" });
    expect(calls[0].body.to).toBe("u@b.com");
  });

  it("handles missing names (invitation + autoresponse fall back gracefully)", async () => {
    const calls = stubFetch(true);
    await sendInvitationEmail(CONFIGURED, {
      to: "i@b.com",
      acceptUrl: "https://app/x",
      accountName: "Acct",
      inviterName: null,
      role: "VIEWER",
    });
    expect(String(calls[0].body.html)).toContain("Someone");

    calls.length = 0;
    await sendContactAutoresponse(CONFIGURED, { to: "u@b.com", firstName: null, topicLabel: "Other", message: "m" });
    expect(String(calls[0].body.html)).toContain("Hi,");
  });

  it("returns false when Resend responds non-2xx", async () => {
    stubFetch(false);
    expect(await sendVerificationEmail(CONFIGURED, { to: "a@b.com", verifyUrl: "https://x", displayName: null })).toBe(false);
  });
});
