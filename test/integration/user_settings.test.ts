import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { addMember, apiGet, bearer, mintKey, register, resetDb } from "./helpers";

beforeEach(resetDb);

const base = (p: string) => `http://smplmark.test${p}`;

/** PUT a plain-JSON (non-resource) settings body. */
function jsonPut(path: string, body: unknown, headers: Record<string, string> = {}) {
  return SELF.fetch(base(path), {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

const settings = "/api/v1/users/current/settings";

describe("user settings", () => {
  it("defaults to an empty object for a fresh user", async () => {
    const me = await register();
    const res = await apiGet(settings, bearer(me.token));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
  });

  it("stores and returns settings, replacing the whole bag on each PUT", async () => {
    const me = await register();

    const put = await jsonPut(settings, { theme: "dark", density: "compact" }, bearer(me.token));
    expect(put.status).toBe(200);
    expect(await put.json()).toEqual({ theme: "dark", density: "compact" });
    expect(await (await apiGet(settings, bearer(me.token))).json()).toEqual({
      theme: "dark",
      density: "compact",
    });

    // Full-replace semantics: a key omitted from the new body is dropped.
    const put2 = await jsonPut(settings, { theme: "light" }, bearer(me.token));
    expect(await put2.json()).toEqual({ theme: "light" });
    expect(await (await apiGet(settings, bearer(me.token))).json()).toEqual({ theme: "light" });
  });

  it("scopes settings per account for the same user", async () => {
    const owner = await register();
    const { user, memberToken } = await addMember(
      owner.token,
      owner.account_id,
      `member-${Date.now()}@example.com`,
      "MEMBER",
    );

    // Same user, in the owner's account (memberToken): setting a theme here must not leak into that
    // same user's OWN account (user.token) — settings live on the membership, not the user.
    await jsonPut(settings, { theme: "dark" }, bearer(memberToken));
    expect(await (await apiGet(settings, bearer(memberToken))).json()).toEqual({ theme: "dark" });
    expect(await (await apiGet(settings, bearer(user.token))).json()).toEqual({});
  });

  it("treats malformed or non-object stored settings as an empty object", async () => {
    const me = await register();
    // Values the API would never have written (corruption / hand-edit) must degrade to {}.
    await env.DB.prepare("UPDATE account_user SET settings = ? WHERE user_id = ?").bind("not json{", me.user_id).run();
    expect(await (await apiGet(settings, bearer(me.token))).json()).toEqual({});
    await env.DB.prepare("UPDATE account_user SET settings = ? WHERE user_id = ?").bind("[1,2,3]", me.user_id).run();
    expect(await (await apiGet(settings, bearer(me.token))).json()).toEqual({});
  });

  it("rejects a non-object body with 400", async () => {
    const me = await register();
    expect((await jsonPut(settings, [1, 2, 3], bearer(me.token))).status).toBe(400);
  });

  it("requires a session credential — an API key is forbidden", async () => {
    const me = await register();
    const { key } = await mintKey(me.token, { scope_type: "ACCOUNT" });
    expect((await apiGet(settings, bearer(key))).status).toBe(403);
    expect((await jsonPut(settings, { theme: "dark" }, bearer(key))).status).toBe(403);
  });

  it("requires authentication", async () => {
    expect((await apiGet(settings)).status).toBe(401);
  });
});
