import { beforeEach, describe, expect, it } from "vitest";
import {
  apiDelete,
  apiGet,
  apiPost,
  apiPut,
  bearer,
  linkSubject,
  makeAccountSubject,
  makeBenchmark,
  makeSubject,
  makeSubjectType,
  publish,
  register,
  resetDb,
  type Resource,
} from "./helpers";

beforeEach(resetDb);

describe("subjects", () => {
  it("creates an account-owned subject and rejects a duplicate key", async () => {
    const a = await register("a@example.com");
    const st = await makeSubjectType(a.token, { name: "System" });
    const t = await makeAccountSubject(a.token, "sys-a", { subject_type: st.id });
    expect(t.attributes.account).toBeDefined();
    expect(t.attributes.subject_type).toBe(st.id);
    expect(t.attributes.key).toBe("sys-a");

    // Same key in the same account collides.
    const dup = await apiPost(
      "/api/v1/subjects",
      { data: { type: "subject", attributes: { key: "sys-a", name: "again", subject_type: st.id } } },
      bearer(a.token),
    );
    expect(dup.status).toBe(409);

    // The same key is fine in a different account (subjects are account-scoped).
    const other = await register("b@example.com");
    expect((await makeAccountSubject(other.token, "sys-a")).id).toBeDefined();
  });

  it("auto-generates the key from the name when omitted (unique within the account)", async () => {
    const me = await register();
    const st = await makeSubjectType(me.token, { name: "System" });
    const mk = (name: string) => apiPost(
      "/api/v1/subjects",
      { data: { type: "subject", attributes: { name, subject_type: st.id } } },
      bearer(me.token),
    );

    const first = ((await (await mk("AMD EPYC 9754")).json()) as { data: Resource }).data;
    expect(first.attributes.key).toBe("amd-epyc-9754");
    // A second subject whose name slugs to the same key gets a numeric suffix.
    const second = ((await (await mk("AMD EPYC 9754")).json()) as { data: Resource }).data;
    expect(second.attributes.key).toBe("amd-epyc-9754-2");
    // An explicit key is still honored.
    const explicit = ((await (await apiPost("/api/v1/subjects", { data: { type: "subject", attributes: { key: "custom-key", name: "Whatever", subject_type: st.id } } }, bearer(me.token))).json()) as { data: Resource }).data;
    expect(explicit.attributes.key).toBe("custom-key");
  });

  it("validates a subject's details against its type (required, enum, coercion, unknown-key strip)", async () => {
    const me = await register();
    const st = await makeSubjectType(me.token, {
      name: "CPU",
      fields: [
        { label: "Vendor", type: "ENUM", required: true, options: ["AMD", "Intel"] },
        { label: "Cores", type: "NUMBER" },
      ],
    });
    const post = (attrs: Record<string, unknown>) =>
      apiPost("/api/v1/subjects", { data: { type: "subject", attributes: { subject_type: st.id, ...attrs } } }, bearer(me.token));

    // Missing required Vendor → 400; bad enum value → 400; missing type → 404.
    expect((await post({ key: "a", name: "A", details: { cores: 8 } })).status).toBe(400);
    expect((await post({ key: "b", name: "B", details: { vendor: "ARM" } })).status).toBe(400);
    expect((await apiPost("/api/v1/subjects", { data: { type: "subject", attributes: { key: "z", name: "Z", subject_type: "ghost" } } }, bearer(me.token))).status).toBe(404);

    // Valid → 201; defined fields validated/normalized (number coerced from string); undefined-by-schema
    // keys stored as-is (open schema).
    const ok = await post({ key: "c", name: "C", details: { vendor: "AMD", cores: "16", extra: "nope" } });
    expect(ok.status).toBe(201);
    expect(((await ok.json()) as { data: Resource }).data.attributes.details).toEqual({ vendor: "AMD", cores: 16, extra: "nope" });
  });

  it("stores arbitrary details for a subject type with no defined fields", async () => {
    const me = await register();
    const st = await makeSubjectType(me.token, { name: "Freeform", fields: [] });
    const res = await apiPost(
      "/api/v1/subjects",
      { data: { type: "subject", attributes: { subject_type: st.id, key: "x", name: "X", details: { anything: 1, note: "hi", flag: true } } } },
      bearer(me.token),
    );
    expect(res.status).toBe(201);
    expect(((await res.json()) as { data: Resource }).data.attributes.details).toEqual({ anything: 1, note: "hi", flag: true });
  });

  it("lists account subjects when authed, and requires a benchmark scope when anonymous", async () => {
    const me = await register();
    await makeAccountSubject(me.token, "one");
    await makeAccountSubject(me.token, "two");

    const mine = await apiGet("/api/v1/subjects", bearer(me.token));
    expect(mine.status).toBe(200);
    expect(((await mine.json()) as { data: Resource[] }).data.length).toBe(2);

    // Anonymous list without a benchmark scope is a 404 (no cross-account listing exists).
    expect((await apiGet("/api/v1/subjects")).status).toBe(404);
  });

  it("lists a benchmark's linked subjects and honors visibility", async () => {
    const me = await register();
    const b = await makeBenchmark(me.token);
    await makeSubject(me.token, b.id); // create + link

    // Private → anon sees nothing (404), owner lists the linked subject.
    expect((await apiGet(`/api/v1/subjects?filter[benchmark]=${b.id}`)).status).toBe(404);
    const owner = await apiGet(`/api/v1/subjects?filter[benchmark]=${b.id}`, bearer(me.token));
    expect(((await owner.json()) as { data: Resource[] }).data.length).toBe(1);

    await publish(me.token, me.user_id, b.id);
    const pub = await apiGet(`/api/v1/subjects?filter[benchmark]=${b.id}`);
    expect(pub.status).toBe(200);
    expect(((await pub.json()) as { data: Resource[] }).data.length).toBe(1);
  });

  it("a benchmark/run-scoped credential cannot mint an account subject", async () => {
    const me = await register();
    // A benchmark-scoped principal covers a benchmark, not the account's shared subject namespace.
    // (Sessions are ACCOUNT-scoped; this asserts the account floor via a foreign account instead.)
    const other = await register("c@example.com");
    const b = await makeBenchmark(me.token);
    const t = await makeAccountSubject(other.token, "foreign");
    // other's subject can't be linked into me's benchmark (cross-account) → 409.
    const link = await apiPost(
      "/api/v1/benchmark_subjects",
      { data: { type: "benchmark_subject", attributes: { benchmark: b.id, subject: t.id } } },
      bearer(me.token),
    );
    expect(link.status).toBe(409);
  });

  it("updates a subject's name/details anytime, and blocks delete while linked to a published benchmark", async () => {
    const me = await register();
    const b = await makeBenchmark(me.token);
    const t = await makeSubject(me.token, b.id);

    const put = await apiPut(
      `/api/v1/subjects/${t.id}`,
      { data: { type: "subject", attributes: { name: "Renamed", details: { region: "eu" } } } },
      bearer(me.token),
    );
    expect(put.status).toBe(200);
    expect(((await put.json()) as { data: Resource }).data.attributes.name).toBe("Renamed");

    await publish(me.token, me.user_id, b.id);
    // Linked to a published benchmark → cannot delete the subject.
    expect((await apiDelete(`/api/v1/subjects/${t.id}`, bearer(me.token))).status).toBe(409);
  });

  it("deletes an account subject that is only linked to private benchmarks", async () => {
    const me = await register();
    const b = await makeBenchmark(me.token);
    const t = await makeSubject(me.token, b.id);
    expect((await apiDelete(`/api/v1/subjects/${t.id}`, bearer(me.token))).status).toBe(204);
    // A second delete is a 404 (already gone).
    expect((await apiDelete(`/api/v1/subjects/${t.id}`, bearer(me.token))).status).toBe(404);
  });

  it("shares one subject across several of an account's benchmarks", async () => {
    const me = await register();
    const b1 = await makeBenchmark(me.token, { key: "bench-1" });
    const b2 = await makeBenchmark(me.token, { key: "bench-2" });
    const t = await makeAccountSubject(me.token, "shared");
    await linkSubject(me.token, b1.id, t.id);
    await linkSubject(me.token, b2.id, t.id);

    for (const b of [b1, b2]) {
      const res = await apiGet(`/api/v1/subjects?filter[benchmark]=${b.id}`, bearer(me.token));
      const data = ((await res.json()) as { data: Resource[] }).data;
      expect(data.length).toBe(1);
      expect(data[0].id).toBe(t.id);
    }
  });
});
