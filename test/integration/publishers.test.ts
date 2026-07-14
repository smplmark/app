// Publisher (= domain) CRUD, verify, icon, and authz (§3).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  addMember,
  apiDelete,
  apiGet,
  apiPost,
  apiPut,
  bearer,
  makeBenchmark,
  mintKey,
  register,
  resetDb,
  type Resource,
} from "./helpers";

beforeEach(resetDb);
afterEach(() => vi.unstubAllGlobals());

const pubBody = (attrs: Record<string, unknown>) => ({ data: { type: "publisher", attributes: attrs } });

function stubTxt(records: string[]): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(JSON.stringify({ Answer: records.map((r) => ({ type: 16, data: `"${r}"` })) }), {
          status: 200,
          headers: { "Content-Type": "application/dns-json" },
        }),
    ),
  );
}

/** Stub DoH so each queried DNS name returns its own TXT records (a name not in the map resolves empty). */
function stubTxtByName(map: Record<string, string[]>): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const name = new URL(url).searchParams.get("name") ?? "";
      return new Response(
        JSON.stringify({ Answer: (map[name] ?? []).map((r) => ({ type: 16, data: `"${r}"` })) }),
        { status: 200, headers: { "Content-Type": "application/dns-json" } },
      );
    }),
  );
}

async function createPub(token: string, domain = "acme.com"): Promise<Resource> {
  const res = await apiPost("/api/v1/publishers", pubBody({ domain }), bearer(token));
  expect(res.status).toBe(201);
  return ((await res.json()) as { data: Resource }).data;
}

describe("publisher CRUD", () => {
  it("adds a publisher (PENDING, token, monogram), reads, lists, filters by status, and deletes", async () => {
    const me = await register();
    const p = await createPub(me.token);
    expect(p.attributes.status).toBe("PENDING");
    expect(p.attributes.verified).toBe(false);
    expect(p.attributes.icon).toBe("monogram");
    expect(p.attributes.account).toBe(me.account_id);
    expect((p.attributes.verification_token as string).startsWith("smplmark-verify=")).toBe(true);

    expect((await apiGet(`/api/v1/publishers/${p.id}`, bearer(me.token))).status).toBe(200);

    await createPub(me.token, "beta.com");
    const all = (await (await apiGet("/api/v1/publishers", bearer(me.token))).json()) as { data: Resource[] };
    expect(all.data.map((r) => r.attributes.domain).sort()).toEqual(["acme.com", "beta.com"]);
    const pending = (await (await apiGet("/api/v1/publishers?filter[status]=PENDING", bearer(me.token))).json()) as { data: Resource[] };
    expect(pending.data).toHaveLength(2);
    const verified = (await (await apiGet("/api/v1/publishers?filter[status]=VERIFIED", bearer(me.token))).json()) as { data: Resource[] };
    expect(verified.data).toHaveLength(0);

    expect((await apiDelete(`/api/v1/publishers/${p.id}`, bearer(me.token))).status).toBe(204);
    expect((await apiGet(`/api/v1/publishers/${p.id}`, bearer(me.token))).status).toBe(404);
  });

  it("409s a duplicate domain within the account; another account may add the same domain", async () => {
    const me = await register();
    await createPub(me.token, "shared.com");
    expect((await apiPost("/api/v1/publishers", pubBody({ domain: "shared.com" }), bearer(me.token))).status).toBe(409);
    const other = await register("other@example.com");
    expect((await apiPost("/api/v1/publishers", pubBody({ domain: "shared.com" }), bearer(other.token))).status).toBe(201);
  });

  it("updates the icon preference (monogram → favicon)", async () => {
    const me = await register();
    const p = await createPub(me.token);
    const put = await apiPut(`/api/v1/publishers/${p.id}`, pubBody({ icon: "favicon" }), bearer(me.token));
    expect(put.status).toBe(200);
    expect(((await put.json()) as { data: Resource }).data.attributes.icon).toBe("favicon");
  });

  it("verifies a publisher's domain via a DNS TXT check", async () => {
    const me = await register();
    const p = await createPub(me.token);
    stubTxt([p.attributes.verification_token as string]);
    const res = await apiPost(`/api/v1/publishers/${p.id}/actions/verify`, undefined, bearer(me.token));
    expect(res.status).toBe(200);
    const out = ((await res.json()) as { data: Resource }).data;
    expect(out.attributes.status).toBe("VERIFIED");
    expect(out.attributes.verified).toBe(true);
  });

  it("verifies when the token is only on the _smplmark-verify subdomain, not the apex", async () => {
    const me = await register();
    const p = await createPub(me.token);
    const token = p.attributes.verification_token as string;
    stubTxtByName({ "_smplmark-verify.acme.com": [token] }); // apex has nothing
    const res = await apiPost(`/api/v1/publishers/${p.id}/actions/verify`, undefined, bearer(me.token));
    expect((((await res.json()) as { data: Resource }).data.attributes.status)).toBe("VERIFIED");
  });

  it("does not verify when the token is on an arbitrary (non-accepted) subdomain", async () => {
    const me = await register();
    const p = await createPub(me.token);
    const token = p.attributes.verification_token as string;
    stubTxtByName({ "tenant.acme.com": [token] }); // neither the apex nor _smplmark-verify has it
    const res = await apiPost(`/api/v1/publishers/${p.id}/actions/verify`, undefined, bearer(me.token));
    expect((((await res.json()) as { data: Resource }).data.attributes.status)).toBe("PENDING");
  });

  it("rejects an unknown filter[status] value (400)", async () => {
    const me = await register();
    expect((await apiGet("/api/v1/publishers?filter[status]=BOGUS", bearer(me.token))).status).toBe(400);
  });
});

describe("publisher authz + tenancy", () => {
  it("lets any member read but only admins write / verify / delete", async () => {
    const owner = await register("owner@example.com");
    const p = await createPub(owner.token);
    const { memberToken } = await addMember(owner.token, owner.account_id, "member@example.com", "MEMBER");
    expect((await apiGet("/api/v1/publishers", bearer(memberToken))).status).toBe(200);
    expect((await apiGet(`/api/v1/publishers/${p.id}`, bearer(memberToken))).status).toBe(200);
    expect((await apiPost("/api/v1/publishers", pubBody({ domain: "z.com" }), bearer(memberToken))).status).toBe(403);
    expect((await apiPut(`/api/v1/publishers/${p.id}`, pubBody({ icon: "favicon" }), bearer(memberToken))).status).toBe(403);
    expect((await apiPost(`/api/v1/publishers/${p.id}/actions/verify`, undefined, bearer(memberToken))).status).toBe(403);
    expect((await apiDelete(`/api/v1/publishers/${p.id}`, bearer(memberToken))).status).toBe(403);
  });

  it("requires an account-scoped credential (a benchmark-scoped key is 403)", async () => {
    const owner = await register("scoped@example.com");
    const bench = await makeBenchmark(owner.token, { key: "b1", name: "B1" });
    const { key: benchKey } = await mintKey(owner.token, { scope_type: "BENCHMARK", scope_ref: bench.id });
    expect((await apiGet("/api/v1/publishers", bearer(benchKey))).status).toBe(403);
    expect((await apiPost("/api/v1/publishers", pubBody({ domain: "z.com" }), bearer(benchKey))).status).toBe(403);
  });

  it("isolates tenants (another account's publisher is 404) and requires auth", async () => {
    const a = await register("a@example.com");
    const p = await createPub(a.token);
    const b = await register("b@example.com");
    expect((await apiGet(`/api/v1/publishers/${p.id}`, bearer(b.token))).status).toBe(404);
    expect((await apiPost(`/api/v1/publishers/${p.id}/actions/verify`, undefined, bearer(b.token))).status).toBe(404);
    expect((await apiDelete(`/api/v1/publishers/${p.id}`, bearer(b.token))).status).toBe(404);
    const list = (await (await apiGet("/api/v1/publishers", bearer(b.token))).json()) as { data: Resource[] };
    expect(list.data).toHaveLength(0);
    expect((await apiGet("/api/v1/publishers")).status).toBe(401);
  });
});
