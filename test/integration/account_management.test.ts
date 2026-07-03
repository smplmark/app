import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  JSONAPI,
  apiDelete,
  apiGet,
  apiPost,
  apiPut,
  authPost,
  bearer,
  makeBenchmark,
  makeTarget,
  mintKey,
  register,
  resetDb,
  type Registered,
  type Resource,
} from "./helpers";

beforeEach(async () => {
  await resetDb();
});

function inviteBody(email: string, role: string) {
  return { data: { type: "invitation", attributes: { email, role } } };
}

async function invite(token: string, email: string, role: string): Promise<Resource> {
  const res = await apiPost("/api/v1/invitations", inviteBody(email, role), bearer(token));
  expect(res.status).toBe(201);
  return ((await res.json()) as { data: Resource }).data;
}

/** Register `email`, accept the invite `token` as that new user, then switch into the inviter's account. */
async function joinAs(email: string, inviterAccountId: string, inviteToken: string): Promise<{ user: Registered; memberToken: string }> {
  const user = await register(email);
  const acc = await apiPost(
    "/api/v1/invitations/accept",
    { data: { type: "invitation", attributes: { token: inviteToken } } },
    bearer(user.token),
  );
  expect(acc.status).toBe(200);
  const sw = await authPost("/api/v1/auth/switch", { account_id: inviterAccountId }, bearer(user.token));
  expect(sw.status).toBe(200);
  const memberToken = ((await sw.json()) as { token: string }).token;
  return { user, memberToken };
}

describe("invitations", () => {
  it("creates, lists, previews by token, and accepts an invitation", async () => {
    const owner = await register("owner@example.com");
    const inv = await invite(owner.token, "invitee@example.com", "MEMBER");
    expect(inv.attributes.status).toBe("PENDING");
    expect(inv.attributes.role).toBe("MEMBER");
    expect(typeof inv.attributes.token).toBe("string"); // echoed once on create

    // Admin list shows the pending invite (without the token).
    const list = await apiGet("/api/v1/invitations", bearer(owner.token));
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as { data: Resource[] };
    expect(listBody.data).toHaveLength(1);
    expect(listBody.data[0].attributes.token).toBeUndefined();

    // Public preview by token (no auth) carries the account + inviter names.
    const preview = await apiGet(
      `/api/v1/invitations?filter[token]=${encodeURIComponent(inv.attributes.token as string)}`,
    );
    expect(preview.status).toBe(200);
    const previewBody = (await preview.json()) as { data: Resource[] };
    expect(previewBody.data[0].attributes.email).toBe("invitee@example.com");
    expect(previewBody.data[0].attributes.account_name).toBeTruthy();

    // The invitee joins.
    const { user: invitee } = await joinAs("invitee@example.com", owner.account_id, inv.attributes.token as string);

    // Now a member of the owner's account.
    const members = await apiGet("/api/v1/account_users", bearer(owner.token));
    const memberBody = (await members.json()) as { data: Resource[] };
    expect(memberBody.data).toHaveLength(2);
    const invRow = memberBody.data.find((m) => m.attributes.user === invitee.user_id);
    expect(invRow?.attributes.role).toBe("MEMBER");
    expect(invRow?.attributes.email).toBe("invitee@example.com");
  });

  it("rejects a bad token preview with an empty collection", async () => {
    const res = await apiGet("/api/v1/invitations?filter[token]=nope");
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: Resource[] }).data).toHaveLength(0);
  });

  it("blocks non-admins from inviting and lets members write but not administer", async () => {
    const owner = await register("owner2@example.com");
    const invMember = await invite(owner.token, "member@example.com", "MEMBER");
    const { memberToken } = await joinAs("member@example.com", owner.account_id, invMember.attributes.token as string);

    // A member can create benchmarks in the shared account…
    const bench = await makeBenchmark(memberToken, { key: "by-member", name: "By Member" });
    expect(bench.attributes.account).toBe(owner.account_id);

    // …but cannot invite (admin-only) — 403.
    const denied = await apiPost("/api/v1/invitations", inviteBody("x@example.com", "VIEWER"), bearer(memberToken));
    expect(denied.status).toBe(403);
  });

  it("keeps viewers read-only", async () => {
    const owner = await register("owner3@example.com");
    const invViewer = await invite(owner.token, "viewer@example.com", "VIEWER");
    const { memberToken } = await joinAs("viewer@example.com", owner.account_id, invViewer.attributes.token as string);

    const res = await apiPost(
      "/api/v1/benchmarks",
      { data: { type: "benchmark", attributes: { key: "nope", name: "Nope" } } },
      bearer(memberToken),
    );
    expect(res.status).toBe(403);
  });

  it("409s a duplicate pending invite and an already-member invite", async () => {
    const owner = await register("owner4@example.com");
    await invite(owner.token, "dup@example.com", "MEMBER");
    const again = await apiPost("/api/v1/invitations", inviteBody("dup@example.com", "MEMBER"), bearer(owner.token));
    expect(again.status).toBe(409);

    // Inviting the owner themselves (already a member) → 409.
    const self = await apiPost("/api/v1/invitations", inviteBody("owner4@example.com", "VIEWER"), bearer(owner.token));
    expect(self.status).toBe(409);
  });

  it("revokes and refuses to re-accept, and rejects OWNER/invalid roles", async () => {
    const owner = await register("owner5@example.com");
    const inv = await invite(owner.token, "revoked@example.com", "MEMBER");
    const rev = await apiPost(`/api/v1/invitations/${inv.id}/actions/revoke`, undefined, bearer(owner.token));
    expect(rev.status).toBe(200);
    expect(((await rev.json()) as { data: Resource }).data.attributes.status).toBe("REVOKED");

    // Accepting a revoked invite fails.
    const invitee = await register("revoked@example.com");
    const acc = await apiPost(
      "/api/v1/invitations/accept",
      { data: { type: "invitation", attributes: { token: inv.attributes.token } } },
      bearer(invitee.token),
    );
    expect(acc.status).toBe(409);

    // OWNER is not an invitable role → 400.
    const badRole = await apiPost("/api/v1/invitations", inviteBody("x@example.com", "OWNER"), bearer(owner.token));
    expect(badRole.status).toBe(400);
  });

  it("rejects acceptance by a mismatched email", async () => {
    const owner = await register("owner6@example.com");
    const inv = await invite(owner.token, "target@example.com", "MEMBER");
    const other = await register("someoneelse@example.com");
    const acc = await apiPost(
      "/api/v1/invitations/accept",
      { data: { type: "invitation", attributes: { token: inv.attributes.token } } },
      bearer(other.token),
    );
    expect(acc.status).toBe(403);
  });

  it("resends with a fresh token that still works", async () => {
    const owner = await register("owner7@example.com");
    const inv = await invite(owner.token, "resend@example.com", "VIEWER");
    const resend = await apiPost(`/api/v1/invitations/${inv.id}/actions/resend`, undefined, bearer(owner.token));
    expect(resend.status).toBe(200);
    const newToken = ((await resend.json()) as { data: Resource }).data.attributes.token as string;
    expect(newToken).not.toBe(inv.attributes.token);

    const invitee = await register("resend@example.com");
    const acc = await apiPost(
      "/api/v1/invitations/accept",
      { data: { type: "invitation", attributes: { token: newToken } } },
      bearer(invitee.token),
    );
    expect(acc.status).toBe(200);
  });
});

describe("member management", () => {
  it("changes a member's role and removes them (admin-gated)", async () => {
    const owner = await register("mgr@example.com");
    const inv = await invite(owner.token, "member2@example.com", "VIEWER");
    const { user: member } = await joinAs("member2@example.com", owner.account_id, inv.attributes.token as string);

    // Promote VIEWER → MEMBER.
    const put = await apiPut(
      `/api/v1/account_users/${member.user_id}`,
      { data: { type: "account_user", attributes: { role: "MEMBER" } } },
      bearer(owner.token),
    );
    expect(put.status).toBe(200);
    expect(((await put.json()) as { data: Resource }).data.attributes.role).toBe("MEMBER");

    // Remove them.
    const del = await apiDelete(`/api/v1/account_users/${member.user_id}`, bearer(owner.token));
    expect(del.status).toBe(204);
    const after = await apiGet("/api/v1/account_users", bearer(owner.token));
    expect(((await after.json()) as { data: Resource[] }).data).toHaveLength(1);
  });

  it("protects the owner and prevents self-removal", async () => {
    const owner = await register("owner8@example.com");
    // Change own (owner) role → 400.
    const put = await apiPut(
      `/api/v1/account_users/${owner.user_id}`,
      { data: { type: "account_user", attributes: { role: "MEMBER" } } },
      bearer(owner.token),
    );
    expect(put.status).toBe(400);
    // Remove self → 400.
    const del = await apiDelete(`/api/v1/account_users/${owner.user_id}`, bearer(owner.token));
    expect(del.status).toBe(400);
  });

  it("stops an admin from minting another admin", async () => {
    const owner = await register("owner9@example.com");
    const invAdmin = await invite(owner.token, "admin@example.com", "ADMIN");
    const { memberToken: adminToken } = await joinAs("admin@example.com", owner.account_id, invAdmin.attributes.token as string);

    const invM = await invite(owner.token, "plain@example.com", "MEMBER");
    const { user: plain } = await joinAs("plain@example.com", owner.account_id, invM.attributes.token as string);

    // The admin tries to elevate the member to ADMIN → 403.
    const bad = await apiPut(
      `/api/v1/account_users/${plain.user_id}`,
      { data: { type: "account_user", attributes: { role: "ADMIN" } } },
      bearer(adminToken),
    );
    expect(bad.status).toBe(403);

    // But can set MEMBER/VIEWER.
    const ok = await apiPut(
      `/api/v1/account_users/${plain.user_id}`,
      { data: { type: "account_user", attributes: { role: "VIEWER" } } },
      bearer(adminToken),
    );
    expect(ok.status).toBe(200);
  });
});

describe("account settings — personal-publish opt-in", () => {
  it("defaults off, can be turned on, is left unchanged when omitted, and can be turned off", async () => {
    const owner = await register("settings@example.com");

    const current = await apiGet("/api/v1/accounts/current", bearer(owner.token));
    expect(((await current.json()) as { data: Resource }).data.attributes.allow_personal_publish).toBe(false);

    // turn it on
    const on = await apiPut(
      "/api/v1/accounts/current",
      { data: { type: "account", attributes: { name: "Acct", allow_personal_publish: true } } },
      bearer(owner.token),
    );
    expect(((await on.json()) as { data: Resource }).data.attributes.allow_personal_publish).toBe(true);

    // a settings PUT that omits the flag leaves it unchanged
    const omitted = await apiPut(
      "/api/v1/accounts/current",
      { data: { type: "account", attributes: { name: "Acct Renamed" } } },
      bearer(owner.token),
    );
    const body = ((await omitted.json()) as { data: Resource }).data.attributes;
    expect(body.name).toBe("Acct Renamed");
    expect(body.allow_personal_publish).toBe(true);

    // turn it off
    const off = await apiPut(
      "/api/v1/accounts/current",
      { data: { type: "account", attributes: { name: "Acct Renamed", allow_personal_publish: false } } },
      bearer(owner.token),
    );
    expect(((await off.json()) as { data: Resource }).data.attributes.allow_personal_publish).toBe(false);
  });

  it("400s a non-boolean allow_personal_publish", async () => {
    const owner = await register("badflag@example.com");
    const res = await apiPut(
      "/api/v1/accounts/current",
      { data: { type: "account", attributes: { name: "Acct", allow_personal_publish: "yes" } } },
      bearer(owner.token),
    );
    expect(res.status).toBe(400);
  });
});

describe("account switcher", () => {
  it("lists memberships and switches the active account", async () => {
    const owner = await register("switch-owner@example.com");
    const inv = await invite(owner.token, "switcher@example.com", "MEMBER");
    const invitee = await register("switcher@example.com");
    await apiPost(
      "/api/v1/invitations/accept",
      { data: { type: "invitation", attributes: { token: inv.attributes.token } } },
      bearer(invitee.token),
    );

    // The invitee now belongs to two accounts.
    const mine = await apiGet("/api/v1/accounts", bearer(invitee.token));
    expect(mine.status).toBe(200);
    const accounts = (await mine.json()) as { data: Resource[] };
    expect(accounts.data.length).toBe(2);

    // Switching to a non-member account 404s.
    const bad = await authPost("/api/v1/auth/switch", { account_id: "no-such" }, bearer(invitee.token));
    expect(bad.status).toBe(404);
  });
});

describe("edge cases", () => {
  it("blocks scoped API keys from admin operations and 400s bad invite input", async () => {
    const owner = await register("edge1@example.com");
    const bench = await makeBenchmark(owner.token, { key: "b-edge", name: "B" });
    const { key: benchKey } = await mintKey(owner.token, { scope_type: "BENCHMARK", scope_ref: bench.id });

    // A benchmark-scoped key can't invite (needs account scope).
    const scoped = await apiPost("/api/v1/invitations", inviteBody("x@example.com", "MEMBER"), bearer(benchKey));
    expect(scoped.status).toBe(403);

    // Bad email / missing role → 400.
    const badEmail = await apiPost("/api/v1/invitations", inviteBody("not-an-email", "MEMBER"), bearer(owner.token));
    expect(badEmail.status).toBe(400);
    const noRole = await apiPost(
      "/api/v1/invitations",
      { data: { type: "invitation", attributes: { email: "y@example.com" } } },
      bearer(owner.token),
    );
    expect(noRole.status).toBe(400);
  });

  it("410s an expired invitation and 409s re-accept", async () => {
    const owner = await register("edge2@example.com");
    const inv = await invite(owner.token, "expired@example.com", "MEMBER");
    // Expire it directly.
    await env.DB.prepare("UPDATE invitation SET expires_at = ? WHERE id = ?").bind(1, inv.id).run();
    const invitee = await register("expired@example.com");
    const gone = await apiPost(
      "/api/v1/invitations/accept",
      { data: { type: "invitation", attributes: { token: inv.attributes.token } } },
      bearer(invitee.token),
    );
    expect(gone.status).toBe(410);

    // A fresh invite, accept, then re-accept → 409.
    const inv2 = await invite(owner.token, "twice@example.com", "MEMBER");
    const u2 = await register("twice@example.com");
    const first = await apiPost(
      "/api/v1/invitations/accept",
      { data: { type: "invitation", attributes: { token: inv2.attributes.token } } },
      bearer(u2.token),
    );
    expect(first.status).toBe(200);
    const again = await apiPost(
      "/api/v1/invitations/accept",
      { data: { type: "invitation", attributes: { token: inv2.attributes.token } } },
      bearer(u2.token),
    );
    expect(again.status).toBe(409);
  });

  it("409s revoke/resend of a non-pending invite and 404s unknown ids", async () => {
    const owner = await register("edge3@example.com");
    const inv = await invite(owner.token, "np@example.com", "MEMBER");
    const u = await register("np@example.com");
    await apiPost(
      "/api/v1/invitations/accept",
      { data: { type: "invitation", attributes: { token: inv.attributes.token } } },
      bearer(u.token),
    );
    // Already accepted — can't revoke/resend.
    expect((await apiPost(`/api/v1/invitations/${inv.id}/actions/revoke`, undefined, bearer(owner.token))).status).toBe(409);
    expect((await apiPost(`/api/v1/invitations/${inv.id}/actions/resend`, undefined, bearer(owner.token))).status).toBe(409);
    // Unknown id → 404.
    expect((await apiPost("/api/v1/invitations/nope/actions/revoke", undefined, bearer(owner.token))).status).toBe(404);
  });

  it("gates invitation listing and account settings on the right authority", async () => {
    const owner = await register("edge4@example.com");
    const invV = await invite(owner.token, "vv@example.com", "VIEWER");
    const { memberToken: viewerToken } = await joinAs("vv@example.com", owner.account_id, invV.attributes.token as string);

    // A viewer can't list invitations or edit settings.
    expect((await apiGet("/api/v1/invitations", bearer(viewerToken))).status).toBe(403);
    const put = await apiPut(
      "/api/v1/accounts/current",
      { data: { type: "account", attributes: { name: "New Name" } } },
      bearer(viewerToken),
    );
    expect(put.status).toBe(403);

    // The owner can rename the account.
    const ok = await apiPut(
      "/api/v1/accounts/current",
      { data: { type: "account", attributes: { name: "Renamed" } } },
      bearer(owner.token),
    );
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { data: Resource }).data.attributes.name).toBe("Renamed");
  });

  it("stops a scoped key / API key from the account switcher, and 404s role change on a non-member", async () => {
    const owner = await register("edge5@example.com");
    const { key: acctKey } = await mintKey(owner.token, { scope_type: "ACCOUNT" });
    // An API key has no user → can't list its accounts.
    expect((await apiGet("/api/v1/accounts", bearer(acctKey))).status).toBe(403);
    // Role change on a non-member → 404.
    const nope = await apiPut(
      "/api/v1/account_users/not-a-member",
      { data: { type: "account_user", attributes: { role: "MEMBER" } } },
      bearer(owner.token),
    );
    expect(nope.status).toBe(404);
  });

  it("requires the right authority for invitation + member listing", async () => {
    const owner = await register("edge7@example.com");
    const bench = await makeBenchmark(owner.token, { key: "b7", name: "B7" });
    const { key: benchKey } = await mintKey(owner.token, { scope_type: "BENCHMARK", scope_ref: bench.id });
    const inv = await invite(owner.token, "e7@example.com", "MEMBER");

    // Listing invitations with no auth and no token filter → 403.
    expect((await apiGet("/api/v1/invitations")).status).toBe(403);
    // Revoking with a benchmark-scoped key → 403 (needs account scope).
    expect((await apiPost(`/api/v1/invitations/${inv.id}/actions/revoke`, undefined, bearer(benchKey))).status).toBe(403);
    // Listing members with a benchmark-scoped key → 403.
    expect((await apiGet("/api/v1/account_users", bearer(benchKey))).status).toBe(403);
  });

  it("hides private runs and observations from the public", async () => {
    const owner = await register("edge8@example.com");
    const bench = await makeBenchmark(owner.token, { key: "b8", name: "B8" });
    const target = await makeTarget(owner.token, bench.id, "t8");
    const runRes = await apiPost(
      "/api/v1/runs",
      { data: { type: "run", attributes: { target: target.id, key: "r8" } } },
      bearer(owner.token),
    );
    const run = ((await runRes.json()) as { data: Resource }).data;
    // Anonymous reads of a private run → 404 (no existence leak), for detail and list views.
    expect((await apiGet(`/api/v1/runs/${run.id}`)).status).toBe(404);
    expect((await apiGet(`/api/v1/runs?filter[target]=${target.id}`)).status).toBe(404);
    expect((await apiGet(`/api/v1/targets?filter[benchmark]=${bench.id}`)).status).toBe(404);
    expect((await apiGet(`/api/v1/observations?filter[run]=${run.id}`)).status).toBe(404);
    expect((await apiGet(`/api/v1/observations?filter[target]=${target.id}`)).status).toBe(404);
    expect((await apiGet(`/api/v1/observations?filter[benchmark]=${bench.id}`)).status).toBe(404);
  });

  it("keeps viewers from writing runs and observations", async () => {
    const owner = await register("edge6@example.com");
    const bench = await makeBenchmark(owner.token, { key: "b6", name: "B6" });
    const target = await makeTarget(owner.token, bench.id, "t6");
    const invV = await invite(owner.token, "ro@example.com", "VIEWER");
    const { memberToken: viewerToken } = await joinAs("ro@example.com", owner.account_id, invV.attributes.token as string);

    const run = await apiPost(
      "/api/v1/runs",
      { data: { type: "run", attributes: { target: target.id, key: "r6" } } },
      bearer(viewerToken),
    );
    expect(run.status).toBe(403);
  });
});

describe("contact us", () => {
  it("503s when email is unconfigured (test env) and 400s an empty body", async () => {
    const user = await register("contact@example.com");
    const sent = await apiPost(
      "/api/v1/emails",
      { data: { type: "email", attributes: { topic: "other", body: "hello" } } },
      bearer(user.token),
    );
    expect(sent.status).toBe(503); // no RESEND_API_KEY in tests

    const empty = await apiPost(
      "/api/v1/emails",
      { data: { type: "email", attributes: { topic: "other" } } },
      bearer(user.token),
    );
    expect(empty.status).toBe(400);

    // Over-length body → 400 (before the email guard).
    const tooLong = await apiPost(
      "/api/v1/emails",
      { data: { type: "email", attributes: { topic: "nonsense", body: "x".repeat(10001) } } },
      bearer(user.token),
    );
    expect(tooLong.status).toBe(400);

    const unauth = await apiPost(
      "/api/v1/emails",
      { data: { type: "email", attributes: { body: "hi" } } },
      { "Content-Type": JSONAPI },
    );
    expect(unauth.status).toBe(401);
  });

  it("sends the support ticket + auto-response when email is configured", async () => {
    const user = await register("contact-ok@example.com");
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: "re_1" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    env.RESEND_API_KEY = "re_test";
    try {
      const res = await apiPost(
        "/api/v1/emails",
        { data: { type: "email", attributes: { topic: "technical", body: "please help" } } },
        bearer(user.token),
      );
      expect(res.status).toBe(201);
      const doc = (await res.json()) as { data: Resource };
      expect(doc.data.attributes.topic).toBe("technical");
      expect(typeof doc.data.attributes.sent_at).toBe("string");
      expect(fetchMock).toHaveBeenCalledTimes(2); // support ticket + sender auto-response
    } finally {
      env.RESEND_API_KEY = undefined;
      vi.unstubAllGlobals();
    }
  });

  it("rejects contact from an API key (no user) with 403", async () => {
    const owner = await register("contact-key@example.com");
    const { key } = await mintKey(owner.token, { scope_type: "ACCOUNT" });
    const res = await apiPost(
      "/api/v1/emails",
      { data: { type: "email", attributes: { body: "hi from a key" } } },
      bearer(key),
    );
    expect(res.status).toBe(403);
  });
});
