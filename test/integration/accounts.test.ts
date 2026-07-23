import { beforeEach, describe, expect, it } from "vitest";
import {
  addMember,
  apiDelete,
  apiGet,
  apiPut,
  bearer,
  makeBenchmark,
  mintKey,
  publish,
  register,
  resetDb,
  type Resource,
} from "./helpers";

beforeEach(resetDb);

describe("account deletion (soft)", () => {
  it("the owner soft-deletes the account and its tokens stop resolving", async () => {
    const me = await register();
    expect((await apiDelete("/api/v1/accounts/current", bearer(me.token))).status).toBe(204);
    // The account is now blocked at auth — the same session token 401s everywhere.
    expect((await apiGet("/api/v1/accounts/current", bearer(me.token))).status).toBe(401);
    expect((await apiGet("/api/v1/benchmarks", bearer(me.token))).status).toBe(401);
  });

  it("a non-owner cannot delete the account (403); the owner still can", async () => {
    const owner = await register();
    const { memberToken } = await addMember(owner.token, owner.account_id, `m-${Date.now()}@example.com`, "ADMIN");
    expect((await apiDelete("/api/v1/accounts/current", bearer(memberToken))).status).toBe(403);
    expect((await apiGet("/api/v1/accounts/current", bearer(owner.token))).status).toBe(200);
  });

  it("an API key cannot delete the account (session-only, 403)", async () => {
    const me = await register();
    const { key } = await mintKey(me.token, { scope_type: "ACCOUNT" });
    expect((await apiDelete("/api/v1/accounts/current", bearer(key))).status).toBe(403);
  });
});

describe("accounts", () => {
  it("returns and updates the caller's own account", async () => {
    const me = await register();
    const cur = await apiGet("/api/v1/accounts/current", bearer(me.token));
    expect(cur.status).toBe(200);
    expect(((await cur.json()) as { data: Resource }).data.id).toBe(me.account_id);

    const put = await apiPut(
      "/api/v1/accounts/current",
      { data: { type: "account", attributes: { name: "Acme", description: "we bench" } } },
      bearer(me.token),
    );
    expect(put.status).toBe(200);
    expect(((await put.json()) as { data: Resource }).data.attributes.name).toBe("Acme");
  });

  it("GET /accounts/{id} is authenticated and scoped to the caller's own account", async () => {
    const me = await register();
    const other = await register("other-acct@example.com");
    // Anonymous → 401. There is no public account directory; a publisher's public identity rides on
    // each benchmark's published_as instead.
    expect((await apiGet(`/api/v1/accounts/${me.account_id}`)).status).toBe(401);
    // Authenticated, own account → 200.
    expect((await apiGet(`/api/v1/accounts/${me.account_id}`, bearer(me.token))).status).toBe(200);
    // Authenticated, someone else's account → indistinguishable 404 (no cross-account probing, no
    // leak of another account's name / personal-publish setting).
    expect((await apiGet(`/api/v1/accounts/${other.account_id}`, bearer(me.token))).status).toBe(404);
    // Publishing a world-visible benchmark no longer makes the account itself publicly readable.
    const b = await makeBenchmark(me.token);
    await publish(me.token, me.user_id, b.id);
    expect((await apiGet(`/api/v1/accounts/${me.account_id}`)).status).toBe(401);
  });
});

describe("users + members", () => {
  it("returns and updates the current user (session only)", async () => {
    const me = await register();
    const cur = await apiGet("/api/v1/users/current", bearer(me.token));
    expect(cur.status).toBe(200);
    expect(((await cur.json()) as { data: Resource }).data.attributes.verified).toBe(false);

    const put = await apiPut(
      "/api/v1/users/current",
      { data: { type: "user", attributes: { display_name: "Renamed" } } },
      bearer(me.token),
    );
    expect(((await put.json()) as { data: Resource }).data.attributes.display_name).toBe("Renamed");
  });

  it("rejects /users/current for an API key (no associated user)", async () => {
    const me = await register();
    const { key } = await mintKey(me.token, { scope_type: "ACCOUNT" });
    expect((await apiGet("/api/v1/users/current", bearer(key))).status).toBe(403);
  });

  it("lists account members", async () => {
    const me = await register();
    const res = await apiGet("/api/v1/account_users", bearer(me.token));
    expect(res.status).toBe(200);
    const list = ((await res.json()) as { data: Resource[] }).data;
    expect(list.length).toBe(1);
    expect(list[0].attributes.role).toBe("OWNER");
    expect(list[0].attributes.user).toBe(me.user_id);
  });
});
