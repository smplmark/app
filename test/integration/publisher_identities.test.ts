// Publisher identity + domain CRUD and authz (§3).
import { env } from "cloudflare:test";
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

const idBody = (attrs: Record<string, unknown>) => ({
  data: { type: "publisher_identity", attributes: attrs },
});
const domBody = (attrs: Record<string, unknown>) => ({
  data: { type: "publisher_domain", attributes: attrs },
});

async function createIdentity(token: string, attrs: Record<string, unknown> = {}): Promise<Resource> {
  const res = await apiPost(
    "/api/v1/publisher_identities",
    idBody({ key: "acme", name: "Acme", ...attrs }),
    bearer(token),
  );
  expect(res.status).toBe(201);
  return ((await res.json()) as { data: Resource }).data;
}

describe("publisher identity CRUD", () => {
  it("creates, reads, lists (filter[key]), updates, and deletes", async () => {
    const me = await register();
    const created = await createIdentity(me.token, { logo_url: "https://cdn/acme.png" });
    expect(created.attributes.key).toBe("acme");
    expect(created.attributes.account).toBe(me.account_id);
    expect(created.attributes.logo_url).toBe("https://cdn/acme.png");

    // read
    const read = await apiGet(`/api/v1/publisher_identities/${created.id}`, bearer(me.token));
    expect(read.status).toBe(200);

    // list + filter[key]
    await createIdentity(me.token, { key: "beta", name: "Beta" });
    const all = (await (await apiGet("/api/v1/publisher_identities", bearer(me.token))).json()) as { data: Resource[] };
    expect(all.data.map((r) => r.attributes.key).sort()).toEqual(["acme", "beta"]);
    const filtered = (await (
      await apiGet("/api/v1/publisher_identities?filter[key]=beta", bearer(me.token))
    ).json()) as { data: Resource[] };
    expect(filtered.data).toHaveLength(1);
    expect(filtered.data[0].attributes.key).toBe("beta");

    // update
    const put = await apiPut(
      `/api/v1/publisher_identities/${created.id}`,
      idBody({ key: "acme", name: "Acme Renamed", logo_url: null }),
      bearer(me.token),
    );
    expect(put.status).toBe(200);
    expect(((await put.json()) as { data: Resource }).data.attributes.name).toBe("Acme Renamed");

    // delete
    expect((await apiDelete(`/api/v1/publisher_identities/${created.id}`, bearer(me.token))).status).toBe(204);
    expect((await apiGet(`/api/v1/publisher_identities/${created.id}`, bearer(me.token))).status).toBe(404);
  });

  it("409s a duplicate key within the account", async () => {
    const me = await register();
    await createIdentity(me.token);
    const dup = await apiPost("/api/v1/publisher_identities", idBody({ key: "acme", name: "Dup" }), bearer(me.token));
    expect(dup.status).toBe(409);
  });

  it("isolates tenants (another account's identity is 404)", async () => {
    const a = await register("a@example.com");
    const id = await createIdentity(a.token);
    const b = await register("b@example.com");
    expect((await apiGet(`/api/v1/publisher_identities/${id.id}`, bearer(b.token))).status).toBe(404);
    expect(
      (await apiPut(`/api/v1/publisher_identities/${id.id}`, idBody({ key: "x", name: "X" }), bearer(b.token))).status,
    ).toBe(404);
    expect((await apiDelete(`/api/v1/publisher_identities/${id.id}`, bearer(b.token))).status).toBe(404);
  });

  it("scopes reads to the caller's account (never another tenant's)", async () => {
    const a = await register("owner-a@example.com");
    await createIdentity(a.token);
    const b = await register("owner-b@example.com");
    const list = (await (await apiGet("/api/v1/publisher_identities", bearer(b.token))).json()) as { data: Resource[] };
    expect(list.data).toHaveLength(0);
  });
});

describe("publisher identity authz", () => {
  it("lets any member read but only admins write", async () => {
    const owner = await register("owner@example.com");
    const id = await createIdentity(owner.token);
    const { memberToken } = await addMember(owner.token, owner.account_id, "member@example.com", "MEMBER");

    // member can read/list
    expect((await apiGet("/api/v1/publisher_identities", bearer(memberToken))).status).toBe(200);
    expect((await apiGet(`/api/v1/publisher_identities/${id.id}`, bearer(memberToken))).status).toBe(200);

    // member can't create/update/delete
    expect((await apiPost("/api/v1/publisher_identities", idBody({ key: "z", name: "Z" }), bearer(memberToken))).status).toBe(403);
    expect(
      (await apiPut(`/api/v1/publisher_identities/${id.id}`, idBody({ key: "acme", name: "X" }), bearer(memberToken))).status,
    ).toBe(403);
    expect((await apiDelete(`/api/v1/publisher_identities/${id.id}`, bearer(memberToken))).status).toBe(403);
  });

  it("requires an account-scoped credential (a benchmark-scoped key is 403)", async () => {
    const owner = await register("scoped@example.com");
    const bench = await makeBenchmark(owner.token, { key: "b1", name: "B1" });
    const { key: benchKey } = await mintKey(owner.token, { scope_type: "BENCHMARK", scope_ref: bench.id });
    expect((await apiGet("/api/v1/publisher_identities", bearer(benchKey))).status).toBe(403);
    expect((await apiPost("/api/v1/publisher_identities", idBody({ key: "z", name: "Z" }), bearer(benchKey))).status).toBe(403);
  });

  it("requires authentication", async () => {
    expect((await apiGet("/api/v1/publisher_identities")).status).toBe(401);
  });
});

describe("publisher domain CRUD", () => {
  it("adds a domain (PENDING, with a token), lists with filters, and removes it", async () => {
    const me = await register();
    const id = await createIdentity(me.token);
    const created = await apiPost(
      "/api/v1/publisher_domains",
      domBody({ publisher_identity: id.id, domain: "acme.com" }),
      bearer(me.token),
    );
    expect(created.status).toBe(201);
    const dom = ((await created.json()) as { data: Resource }).data;
    expect(dom.attributes.status).toBe("PENDING");
    expect(dom.attributes.verified).toBe(false);
    expect(dom.attributes.publisher_identity).toBe(id.id);
    expect(typeof dom.attributes.verification_token).toBe("string");
    expect((dom.attributes.verification_token as string).startsWith("smplmark-verify=")).toBe(true);

    // list + filter[publisher_identity] + filter[status]
    const byId = (await (
      await apiGet(`/api/v1/publisher_domains?filter[publisher_identity]=${id.id}`, bearer(me.token))
    ).json()) as { data: Resource[] };
    expect(byId.data).toHaveLength(1);
    const pending = (await (
      await apiGet("/api/v1/publisher_domains?filter[status]=PENDING", bearer(me.token))
    ).json()) as { data: Resource[] };
    expect(pending.data).toHaveLength(1);
    const verified = (await (
      await apiGet("/api/v1/publisher_domains?filter[status]=VERIFIED", bearer(me.token))
    ).json()) as { data: Resource[] };
    expect(verified.data).toHaveLength(0);

    // remove
    expect((await apiDelete(`/api/v1/publisher_domains/${dom.id}`, bearer(me.token))).status).toBe(204);
  });

  it("409s a duplicate domain under the same identity but allows the same domain under a different identity", async () => {
    const me = await register();
    const id1 = await createIdentity(me.token, { key: "one" });
    const id2 = await createIdentity(me.token, { key: "two" });
    expect(
      (await apiPost("/api/v1/publisher_domains", domBody({ publisher_identity: id1.id, domain: "shared.com" }), bearer(me.token))).status,
    ).toBe(201);
    // same domain, same identity → 409
    expect(
      (await apiPost("/api/v1/publisher_domains", domBody({ publisher_identity: id1.id, domain: "shared.com" }), bearer(me.token))).status,
    ).toBe(409);
    // same domain, different identity → allowed
    expect(
      (await apiPost("/api/v1/publisher_domains", domBody({ publisher_identity: id2.id, domain: "shared.com" }), bearer(me.token))).status,
    ).toBe(201);
  });

  it("404s adding a domain to an identity in another account", async () => {
    const a = await register("da@example.com");
    const id = await createIdentity(a.token);
    const b = await register("db@example.com");
    const res = await apiPost("/api/v1/publisher_domains", domBody({ publisher_identity: id.id, domain: "x.com" }), bearer(b.token));
    expect(res.status).toBe(404);
  });

  it("rejects an unknown filter[status] value (400)", async () => {
    const me = await register();
    expect((await apiGet("/api/v1/publisher_domains?filter[status]=BOGUS", bearer(me.token))).status).toBe(400);
  });

  it("gates domain writes: members and scoped keys can't manage; auth is required", async () => {
    const owner = await register("downer@example.com");
    const id = await createIdentity(owner.token);
    const { memberToken } = await addMember(owner.token, owner.account_id, "dmember@example.com", "MEMBER");

    // member can list but not create/verify/delete
    expect((await apiGet("/api/v1/publisher_domains", bearer(memberToken))).status).toBe(200);
    expect(
      (await apiPost("/api/v1/publisher_domains", domBody({ publisher_identity: id.id, domain: "m.com" }), bearer(memberToken))).status,
    ).toBe(403);

    // a benchmark-scoped key can't manage domains at all (needs account scope)
    const bench = await makeBenchmark(owner.token, { key: "db1", name: "DB1" });
    const { key: benchKey } = await mintKey(owner.token, { scope_type: "BENCHMARK", scope_ref: bench.id });
    expect((await apiGet("/api/v1/publisher_domains", bearer(benchKey))).status).toBe(403);
    expect(
      (await apiPost("/api/v1/publisher_domains", domBody({ publisher_identity: id.id, domain: "s.com" }), bearer(benchKey))).status,
    ).toBe(403);

    // and unauthenticated is 401
    expect((await apiGet("/api/v1/publisher_domains")).status).toBe(401);
  });

  it("404s verify/delete of an unknown or cross-tenant domain", async () => {
    const a = await register("va@example.com");
    const id = await createIdentity(a.token);
    const created = await apiPost(
      "/api/v1/publisher_domains",
      domBody({ publisher_identity: id.id, domain: "acme.com" }),
      bearer(a.token),
    );
    const dom = ((await created.json()) as { data: Resource }).data;
    const b = await register("vb@example.com");
    // cross-tenant
    expect((await apiPost(`/api/v1/publisher_domains/${dom.id}/actions/verify`, undefined, bearer(b.token))).status).toBe(404);
    expect((await apiDelete(`/api/v1/publisher_domains/${dom.id}`, bearer(b.token))).status).toBe(404);
    // unknown id
    expect((await apiDelete("/api/v1/publisher_domains/ghost", bearer(a.token))).status).toBe(404);
  });

  it("cascades: deleting an identity removes its domains", async () => {
    const me = await register();
    const id = await createIdentity(me.token);
    const created = await apiPost(
      "/api/v1/publisher_domains",
      domBody({ publisher_identity: id.id, domain: "acme.com" }),
      bearer(me.token),
    );
    const dom = ((await created.json()) as { data: Resource }).data;
    expect((await apiDelete(`/api/v1/publisher_identities/${id.id}`, bearer(me.token))).status).toBe(204);
    // the domain row is gone
    const row = await env.DB.prepare("SELECT id FROM publisher_domain WHERE id = ?").bind(dom.id).first();
    expect(row).toBeNull();
  });
});
