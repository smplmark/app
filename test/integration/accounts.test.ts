import { beforeEach, describe, expect, it } from "vitest";
import {
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

describe("accounts", () => {
  it("returns and updates the caller's own account", async () => {
    const me = await register();
    const cur = await apiGet("/api/v1/accounts/current", bearer(me.token));
    expect(cur.status).toBe(200);
    expect(((await cur.json()) as { data: Resource }).data.id).toBe(me.account_id);

    const put = await apiPut(
      "/api/v1/accounts/current",
      { data: { type: "account", attributes: { name: "Acme", description: "we bench", url: "https://acme.test" } } },
      bearer(me.token),
    );
    expect(put.status).toBe(200);
    expect(((await put.json()) as { data: Resource }).data.attributes.name).toBe("Acme");
  });

  it("exposes a publisher publicly only once it has a world-visible benchmark", async () => {
    const me = await register();
    // No public benchmark yet → anonymous lookup 404.
    expect((await apiGet(`/api/v1/accounts/${me.account_id}`)).status).toBe(404);
    // Owner can still read their own account by id.
    expect((await apiGet(`/api/v1/accounts/${me.account_id}`, bearer(me.token))).status).toBe(200);

    const b = await makeBenchmark(me.token);
    await publish(me.token, me.user_id, b.id);
    expect((await apiGet(`/api/v1/accounts/${me.account_id}`)).status).toBe(200);
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
