import { describe, expect, it } from "vitest";
import type { DerivedContext } from "../../src/logic/derived";
import {
  publisherLabel,
  serializeAccount,
  serializeAccountMembership,
  serializeAccountUser,
  serializeApiKey,
  serializeBenchmark,
  serializeHistoryEvent,
  serializeInvitation,
  serializeMeasurement,
  serializePublisher,
  serializeRun,
  serializeSubject,
  serializeSubjectType,
  serializeTakedownRequest,
  serializeUser,
} from "../../src/serialize/resource";
import type { BenchmarkRowWithPublisher } from "../../src/data/benchmarks";
import type {
  AccountRow,
  AccountUserRow,
  ApiKeyRow,
  BenchmarkRow,
  InvitationRow,
  MeasurementRow,
  PublisherRow,
  RunRow,
  MeasurementSchema,
  SubjectRow,
  SubjectTypeRow,
  UserRow,
} from "../../src/types";

const T0 = Date.UTC(2026, 6, 1, 9, 0, 0);
const ISO0 = "2026-07-01T09:00:00.000Z";

describe("serializeUser", () => {
  it("maps email_verified → verified boolean", () => {
    const row: UserRow = { id: "u1", email: "a@b.com", email_verified: 1, display_name: "A", created_at: T0 };
    expect(serializeUser(row)).toEqual({
      type: "user",
      id: "u1",
      attributes: { email: "a@b.com", verified: true, display_name: "A", created_at: ISO0 },
    });
    expect(serializeUser({ ...row, email_verified: 0 }).attributes.verified).toBe(false);
  });
});

describe("serializeAccount", () => {
  it("emits key/name/description, the personal-publish flag, and ISO created_at", () => {
    const row: AccountRow = {
      id: "a1", key: "smplkit", name: "smplkit",
      description: "we build things",
      allow_personal_publish: 1, created_at: T0, deleted_at: null,
    };
    expect(serializeAccount(row).attributes).toEqual({
      key: "smplkit", name: "smplkit", description: "we build things",
      allow_personal_publish: true, created_at: ISO0,
    });
    expect(serializeAccount({ ...row, allow_personal_publish: 0 }).attributes.allow_personal_publish).toBe(false);
  });
});

describe("serializeAccountUser", () => {
  it("synthesizes a composite id and bare reference fields", () => {
    const row: AccountUserRow = { account_id: "a1", user_id: "u1", role: "OWNER", created_at: T0, settings: null };
    expect(serializeAccountUser(row)).toEqual({
      type: "account_user",
      id: "a1:u1",
      attributes: { account: "a1", user: "u1", role: "OWNER", created_at: ISO0 },
    });
  });

  it("surfaces joined identity fields when present", () => {
    const row = { account_id: "a1", user_id: "u1", role: "MEMBER" as const, created_at: T0, settings: null, email: "m@b.com", display_name: null, email_verified: 1 };
    expect(serializeAccountUser(row).attributes).toEqual({
      account: "a1", user: "u1", role: "MEMBER", created_at: ISO0,
      email: "m@b.com", display_name: null, verified: true,
    });
  });
});

describe("serializeAccountMembership", () => {
  it("emits the account + the caller's role", () => {
    expect(
      serializeAccountMembership({ account_id: "a1", account_key: "acme", account_name: "Acme", role: "ADMIN", created_at: T0 }),
    ).toEqual({
      type: "account_membership",
      id: "a1",
      attributes: { account: "a1", key: "acme", name: "Acme", role: "ADMIN", created_at: ISO0 },
    });
  });
});

describe("serializeInvitation", () => {
  const row: InvitationRow = {
    id: "inv1", account_id: "a1", email: "x@b.com", role: "MEMBER", token_hash: "HASH",
    status: "PENDING", invited_by_user_id: "u1", expires_at: T0, accepted_at: null, created_at: T0,
  };
  it("omits the token by default and never leaks the hash", () => {
    const out = serializeInvitation(row);
    expect(out.attributes).toEqual({
      account: "a1", email: "x@b.com", role: "MEMBER", status: "PENDING",
      invited_by_user: "u1", expires_at: ISO0, accepted_at: null, created_at: ISO0,
    });
    expect(out.attributes.token).toBeUndefined();
  });
  it("includes the plaintext token when supplied", () => {
    expect(serializeInvitation(row, "PLAINTOKEN").attributes.token).toBe("PLAINTOKEN");
  });
});

describe("serializeApiKey", () => {
  const row: ApiKeyRow = {
    id: "k1", account_id: "a1", name: "ci", scope_type: "RUN", scope_ref: "r1",
    key_hash: "HASH", key_encrypted: "CIPHER", prefix: "sm_api_abcdefgh",
    expires_at: null, created_by_user_id: "u1", revoked_at: T0, last_used_at: null, created_at: T0,
  };

  it("never surfaces the hash or ciphertext; maps revoked/expires; omits plaintext by default", () => {
    const out = serializeApiKey(row);
    expect(out.attributes).toEqual({
      account: "a1", name: "ci", scope_type: "RUN", scope_ref: "r1", prefix: "sm_api_abcdefgh",
      expires_at: null, last_used_at: null, revoked: true, created_by_user: "u1", created_at: ISO0,
    });
    const s = JSON.stringify(out);
    expect(s).not.toContain("HASH");
    expect(s).not.toContain("CIPHER");
    expect(out.attributes).not.toHaveProperty("key");
  });

  it("includes the plaintext key only when provided (create/reveal)", () => {
    const out = serializeApiKey({ ...row, revoked_at: null, expires_at: T0 }, "sm_api_plain");
    expect(out.attributes.key).toBe("sm_api_plain");
    expect(out.attributes.revoked).toBe(false);
    expect(out.attributes.expires_at).toBe(ISO0);
  });
});

describe("serializeBenchmark", () => {
  const priv: BenchmarkRowWithPublisher = {
    id: "b1", account_id: "a1", publisher_slug: "acme", key: "sched", name: "Sched",
    description: null, about: null, methodology: null, license: null,
    // subject_type is the internal UUID (never surfaced); subject_type_key is the wire reference.
    subject_type: "st-uuid-1", subject_type_key: "cpu", status: "PRIVATE",
    published_at: null, withdrawn_at: null, withdrawal_reason: null,
    measurement_schema: "{}",
    created_by_user_id: "u1", draft: 1,
    published_by_user_id: null, published_as_kind: null, published_identity_id: null,
    attribution_snapshot: null, category: "OTHER",
    search_text: "", views_total: 0, closed_at: null,
    created_at: T0, updated_at: T0,
  };

  it("surfaces draft/created_by, omits published_* while unpublished, and never leaks account_id", () => {
    const out = serializeBenchmark(priv, []);
    expect(out.type).toBe("benchmark");
    expect(out.attributes.account).toBe("a1");
    expect(out.attributes.publisher_slug).toBe("acme");
    expect(out.attributes.draft).toBe(true);
    expect(out.attributes.created_by).toBe("u1");
    expect(out.attributes.category).toBe("OTHER");
    expect(out.attributes.tags).toEqual([]);
    expect(out.attributes.views).toBe(0);
    expect(out.attributes.published_at).toBeNull();
    expect(out.attributes.withdrawn_at).toBeNull();
    expect(out.attributes).not.toHaveProperty("published_by");
    expect(out.attributes).not.toHaveProperty("published_as");
    expect(out.attributes).not.toHaveProperty("account_id");
  });

  it("surfaces the frozen publisher since-date in published_as for ORGANIZATION and PERSONAL", () => {
    const org = serializeBenchmark(
      { ...priv, published_as_kind: "ORGANIZATION", attribution_snapshot: JSON.stringify({ domain: "acme.com", icon: "monogram", since: T0 }) },
      [],
    );
    expect(org.attributes.published_as).toMatchObject({
      kind: "ORGANIZATION", domain: "acme.com", icon: "monogram", since: new Date(T0).toISOString(),
    });

    const personal = serializeBenchmark(
      { ...priv, published_as_kind: "PERSONAL", attribution_snapshot: JSON.stringify({ display_name: "Ada", email_sha256: "a".repeat(64), since: T0 }) },
      [],
    );
    expect(personal.attributes.published_as).toMatchObject({
      kind: "PERSONAL", display_name: "Ada", since: new Date(T0).toISOString(),
    });

    // A pre-`since` snapshot simply omits it — no crash, no null field.
    const legacy = serializeBenchmark(
      { ...priv, published_as_kind: "ORGANIZATION", attribution_snapshot: JSON.stringify({ domain: "acme.com", icon: "monogram" }) },
      [],
    );
    expect(legacy.attributes.published_as).not.toHaveProperty("since");
  });

  it("null created_by for an API-key-created benchmark", () => {
    expect(serializeBenchmark({ ...priv, created_by_user_id: null }, []).attributes.created_by).toBeNull();
  });

  it("references the subject type by its key, never the internal UUID; null when untyped", () => {
    // The wire reference is subject_type_key (the type's public id), not the raw subject_type UUID.
    expect(serializeBenchmark(priv, []).attributes.subject_type).toBe("cpu");
    expect(
      serializeBenchmark({ ...priv, subject_type: null, subject_type_key: null }, []).attributes.subject_type,
    ).toBeNull();
  });

  it("surfaces category and the caller-supplied tag keys", () => {
    const out = serializeBenchmark(
      { ...priv, category: "HARDWARE" },
      ["gpu", "rendering"],
    );
    expect(out.attributes.category).toBe("HARDWARE");
    expect(out.attributes.tags).toEqual(["gpu", "rendering"]);
  });

  it("substitutes live derived metrics for the stored snapshot when provided", () => {
    // The stored schema carries a STALE derived snapshot; passing liveDerived replaces `.derived`
    // (metrics/chart are preserved) so the console reflects the current library metric definition.
    const row: BenchmarkRowWithPublisher = {
      ...priv,
      measurement_schema: JSON.stringify({
        metrics: [{ name: "latency_ms", type: "DECIMAL" }],
        derived: [{ name: "skew_ms", unit: "ms", expr: { "%": [{ var: "created_at" }, 60000] } }],
        chart: { x: "created_at", y: "skew_ms" },
      }),
    };
    const live = [
      { name: "skew_ms", unit: "s", format: "0.0", description: "seconds past the hour", expr: { "%": [{ var: "created_at" }, 3_600_000] } },
    ];
    const out = serializeBenchmark(row, [], live);
    expect(out.attributes.measurement_schema).toEqual({
      metrics: [{ name: "latency_ms", type: "DECIMAL" }],
      // The formula (`expr`) is an internal detail resolved live from the library metric; it is NOT
      // surfaced — the benchmark resource exposes only the derived metric's name + display fields.
      derived: [{ name: "skew_ms", unit: "s", format: "0.0", description: "seconds past the hour" }],
      chart: { x: "created_at", y: "skew_ms" },
    });
    // The empty-array case also substitutes (a benchmark whose only FORMULA metric was unlinked).
    expect(serializeBenchmark(row, [], []).attributes.measurement_schema).toMatchObject({ derived: [] });
    // With no liveDerived, the stored snapshot is surfaced — still WITHOUT its `expr` (formula).
    expect(serializeBenchmark(row, []).attributes.measurement_schema).toMatchObject({
      derived: [{ name: "skew_ms", unit: "ms" }],
    });
  });

  it("renders a PERSONAL attribution badge from the frozen snapshot", () => {
    const row: BenchmarkRowWithPublisher = {
      ...priv, status: "PUBLISHED", draft: 0, published_at: T0,
      published_by_user_id: "u1", published_as_kind: "PERSONAL",
      attribution_snapshot: JSON.stringify({ display_name: "Ada", email_sha256: "abc123" }),
    };
    const out = serializeBenchmark(row, []);
    expect(out.attributes.draft).toBe(false);
    expect(out.attributes.published_by).toBe("u1");
    expect(out.attributes.published_as).toEqual({
      kind: "PERSONAL", display_name: "Ada", gravatar_hash: "abc123",
    });
  });

  it("renders an ORGANIZATION attribution badge from the frozen verified domain + icon", () => {
    const row: BenchmarkRowWithPublisher = {
      ...priv, about: "long", methodology: "how", status: "WITHDRAWN", draft: 0,
      published_at: T0, withdrawn_at: T0, withdrawal_reason: "bad data",
      measurement_schema: JSON.stringify({ metrics: [], derived: [] }),
      published_by_user_id: "admin1", published_as_kind: "ORGANIZATION", published_identity_id: "pub1",
      attribution_snapshot: JSON.stringify({ domain: "acme.com", icon: "favicon" }),
    };
    const out = serializeBenchmark(row, []);
    expect(out.attributes.status).toBe("WITHDRAWN");
    expect(out.attributes.withdrawal_reason).toBe("bad data");
    expect(out.attributes.measurement_schema).toEqual({ metrics: [], derived: [] });
    expect(out.attributes.published_by).toBe("admin1");
    expect(out.attributes.published_as).toEqual({ kind: "ORGANIZATION", domain: "acme.com", icon: "favicon" });
  });

  it("renders an INGESTED attribution badge with source provenance and an ISO retrieved_at", () => {
    const row: BenchmarkRowWithPublisher = {
      ...priv, status: "PUBLISHED", draft: 0, published_at: T0, category: "HARDWARE",
      published_by_user_id: null, published_as_kind: "INGESTED",
      attribution_snapshot: JSON.stringify({
        source_name: "Blender Open Data",
        source_url: "https://opendata.blender.org",
        license: "CC0",
        retrieved_at: T0,
      }),
    };
    const out = serializeBenchmark(row, ["rendering"]);
    expect(out.attributes.published_by).toBeNull();
    expect(out.attributes.published_as).toEqual({
      kind: "INGESTED",
      source_name: "Blender Open Data",
      source_url: "https://opendata.blender.org",
      license: "CC0",
      retrieved_at: ISO0,
    });
  });

  it("surfaces the declared license: top-level always, in the badge for PERSONAL/ORGANIZATION; the INGESTED snapshot wins", () => {
    expect(serializeBenchmark(priv, []).attributes.license).toBeNull();
    const lic = { ...priv, license: "CC-BY-4.0" };
    expect(serializeBenchmark(lic, []).attributes.license).toBe("CC-BY-4.0");

    const personalSnap = JSON.stringify({ display_name: "Ada", email_sha256: "h" });
    const personal = serializeBenchmark({ ...lic, published_as_kind: "PERSONAL", attribution_snapshot: personalSnap }, []);
    expect((personal.attributes.published_as as Record<string, unknown>).license).toBe("CC-BY-4.0");

    const org = serializeBenchmark(
      { ...lic, published_as_kind: "ORGANIZATION", attribution_snapshot: JSON.stringify({ domain: "acme.com", icon: "monogram" }) },
      [],
    );
    expect((org.attributes.published_as as Record<string, unknown>).license).toBe("CC-BY-4.0");

    // Undeclared → the badge omits the field rather than carrying null.
    const bare = serializeBenchmark({ ...priv, published_as_kind: "PERSONAL", attribution_snapshot: personalSnap }, []);
    expect(bare.attributes.published_as).not.toHaveProperty("license");

    // INGESTED: the snapshot's source license describes the original data's terms — it wins over a
    // declared row license.
    const ingested = serializeBenchmark(
      {
        ...lic,
        published_as_kind: "INGESTED",
        attribution_snapshot: JSON.stringify({ source_name: "S", source_url: "https://s", license: "CC0", retrieved_at: T0 }),
      },
      [],
    );
    expect((ingested.attributes.published_as as Record<string, unknown>).license).toBe("CC0");
  });
});

describe("serializePublisher", () => {
  const base: PublisherRow = {
    id: "pub1", account_id: "a1", domain: "microsoft.com",
    verification_token: "smplmark-verify=xyz", status: "PENDING",
    verified_at: null, last_checked_at: null, icon: "monogram", created_at: T0,
  };
  it("surfaces the DNS token, icon, and computes `verified`; nulls when never checked", () => {
    expect(serializePublisher(base)).toEqual({
      type: "publisher",
      id: "pub1",
      attributes: {
        account: "a1", domain: "microsoft.com",
        status: "PENDING", verification_token: "smplmark-verify=xyz", verified: false,
        verified_at: null, last_checked_at: null, icon: "monogram", created_at: ISO0,
      },
    });
  });
  it("marks a VERIFIED publisher verified and maps its timestamps", () => {
    const out = serializePublisher({ ...base, status: "VERIFIED", verified_at: T0, last_checked_at: T0, icon: "favicon" });
    expect(out.attributes.verified).toBe(true);
    expect(out.attributes.verified_at).toBe(ISO0);
    expect(out.attributes.icon).toBe("favicon");
  });
  it("a LAPSED publisher is not verified but keeps its last verified_at", () => {
    const out = serializePublisher({ ...base, status: "LAPSED", verified_at: T0, last_checked_at: T0 });
    expect(out.attributes.verified).toBe(false);
    expect(out.attributes.status).toBe("LAPSED");
  });
});

describe("serializeSubject", () => {
  const row: SubjectRow & { subject_type_key: string | null } = {
    id: "t1", account_id: "a1", subject_type_id: "st1", subject_type_key: "server", key: "sched-a", name: "Scheduler A",
    details: JSON.stringify({ region: "us-east-1" }),
    created_at: T0, updated_at: T0,
  };
  it("maps account + subject_type (by key, not the internal UUID) and parses details; null details → null", () => {
    expect(serializeSubject(row).attributes.account).toBe("a1");
    // The subject_type ref is the type's key (its public id), never the internal subject_type_id UUID.
    expect(serializeSubject(row).attributes.subject_type).toBe("server");
    expect(serializeSubject(row).attributes.details).toEqual({ region: "us-east-1" });
    expect(serializeSubject({ ...row, details: null }).attributes.details).toBeNull();
  });

  it("passes a null subject_type_key through (an untyped subject)", () => {
    expect(serializeSubject({ ...row, subject_type_key: null }).attributes.subject_type).toBeNull();
  });

  it("uses the subject's key as its public id (the internal UUID is never surfaced)", () => {
    const out = serializeSubject(row);
    expect(out.id).toBe("sched-a");
    expect(out.id).toBe(row.key);
    expect(out.attributes.key).toBe("sched-a"); // the key attribute is retained; it equals the id
  });
});

describe("serializeSubjectType", () => {
  const row: SubjectTypeRow = {
    id: "st-uuid-1", account_id: "a1", key: "server", name: "Server",
    fields: JSON.stringify([{ name: "region", label: "Region", type: "STRING", required: false }]),
    created_at: T0, updated_at: T0,
  };
  it("uses the subject type's key as its public id (the internal UUID is never surfaced)", () => {
    const out = serializeSubjectType(row);
    expect(out.id).toBe("server");
    expect(out.id).toBe(row.key);
    expect(out.attributes.key).toBe("server"); // the key attribute is retained; it equals the id
    expect(out.attributes.account).toBe("a1");
  });
});

describe("serializeRun", () => {
  const base: RunRow = {
    id: "r1", benchmark_id: "b1", key: "default", name: null, details: null,
    started_at: null, ended_at: null, invalidated_at: null, invalidation_reason: null,
    invalidated_by_user_id: null, created_at: T0, updated_at: T0,
  };
  it("uses the run's key as its public id (never the internal UUID)", () => {
    const out = serializeRun(base);
    expect(out.id).toBe("default");
    expect(out.id).toBe(base.key);
    expect(out.attributes.key).toBe("default"); // the key attribute is retained; it equals the id
    expect(out.attributes.benchmark).toBe("b1"); // the benchmark ref stays a UUID (a later slice)
  });

  it("computes live/invalidated and maps timestamps", () => {
    const live = serializeRun(base);
    expect(live.attributes.benchmark).toBe("b1");
    expect(live.attributes.live).toBe(true);
    expect(live.attributes.invalidated).toBe(false);

    const ended = serializeRun({
      ...base, started_at: T0, ended_at: T0, invalidated_at: T0,
      invalidation_reason: "oops", invalidated_by_user_id: "u1",
    });
    expect(ended.attributes.live).toBe(false);
    expect(ended.attributes.invalidated).toBe(true);
    expect(ended.attributes.started_at).toBe(ISO0);
    expect(ended.attributes.invalidated_by_user).toBe("u1");
  });
});

describe("serializeMeasurement", () => {
  const schema: MeasurementSchema = {
    metrics: [],
    derived: [{ name: "skew_ms", expr: { minute_offset_ms: [{ var: "created_at" }] } }],
  };
  const ctx: DerivedContext = { created_at: T0 + 87, run: { started_at: null, ended_at: null } };
  const base: Pick<MeasurementRow, "id" | "run_id" | "subject_id" | "created_at" | "metrics" | "meta"> & {
    subject_key: string;
    run_key: string;
  } = {
    id: 48213, run_id: "r1", subject_id: "tg1", subject_key: "sched-a", run_key: "default", created_at: T0 + 87, metrics: null, meta: null,
  };

  it("computes derived metrics, stringifies id, emits the run and subject by their keys (not UUIDs)", () => {
    const out = serializeMeasurement(base, schema, ctx);
    expect(out.id).toBe("48213");
    expect(out.attributes).toEqual({
      created_at: "2026-07-01T09:00:00.087Z", run: "default", subject: "sched-a", metrics: { skew_ms: 87 },
    });
  });

  it("includes meta when non-empty; omits it when null/empty/array", () => {
    expect(
      serializeMeasurement({ ...base, meta: JSON.stringify({ commit: "a1b2" }) }, schema, ctx)
        .attributes.meta,
    ).toEqual({ commit: "a1b2" });
    expect(serializeMeasurement(base, schema, ctx).attributes).not.toHaveProperty("meta");
    expect(serializeMeasurement({ ...base, meta: "{}" }, schema, ctx).attributes).not.toHaveProperty("meta");
    expect(serializeMeasurement({ ...base, meta: "[1,2]" }, schema, ctx).attributes).not.toHaveProperty("meta");
  });

  it("omits metrics for a bare measurement under an empty schema", () => {
    const out = serializeMeasurement(base, { metrics: [], derived: [] }, ctx);
    expect(out.attributes).not.toHaveProperty("metrics");
  });
});

describe("publisherLabel", () => {
  const priv: BenchmarkRowWithPublisher = {
    id: "b1", account_id: "a1", publisher_slug: "acme", key: "sched", name: "Sched",
    description: null, about: null, methodology: null, license: null,
    subject_type: null, subject_type_key: null, status: "PRIVATE",
    published_at: null, withdrawn_at: null, withdrawal_reason: null,
    measurement_schema: "{}",
    created_by_user_id: "u1", draft: 1,
    published_by_user_id: null, published_as_kind: null, published_identity_id: null,
    attribution_snapshot: null, category: "OTHER",
    search_text: "", views_total: 0, closed_at: null,
    created_at: T0, updated_at: T0,
  };

  it("uses the verified domain for an ORGANIZATION publish", () => {
    const row = {
      ...priv, status: "PUBLISHED" as const, published_as_kind: "ORGANIZATION" as const,
      attribution_snapshot: JSON.stringify({ domain: "acme.com", icon: "monogram" }),
    };
    expect(publisherLabel(row)).toBe("acme.com");
  });

  it("uses the source name for an INGESTED publish", () => {
    const row = {
      ...priv, status: "PUBLISHED" as const, published_as_kind: "INGESTED" as const,
      attribution_snapshot: JSON.stringify({
        source_name: "Blender Open Data", source_url: "https://x", license: "CC0", retrieved_at: T0,
      }),
    };
    expect(publisherLabel(row)).toBe("Blender Open Data");
  });

  it("uses the personal display name, falling back to the account slug when unset", () => {
    const row = {
      ...priv, status: "PUBLISHED" as const, published_as_kind: "PERSONAL" as const,
      attribution_snapshot: JSON.stringify({ display_name: "Ada", email_sha256: "h" }),
    };
    expect(publisherLabel(row)).toBe("Ada");
    expect(
      publisherLabel({ ...row, attribution_snapshot: JSON.stringify({ display_name: null, email_sha256: "h" }) }),
    ).toBe("acme");
  });

  it("falls back to the account slug for an unpublished row", () => {
    expect(publisherLabel(priv)).toBe("acme");
  });
});

describe("serializeHistoryEvent", () => {
  const ev = {
    id: "ev1",
    event_type: "benchmark.edited",
    resource_type: "benchmark",
    resource_id: "b1",
    occurred_at: ISO0,
    description: "Benchmark edited.",
    actor_type: "USER",
    actor_id: "u1",
    actor_label: "ada@acme.com",
    visibility: "public" as const,
    benchmark_id: "b1",
    changes: { name: { before: "Old", after: "New" } },
    semantic_core: false,
  };

  it("surfaces the real actor and changes on the account (unredacted) view", () => {
    const out = serializeHistoryEvent(ev, null);
    expect(out.type).toBe("history_event");
    expect(out.id).toBe("ev1");
    expect(out.attributes).toEqual({
      event_type: "benchmark.edited",
      resource_type: "benchmark",
      resource_id: "b1",
      benchmark: "b1",
      occurred_at: ISO0,
      description: "Benchmark edited.",
      actor: { type: "USER", id: "u1", label: "ada@acme.com" },
      changes: { name: { before: "Old", after: "New" } },
      semantic_core: false,
      visibility: "public",
    });
  });

  it("collapses the actor to the publisher identity on the redacted (public) view", () => {
    const out = serializeHistoryEvent(ev, { publisher_label: "acme.com" });
    expect(out.attributes.actor).toEqual({ type: "PUBLISHER", id: null, label: "acme.com" });
    // Everything else still renders — the public view hides who, never what.
    expect(out.attributes.changes).toEqual(ev.changes);
  });

  it("passes through null description/changes and the semantic-core flag", () => {
    const out = serializeHistoryEvent(
      { ...ev, description: null, changes: null, semantic_core: true, actor_type: null, actor_id: null, actor_label: null, benchmark_id: null },
      null,
    );
    expect(out.attributes.description).toBeNull();
    expect(out.attributes.changes).toBeNull();
    expect(out.attributes.benchmark).toBeNull();
    expect(out.attributes.semantic_core).toBe(true);
    expect(out.attributes.actor).toEqual({ type: null, id: null, label: null });
  });
});

describe("serializeTakedownRequest", () => {
  it("echoes the filed request with an ISO created_at", () => {
    const out = serializeTakedownRequest({
      id: "tr1", benchmark_id: "b1", requester_name: "Ada", requester_email: "ada@x.com",
      reason: "contains personal data", status: "OPEN", created_at: T0,
    });
    expect(out).toEqual({
      type: "takedown_request",
      id: "tr1",
      attributes: {
        benchmark: "b1", requester_name: "Ada", requester_email: "ada@x.com",
        reason: "contains personal data", status: "OPEN", created_at: ISO0,
      },
    });
  });
});
