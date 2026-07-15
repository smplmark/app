// Subject types (§ subject types) — CRUD, server-derived kebab keys, field validation, and authz.
import { beforeEach, describe, expect, it } from "vitest";
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

const body = (attrs: Record<string, unknown>) => ({ data: { type: "subject_type", attributes: attrs } });

async function create(token: string, attrs: Record<string, unknown>): Promise<Resource> {
  const res = await apiPost("/api/v1/subject_types", body(attrs), bearer(token));
  expect(res.status).toBe(201);
  return ((await res.json()) as { data: Resource }).data;
}

describe("subject type CRUD + key derivation", () => {
  it("derives a kebab key from the name (never prompted) and round-trips fields", async () => {
    const me = await register();
    const st = await create(me.token, {
      name: "CPU Configuration",
      fields: [
        { label: "Vendor", type: "ENUM", required: true, options: ["AMD", "Intel", "ARM"] },
        { label: "Cores", type: "NUMBER", required: true },
        { label: "Model name", type: "STRING", max_length: 120 },
        { label: "Launched", type: "DATE" },
        { label: "Preview", type: "BOOLEAN" },
      ],
    });
    expect(st.attributes.key).toBe("cpu-configuration");
    const fields = st.attributes.fields as Array<Record<string, unknown>>;
    // Field names (identifiers) are snake_case slugs of the labels; required defaults to false.
    expect(fields.map((f) => f.name)).toEqual(["vendor", "cores", "model_name", "launched", "preview"]);
    expect(fields[0]).toMatchObject({ label: "Vendor", type: "ENUM", required: true, options: ["AMD", "Intel", "ARM"] });
    expect(fields[2]).toMatchObject({ label: "Model name", type: "STRING", max_length: 120, required: false });
    expect(fields[4]).toMatchObject({ label: "Preview", type: "BOOLEAN", required: false });
  });

  it("suffixes a colliding key, and dedupes colliding field names", async () => {
    const me = await register();
    const a = await create(me.token, { name: "Model" });
    const b = await create(me.token, { name: "Model" });
    expect(a.attributes.key).toBe("model");
    expect(b.attributes.key).toBe("model-2");

    const st = await create(me.token, {
      name: "Dupes",
      fields: [{ label: "Size", type: "NUMBER" }, { label: "size", type: "STRING" }],
    });
    expect((st.attributes.fields as Array<{ name: string }>).map((f) => f.name)).toEqual(["size", "size_2"]);
  });

  it("normalizes a field name to snake_case (lowercase alphanumerics + underscore)", async () => {
    const me = await register();
    const st = await create(me.token, {
      name: "Rig",
      fields: [
        { label: "GPU / VRAM (GB)", type: "NUMBER" },
        { name: "Clock-Speed.MHz", label: "Clock speed", type: "NUMBER" },
      ],
    });
    expect((st.attributes.fields as Array<{ name: string }>).map((f) => f.name)).toEqual(["gpu_vram_gb", "clock_speed_mhz"]);
  });

  it("lists, gets, updates (key immutable), and deletes", async () => {
    const me = await register();
    const st = await create(me.token, { name: "GPU", fields: [{ label: "VRAM", type: "NUMBER" }] });

    const list = (await (await apiGet("/api/v1/subject_types", bearer(me.token))).json()) as { data: Resource[] };
    expect(list.data.map((r) => r.attributes.key)).toEqual(["gpu"]);

    expect((await apiGet(`/api/v1/subject_types/${st.id}`, bearer(me.token))).status).toBe(200);

    const put = await apiPut(
      `/api/v1/subject_types/${st.id}`,
      body({ name: "Graphics card", fields: [{ label: "VRAM", type: "NUMBER", required: true }, { label: "Vendor", type: "STRING" }] }),
      bearer(me.token),
    );
    expect(put.status).toBe(200);
    const updated = ((await put.json()) as { data: Resource }).data;
    expect(updated.attributes.name).toBe("Graphics card");
    expect(updated.attributes.key).toBe("gpu"); // key does not change on rename
    expect((updated.attributes.fields as Array<{ label: string }>).map((f) => f.label)).toEqual(["VRAM", "Vendor"]);

    expect((await apiDelete(`/api/v1/subject_types/${st.id}`, bearer(me.token))).status).toBe(204);
    expect((await apiGet(`/api/v1/subject_types/${st.id}`, bearer(me.token))).status).toBe(404);
  });
});

describe("subject type field validation", () => {
  it("rejects an unknown field type, and an ENUM without options", async () => {
    const me = await register();
    expect((await apiPost("/api/v1/subject_types", body({ name: "X", fields: [{ label: "F", type: "TIMESTAMP" }] }), bearer(me.token))).status).toBe(400);
    expect((await apiPost("/api/v1/subject_types", body({ name: "X", fields: [{ label: "V", type: "ENUM" }] }), bearer(me.token))).status).toBe(400);
    expect((await apiPost("/api/v1/subject_types", body({ name: "X", fields: [{ label: "V", type: "ENUM", options: [] }] }), bearer(me.token))).status).toBe(400);
    // A string max_length must be a whole number between 1 and 255.
    expect((await apiPost("/api/v1/subject_types", body({ name: "X", fields: [{ label: "S", type: "STRING", max_length: 0 }] }), bearer(me.token))).status).toBe(400);
    expect((await apiPost("/api/v1/subject_types", body({ name: "X", fields: [{ label: "S", type: "STRING", max_length: 300 }] }), bearer(me.token))).status).toBe(400);
    expect((await apiPost("/api/v1/subject_types", body({ name: "X", fields: [{ label: "S", type: "STRING", max_length: 255 }] }), bearer(me.token))).status).toBe(201);
    // A field without a label is rejected.
    expect((await apiPost("/api/v1/subject_types", body({ name: "X", fields: [{ type: "STRING" }] }), bearer(me.token))).status).toBe(400);
  });

  it("defaults a string field's max_length to 255 when omitted (no unbounded strings)", async () => {
    const me = await register();
    const st = await create(me.token, { name: "Notes", fields: [{ label: "Note", type: "STRING" }] });
    expect((st.attributes.fields as Array<Record<string, unknown>>)[0]).toMatchObject({ type: "STRING", max_length: 255 });
  });

  it("accepts a type with no fields", async () => {
    const me = await register();
    const st = await create(me.token, { name: "Bare" });
    expect(st.attributes.fields).toEqual([]);
  });
});

describe("subject type authz", () => {
  it("a viewer may read but not create; a benchmark-scoped key cannot manage types", async () => {
    const me = await register();
    const viewer = await addMember(me.token, me.account_id, "viewer@example.com", "VIEWER");
    await create(me.token, { name: "Readable" });

    expect((await apiGet("/api/v1/subject_types", bearer(viewer.memberToken))).status).toBe(200);
    expect((await apiPost("/api/v1/subject_types", body({ name: "Nope" }), bearer(viewer.memberToken))).status).toBe(403);

    const b = await makeBenchmark(me.token);
    const { key: benchKey } = await mintKey(me.token, { scope_type: "BENCHMARK", scope_ref: b.id });
    expect((await apiGet("/api/v1/subject_types", bearer(benchKey))).status).toBe(403);
    expect((await apiPost("/api/v1/subject_types", body({ name: "Nope" }), bearer(benchKey))).status).toBe(403);
  });

  it("isolates tenants (another account's subject type is 404)", async () => {
    const me = await register();
    const other = await register("other@example.com");
    const st = await create(me.token, { name: "Mine" });
    expect((await apiGet(`/api/v1/subject_types/${st.id}`, bearer(other.token))).status).toBe(404);
  });
});

describe("subject type deletion guards", () => {
  it("409s (not 500s) when a benchmark pins the type, even with zero subjects", async () => {
    const me = await register();
    const st = await create(me.token, { name: "Pinned" });
    await makeBenchmark(me.token, { subject_type: st.id });
    const res = await apiDelete(`/api/v1/subject_types/${st.id}`, bearer(me.token));
    expect(res.status).toBe(409);
    const body = (await res.json()) as { errors: { detail: string }[] };
    expect(body.errors[0].detail).toContain("benchmarks");
  });
});
