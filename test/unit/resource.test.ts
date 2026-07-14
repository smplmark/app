import { describe, expect, it } from "vitest";
import type { DerivedContext } from "../../src/logic/derived";
import {
  serializeAccount,
  serializeAccountMembership,
  serializeAccountUser,
  serializeApiKey,
  serializeBenchmark,
  serializeInvitation,
  serializeMeasurement,
  serializePublisher,
  serializeRun,
  serializeSubject,
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
    description: null, about: null, methodology: null, status: "PRIVATE",
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

  it("null created_by for an API-key-created benchmark", () => {
    expect(serializeBenchmark({ ...priv, created_by_user_id: null }, []).attributes.created_by).toBeNull();
  });

  it("surfaces category and the caller-supplied tag keys", () => {
    const out = serializeBenchmark(
      { ...priv, category: "HARDWARE" },
      ["gpu", "rendering"],
    );
    expect(out.attributes.category).toBe("HARDWARE");
    expect(out.attributes.tags).toEqual(["gpu", "rendering"]);
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
  const row: SubjectRow = {
    id: "t1", account_id: "a1", subject_type_id: "st1", key: "sched-a", name: "Scheduler A",
    details: JSON.stringify({ region: "us-east-1" }),
    created_at: T0, updated_at: T0,
  };
  it("maps account + subject_type and parses details; null details → null", () => {
    expect(serializeSubject(row).attributes.account).toBe("a1");
    expect(serializeSubject(row).attributes.subject_type).toBe("st1");
    expect(serializeSubject(row).attributes.details).toEqual({ region: "us-east-1" });
    expect(serializeSubject({ ...row, details: null }).attributes.details).toBeNull();
  });
});

describe("serializeRun", () => {
  const base: RunRow = {
    id: "r1", benchmark_id: "b1", key: "default", name: null, details: null,
    started_at: null, ended_at: null, invalidated_at: null, invalidation_reason: null,
    invalidated_by_user_id: null, created_at: T0, updated_at: T0,
  };
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
  const base: Pick<MeasurementRow, "id" | "run_id" | "subject_id" | "created_at" | "metrics" | "meta"> = {
    id: 48213, run_id: "r1", subject_id: "tg1", created_at: T0 + 87, metrics: null, meta: null,
  };

  it("computes derived metrics, stringifies id", () => {
    const out = serializeMeasurement(base, schema, ctx);
    expect(out.id).toBe("48213");
    expect(out.attributes).toEqual({
      created_at: "2026-07-01T09:00:00.087Z", run: "r1", subject: "tg1", metrics: { skew_ms: 87 },
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
