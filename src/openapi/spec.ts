// Generates the smplmark OpenAPI 3.0.3 document from zod schemas via @asteasolutions/zod-to-openapi.
//
// The document is BUILT from a registry — schemas and paths are generated, never hand-authored — so
// the wire contract stays in one place and mirrors src/serialize/resource.ts exactly. Every field
// carries a customer-facing description (ADR-014): no storage-mechanic language, no internal keys.
//
// Naming (per entity): {Entity} is the clean attributes object; {Entity}Resource wraps it with
// { id, type, attributes }; {Entity}Response is { data: Resource }; {Entity}ListResponse is
// { data: Resource[], meta }; {Entity}Request is the POST/PUT body { data: { type, attributes } }.
//
// Pure: no top-level await, no network, no filesystem. buildOpenApiDocument(origin) returns the full
// document object for a route to `c.json(...)`.

import {
  OpenAPIRegistry,
  OpenApiGeneratorV3,
  extendZodWithOpenApi,
} from "@asteasolutions/zod-to-openapi";
import { z } from "zod";

extendZodWithOpenApi(z);

const registry = new OpenAPIRegistry();

// ── Reusable primitives ──────────────────────────────────────────────────────

/** ISO-8601 date-time string on the wire. */
const dateTime = (description: string) =>
  z.string().datetime().openapi({ description, format: "date-time" });

/** A bare id reference to another resource (no `_id` suffix, no relationships object). */
const idRef = (description: string) => z.string().openapi({ description });

/** An opaque JSON object supplied and returned as-is. */
const jsonObject = (description: string) =>
  z.record(z.unknown()).openapi({ description, type: "object" });

// ── Shared error envelope (400/401/403/404/409) ──────────────────────────────

const ErrorObject = z
  .object({
    status: z
      .string()
      .openapi({ description: "The HTTP status code as a string, e.g. \"404\"." }),
    title: z
      .string()
      .openapi({ description: "A short, human-readable summary of the problem." }),
    detail: z
      .string()
      .optional()
      .openapi({ description: "A human-readable explanation specific to this occurrence." }),
    source: z
      .object({
        pointer: z.string().openapi({
          description: "A JSON Pointer to the request field that caused the error.",
        }),
      })
      .optional()
      .openapi({ description: "Locates the part of the request that caused the error." }),
  })
  .openapi("ErrorObject");

const ErrorResponse = registry.register(
  "ErrorResponse",
  z
    .object({
      errors: z
        .array(ErrorObject)
        .openapi({ description: "One or more errors that occurred while processing the request." }),
    })
    .openapi({ description: "A JSON:API error document." }),
);

const errorJson = (description: string) => ({
  description,
  content: { "application/vnd.api+json": { schema: ErrorResponse } },
});

/** The 4xx bundle attached to most domain endpoints. */
const commonErrors = {
  "400": errorJson("The request was malformed."),
  "401": errorJson("Authentication credentials are missing, invalid, expired, or revoked."),
  "403": errorJson("The credential is not permitted to perform this action."),
  "404": errorJson("The requested resource was not found."),
};

// ── Pagination meta (list responses) ─────────────────────────────────────────

const PaginationMeta = z
  .object({
    pagination: z
      .object({
        page: z.number().int().openapi({ description: "The 1-based page number returned." }),
        size: z.number().int().openapi({ description: "The number of items per page." }),
        total: z
          .number()
          .int()
          .optional()
          .openapi({ description: "Total matching items. Present only when a total count was requested." }),
        total_pages: z
          .number()
          .int()
          .optional()
          .openapi({ description: "Total number of pages. Present only when a total count was requested." }),
      })
      .openapi({ description: "Pagination details for the returned page." }),
  })
  .openapi("PaginationMeta");

// ── Envelope helpers (the four schemas per entity) ───────────────────────────

/**
 * Registers the JSON:API envelope family for an entity. `attributes` is the clean singular
 * attributes object; `typeName` is the SINGULAR snake_case resource type; `entity` is the
 * PascalCase schema-name prefix. Returns the registered response/list-response/request schemas so
 * routes can reference them.
 */
function registerEntity(
  entity: string,
  typeName: string,
  attributes: z.ZodTypeAny,
  requestAttributes: z.ZodTypeAny,
) {
  const Attributes = registry.register(entity, attributes);

  const Resource = registry.register(
    `${entity}Resource`,
    z
      .object({
        id: z.string().openapi({ description: `The unique identifier of the ${typeName}.` }),
        type: z.literal(typeName).openapi({ description: `Always \"${typeName}\".` }),
        attributes: Attributes,
      })
      .openapi({ description: `A single ${typeName} resource object.` }),
  );

  const Response = registry.register(
    `${entity}Response`,
    z
      .object({ data: Resource })
      .openapi({ description: `A response wrapping a single ${typeName}.` }),
  );

  const ListResponse = registry.register(
    `${entity}ListResponse`,
    z
      .object({
        data: z
          .array(Resource)
          .openapi({ description: `The page of ${typeName} resources.` }),
        meta: PaginationMeta,
      })
      .openapi({ description: `A paginated collection of ${typeName} resources.` }),
  );

  const Request = registry.register(
    `${entity}Request`,
    z
      .object({
        data: z
          .object({
            type: z.literal(typeName).openapi({ description: `Always \"${typeName}\".` }),
            attributes: requestAttributes,
          })
          .openapi({ description: `The ${typeName} to create or update.` }),
      })
      .openapi({ description: `A request body carrying a ${typeName}.` }),
  );

  return { Attributes, Resource, Response, ListResponse, Request };
}

// ── measurement_schema (nested value object on benchmark) ─────────────────────────

const X_KINDS = ["TIME", "NUMBER", "CATEGORY"] as const;

const MetricDecl = z
  .object({
    name: z.string().openapi({ description: "The metric's identifier, used as its key in measurement payloads." }),
    type: z.string().openapi({ description: "The value type of the metric, e.g. \"number\"." }),
    unit: z.string().optional().openapi({ description: "A display unit for the metric, e.g. \"ms\" or \"tokens\"." }),
    description: z.string().optional().openapi({ description: "A human-readable explanation of what the metric measures." }),
  })
  .openapi("MetricDecl", { description: "A metric a client supplies directly on each measurement." });

const DerivedDecl = z
  .object({
    name: z.string().openapi({ description: "The derived metric's identifier, as it appears in the computed metrics map." }),
    expr: jsonObject(
      "A JSON Logic expression evaluated on read against the measurement and its run context (e.g. elapsed_ms = created_at − run.started_at).",
    ),
    unit: z.string().optional().openapi({ description: "A display unit for the derived value, e.g. \"ms\"." }),
    description: z.string().optional().openapi({ description: "A human-readable explanation of what the derived value represents." }),
  })
  .openapi("DerivedDecl", { description: "A metric computed when an measurement is read, from other metrics and run context." });

const ChartDecl = z
  .object({
    x: z.string().nullable().openapi({ description: "The metric to plot on the x-axis, or null for a scalar (no x-axis)." }),
    y: z.string().openapi({ description: "The metric to plot on the y-axis." }),
    x_kind: z
      .enum(X_KINDS)
      .optional()
      .openapi({ description: "How to interpret the x-axis: TIME, NUMBER, or CATEGORY." }),
  })
  .openapi("ChartDecl", { description: "The default chart the benchmark page renders. Visitors may override it." });

const MeasurementSchema = registry.register(
  "MeasurementSchema",
  z
    .object({
      metrics: z.array(MetricDecl).openapi({ description: "The metrics clients supply on each measurement." }),
      derived: z.array(DerivedDecl).openapi({ description: "Metrics computed on read from stored metrics and run context." }),
      chart: ChartDecl.optional(),
    })
    .openapi({
      description:
        "The shape of the benchmark's measurements. Stored and derived metrics are merged into one map; the derived values are computed when the measurement is read.",
    }),
);

// ── Entities ─────────────────────────────────────────────────────────────────

const user = registerEntity(
  "User",
  "user",
  z.object({
    email: z.string().openapi({ description: "The user's email address." }),
    verified: z.boolean().openapi({ description: "Whether the user's email address has been confirmed." }),
    display_name: z.string().nullable().openapi({ description: "The user's chosen display name, or null if unset." }),
    created_at: dateTime("When the user was created."),
  }),
  z.object({
    display_name: z.string().openapi({ description: "The display name to set for the current user." }),
  }),
);

const UserSettings = registry.register(
  "UserSettings",
  z.record(z.unknown()).openapi({
    type: "object",
    description:
      "The current user's personal preferences for this account — for example the console theme. An opaque object whose keys and values are defined by the client and stored unchanged; empty when nothing has been saved.",
  }),
);

const account = registerEntity(
  "Account",
  "account",
  z.object({
    key: z.string().openapi({ description: "The account's human-readable, URL-safe identifier." }),
    name: z.string().openapi({ description: "The account's display name." }),
    description: z.string().nullable().openapi({ description: "A short description of the account, or null." }),
    allow_personal_publish: z.boolean().openapi({ description: "Whether members may publish their own benchmarks under their personal identity without an admin. When false, publishing is routed through an admin." }),
    created_at: dateTime("When the account was created."),
  }),
  z.object({
    name: z.string().openapi({ description: "The account's display name." }),
    description: z.string().nullable().openapi({ description: "A short description of the account." }),
    allow_personal_publish: z.boolean().optional().openapi({ description: "Whether members may publish their own benchmarks under their personal identity. Omit to leave the current setting unchanged." }),
  }),
);

const ROLE_VALUES = ["OWNER", "ADMIN", "MEMBER", "VIEWER"] as const;
const INVITABLE_ROLE_VALUES = ["ADMIN", "MEMBER", "VIEWER"] as const;

const accountUser = registerEntity(
  "AccountUser",
  "account_user",
  z.object({
    account: idRef("The account this membership belongs to."),
    user: idRef("The member user."),
    role: z
      .enum(ROLE_VALUES)
      .openapi({ description: "The member's role: VIEWER (read-only), MEMBER (edit benchmarks), ADMIN (manage members, keys, settings), or OWNER (the account creator)." }),
    email: z.string().optional().openapi({ description: "The member's email address (present in the members list)." }),
    display_name: z.string().nullable().optional().openapi({ description: "The member's display name, or null." }),
    verified: z.boolean().optional().openapi({ description: "Whether the member's email is confirmed." }),
    created_at: dateTime("When the membership was created."),
  }),
  z.object({
    role: z
      .enum(INVITABLE_ROLE_VALUES)
      .openapi({ description: "The role to assign the member. The owner's role is immutable and cannot be set here." }),
  }),
);

const accountMembership = registerEntity(
  "AccountMembership",
  "account_membership",
  z.object({
    account: idRef("The account id."),
    key: z.string().openapi({ description: "The account's URL-safe key." }),
    name: z.string().openapi({ description: "The account's display name." }),
    role: z.enum(ROLE_VALUES).openapi({ description: "The caller's role in this account." }),
    created_at: dateTime("When the caller joined the account."),
  }),
  z.object({}),
);

const invitation = registerEntity(
  "Invitation",
  "invitation",
  z.object({
    account: idRef("The account the invitee is being added to."),
    email: z.string().openapi({ description: "The invited email address." }),
    role: z.enum(INVITABLE_ROLE_VALUES).openapi({ description: "The role the invitee receives on acceptance." }),
    status: z
      .enum(["PENDING", "ACCEPTED", "REVOKED", "EXPIRED"])
      .openapi({ description: "The invitation's lifecycle state." }),
    invited_by_user: z.string().nullable().openapi({ description: "The user who sent the invitation, or null." }),
    expires_at: dateTime("When the invitation expires."),
    accepted_at: dateTime("When the invitation was accepted, or null.").nullable(),
    created_at: dateTime("When the invitation was created."),
    token: z
      .string()
      .optional()
      .openapi({ description: "The invitation token. Returned only when the invitation is created or resent." }),
  }),
  z.object({
    email: z.string().openapi({ description: "The email address to invite." }),
    role: z.enum(INVITABLE_ROLE_VALUES).openapi({ description: "The role the invitee will receive." }),
  }),
);

const AcceptInvitationRequest = registry.register(
  "AcceptInvitationRequest",
  z
    .object({ token: z.string().openapi({ description: "The invitation token from the emailed link." }) })
    .openapi({ description: "A request to accept an invitation." }),
);

const contactEmail = registerEntity(
  "Email",
  "email",
  z.object({
    topic: z.string().openapi({ description: "The message topic." }),
    sent_at: dateTime("When the message was sent."),
  }),
  z.object({
    topic: z
      .enum(["technical", "account", "feature_request", "other"])
      .optional()
      .openapi({ description: "The message topic. Defaults to \"other\"." }),
    body: z.string().openapi({ description: "The message body (max 10,000 characters)." }),
  }),
);

const apiKey = registerEntity(
  "ApiKey",
  "api_key",
  z.object({
    account: idRef("The account this key belongs to."),
    name: z.string().openapi({ description: "A human-readable label for the key." }),
    scope_type: z
      .enum(["ACCOUNT", "BENCHMARK", "RUN"])
      .openapi({ description: "The breadth of access the key grants: the whole account, a single benchmark, or a single run." }),
    scope_ref: z.string().nullable().openapi({ description: "The id of the benchmark or run the key is scoped to, or null for ACCOUNT scope." }),
    prefix: z.string().openapi({ description: "The first few characters of the key, safe to display for identification." }),
    expires_at: dateTime("When the key expires, or null if it never expires.").nullable(),
    last_used_at: dateTime("When the key was last used to authenticate, or null if never used.").nullable(),
    revoked: z.boolean().openapi({ description: "Whether the key has been revoked." }),
    created_by_user: z.string().nullable().openapi({ description: "The user who created the key, or null if created by another key." }),
    created_at: dateTime("When the key was created."),
    key: z
      .string()
      .optional()
      .openapi({ description: "The API key value. Returned only when the key is created or explicitly revealed." }),
  }),
  z.object({
    name: z.string().openapi({ description: "A human-readable label for the key." }),
    scope_type: z
      .enum(["ACCOUNT", "BENCHMARK", "RUN"])
      .openapi({ description: "The breadth of access to grant." }),
    scope_ref: z.string().optional().openapi({ description: "The id of the benchmark or run to scope the key to. Required unless scope_type is ACCOUNT." }),
    expires_at: dateTime("When the key should expire. Omit for a non-expiring key.").optional(),
  }),
);

const PublishedAs = z
  .object({
    kind: z
      .enum(["PERSONAL", "ORGANIZATION", "INGESTED"])
      .openapi({ description: "How the benchmark is attributed: PERSONAL (its author), ORGANIZATION (a verified publisher domain), or INGESTED (openly licensed results imported from a third-party source)." }),
    domain: z.string().optional().openapi({ description: "The verified publisher domain the benchmark was published under (ORGANIZATION only), e.g. \"microsoft.com\"." }),
    icon: z.enum(["monogram", "favicon"]).optional().openapi({ description: "How the publisher's icon is shown (ORGANIZATION only): a domain-initial monogram, or the domain's favicon." }),
    display_name: z.string().nullable().optional().openapi({ description: "The author's display name captured at publish (PERSONAL only), or null." }),
    gravatar_hash: z.string().optional().openapi({ description: "A SHA-256 hash of the author's email captured at publish (PERSONAL only), for rendering an avatar." }),
    source_name: z.string().optional().openapi({ description: "The name of the source the results were ingested from (INGESTED only), e.g. \"Blender Open Data\"." }),
    source_url: z.string().optional().openapi({ description: "A link back to the source's original data (INGESTED only)." }),
    license: z.string().optional().openapi({ description: "The source's license for the ingested results (INGESTED only), e.g. \"CC0\"." }),
    retrieved_at: dateTime("When the ingested data was retrieved from the source (INGESTED only).").optional(),
  })
  .openapi("PublishedAs", {
    description:
      "The attribution badge for a published benchmark, frozen at the moment of publishing. Rendered from this snapshot, never a live lookup, so it is unaffected if a domain later lapses or the identity is deleted.",
  });

const externalSource = registerEntity(
  "ExternalSource",
  "external_source",
  z.object({
    key: z.string().openapi({ description: "Stable identifier of the source, e.g. \"openml\"." }),
    name: z.string().openapi({ description: "The source's display name." }),
    description: z.string().nullable().openapi({ description: "What kinds of benchmark results the source publishes." }),
    url: z.string().openapi({ description: "Link to the source." }),
    license: z.string().nullable().openapi({ description: "The license the source publishes its results under, or null when the source states none." }),
    license_url: z.string().nullable().openapi({ description: "Link to the license statement, or null when there is none to link." }),
    benchmark_count: z.number().int().openapi({ description: "How many published benchmarks on smplmark were ingested from this source." }),
    retrieved_at: dateTime("When data was last retrieved from the source."),
  }),
  z.object({}),
);

const benchmark = registerEntity(
  "Benchmark",
  "benchmark",
  z.object({
    account: idRef("The account that owns the benchmark."),
    publisher_slug: z.string().openapi({ description: "The owning account's URL-safe key. Together with the benchmark's own key it forms the benchmark's public path, /{publisher_slug}/{key}." }),
    key: z.string().openapi({ description: "The benchmark's human-readable, URL-safe identifier, unique within its account." }),
    name: z.string().openapi({ description: "The benchmark's display name." }),
    description: z.string().nullable().openapi({ description: "A one-line summary of the benchmark, or null." }),
    about: z.string().nullable().openapi({ description: "A longer description of the benchmark, or null." }),
    methodology: z.string().nullable().openapi({ description: "How the benchmark is run and measured, or null." }),
    status: z
      .enum(["PRIVATE", "PUBLISHED", "WITHDRAWN"])
      .openapi({ description: "The benchmark's lifecycle state. PRIVATE benchmarks are visible only to the account; PUBLISHED benchmarks are public; WITHDRAWN benchmarks are no longer public." }),
    draft: z.boolean().openapi({ description: "Whether the benchmark is still a draft. A draft is fully editable; when marked ready (draft false) its data is locked until it is published or returned to draft. A benchmark cannot be published while it is a draft." }),
    created_by: z.string().nullable().openapi({ description: "The user who created the benchmark, or null if it was created by an API key." }),
    published_by: z.string().nullable().optional().openapi({ description: "The user who published the benchmark. Present only once published." }),
    published_as: PublishedAs.optional(),
    published_at: dateTime("When the benchmark was published, or null if it has not been published.").nullable(),
    withdrawn_at: dateTime("When the benchmark was withdrawn, or null.").nullable(),
    withdrawal_reason: z.string().nullable().openapi({ description: "The stated reason the benchmark was withdrawn, or null." }),
    measurement_schema: MeasurementSchema,
    category: z
      .enum(["HARDWARE", "DATABASE", "ML_AI", "STORAGE", "NETWORK", "OTHER"])
      .openapi({ description: "The benchmark's coarse browse category. Exactly one per benchmark; tags carry finer-grained classification." }),
    tags: z
      .array(z.string())
      .openapi({ description: "The benchmark's tags: lowercase slugs, sorted alphabetically." }),
    views: z
      .number()
      .int()
      .openapi({ description: "All-time page-view count for the benchmark. A raw, best-effort popularity signal — not an audited metric." }),
    closed: z.boolean().openapi({ description: "Whether the publisher has marked the benchmark complete. A closed benchmark accepts no new subjects, runs, or measurements; existing data stays public. Reversible." }),
    closed_at: dateTime("When the benchmark was closed, or null while open.").nullable(),
    created_at: dateTime("When the benchmark was created."),
    updated_at: dateTime("When the benchmark was last updated."),
  }),
  z.object({
    key: z.string().max(100).optional().openapi({ description: "The benchmark's human-readable, URL-safe identifier, unique within your account. At most 100 characters. Auto-generated from the name if omitted." }),
    name: z.string().max(200).openapi({ description: "The benchmark's display name. At most 200 characters." }),
    description: z.string().max(500).optional().openapi({ description: "A one-line summary of the benchmark. At most 500 characters." }),
    about: z.string().max(20000).optional().openapi({ description: "A longer description of the benchmark. At most 20,000 characters." }),
    methodology: z.string().max(20000).optional().openapi({ description: "How the benchmark is run and measured. At most 20,000 characters." }),
    measurement_schema: MeasurementSchema.optional(),
    category: z
      .enum(["HARDWARE", "DATABASE", "ML_AI", "STORAGE", "NETWORK", "OTHER"])
      .optional()
      .openapi({ description: "The benchmark's coarse browse category. Defaults to OTHER when omitted." }),
    tags: z
      .array(z.string())
      .optional()
      .openapi({ description: "The benchmark's tags: up to 20 lowercase slugs (letters, digits, \".\", \"_\", \"-\"; at most 40 characters each). Replaced as a set on update; omitting the field clears them." }),
  }),
);

const subject = registerEntity(
  "Subject",
  "subject",
  z.object({
    account: idRef("The account that owns the subject."),
    subject_type: idRef("The subject type this subject conforms to."),
    key: z.string().openapi({ description: "The subject's human-readable identifier, unique within its account." }),
    name: z.string().openapi({ description: "The subject's display name." }),
    details: z.record(z.unknown()).nullable().openapi({ description: "The subject's field values, keyed by field name. Values for fields the subject type defines are validated and normalized against it; any other keys are stored as supplied (the subject type is an open schema).", type: "object" }),
    created_at: dateTime("When the subject was created."),
    updated_at: dateTime("When the subject was last updated."),
  }),
  z.object({
    subject_type: idRef("The id of the subject type this subject conforms to. Required; fixed at creation."),
    key: z.string().max(100).optional().openapi({ description: "The subject's human-readable identifier, unique within your account. At most 100 characters. Auto-generated from the name if omitted." }),
    name: z.string().max(200).openapi({ description: "The subject's display name. At most 200 characters." }),
    details: z.record(z.unknown()).optional().openapi({ description: "The subject's field values, keyed by field name. Keys the subject type defines are validated against it (required fields, value types, string max_length, enum options); any other keys are stored as-is — the subject type is an open schema, so a subject may carry arbitrary extra fields.", type: "object" }),
  }),
);

const subjectFieldType = z.enum(["STRING", "NUMBER", "BOOLEAN", "ENUM", "DATE"]);
const subjectType = registerEntity(
  "SubjectType",
  "subject_type",
  z.object({
    account: idRef("The account that owns the subject type."),
    key: z.string().openapi({ description: "The subject type's identifier, derived from its name (kebab-case) and unique within the account." }),
    name: z.string().openapi({ description: "The subject type's display name." }),
    fields: z
      .array(
        z.object({
          name: z.string().openapi({ description: "The field's identifier — the key it occupies in a subject's `details` object (snake_case: lowercase alphanumerics and underscores, unique within the type)." }),
          label: z.string().openapi({ description: "The field's human-readable display name." }),
          description: z.string().optional().openapi({ description: "An optional longer description of the field." }),
          type: subjectFieldType.openapi({ description: "The field's value type." }),
          required: z.boolean().openapi({ description: "Whether a subject of this type must supply this field." }),
          max_length: z.number().int().optional().openapi({ description: "Maximum length; present only for STRING fields." }),
          options: z.array(z.string()).optional().openapi({ description: "The allowed values; present only for ENUM fields." }),
        }),
      )
      .openapi({ description: "The typed fields that subjects of this type carry." }),
    created_at: dateTime("When the subject type was created."),
    updated_at: dateTime("When the subject type was last updated."),
  }),
  z.object({
    name: z.string().max(200).openapi({ description: "The subject type's display name. Its key is derived from this automatically — do not supply a key. At most 200 characters." }),
    fields: z
      .array(
        z.object({
          label: z.string().openapi({ description: "The field's human-readable display name." }),
          name: z.string().optional().openapi({ description: "The field's identifier — the key it occupies in a subject's `details` object. Normalized to snake_case (lowercase alphanumerics and underscores); derived from `label` when omitted; made unique within the type." }),
          description: z.string().max(500).optional().openapi({ description: "An optional longer description of the field. At most 500 characters." }),
          type: subjectFieldType.openapi({ description: "The field's value type." }),
          required: z.boolean().optional().openapi({ description: "Whether the field is required. Defaults to false." }),
          max_length: z.number().int().optional().openapi({ description: "Maximum length, for a STRING field." }),
          options: z.array(z.string()).optional().openapi({ description: "The allowed values, required for (and only valid on) an ENUM field." }),
        }),
      )
      .optional()
      .openapi({ description: "The fields subjects of this type carry. Omit for a type with no structured fields yet." }),
  }),
);

const metricType = z.enum(["NUMBER", "DURATION_MS", "PERCENT", "COUNT", "BYTES"]);
const metricKind = z.enum(["STORED", "DERIVED"]);
const MetricToken = z
  .object({
    kind: z.enum(["METRIC", "NUMBER", "CREATED_AT", "STEP"]).openapi({ description: "The operand type: `METRIC` — another metric's value; `NUMBER` — a literal number; `CREATED_AT` — the measurement's creation time in epoch milliseconds; `STEP` — the value of an earlier step." }),
    name: z.string().optional().openapi({ description: "The referenced metric's name. Required when `kind` is `METRIC`." }),
    value: z.number().optional().openapi({ description: "The literal number. Required when `kind` is `NUMBER`." }),
    step: z.string().optional().openapi({ description: "The id of an earlier step. Required when `kind` is `STEP`." }),
  })
  .openapi("MetricToken", { description: "One operand in a derived-metric formula step." });

const MetricStep = z
  .object({
    id: z.string().openapi({ description: "The step's identifier (A, B, C…). Later steps reference earlier ones by this id." }),
    kind: z.enum(["OP", "FN"]).openapi({ description: "`OP` — a binary operation `a <op> b`; `FN` — a unary function `fn(a)`." }),
    op: z.enum(["ADD", "SUB", "MUL", "DIV", "MOD"]).optional().openapi({ description: "The binary operator: add, subtract, multiply, divide, or modulo. Required (and only valid) when `kind` is `OP`." }),
    fn: z.enum(["FLOOR", "ROUND", "CEIL", "ABS"]).optional().openapi({ description: "The unary function. Required (and only valid) when `kind` is `FN`." }),
    a: MetricToken.openapi({ description: "The first operand (and the only operand for a function step)." }),
    b: MetricToken.optional().openapi({ description: "The second operand. Required (and only valid) when `kind` is `OP`." }),
  })
  .openapi("MetricStep", { description: "One step in a derived-metric formula — a binary operation or a unary function over operands." });

const MetricFormula = z
  .object({
    steps: z.array(MetricStep).openapi({ description: "The ordered steps (A, B, C…). Each computes a value from metrics, literal numbers, the measurement's creation time, or the values of earlier steps." }),
    result: z.string().openapi({ description: "The id of the step whose value is the metric. Defaults to the last step when omitted." }),
  })
  .openapi("MetricFormula", { description: "A derived-metric formula: an ordered list of lettered steps combined into a result. Compiled to a JSON Logic expression the compute-on-read engine evaluates. For example, a percentage `100 × (a ÷ b)` is step A `a ÷ b` then step B `100 × A`, with result B." });

const metric = registerEntity(
  "Metric",
  "metric",
  z.object({
    account: idRef("The account that owns the metric."),
    name: z.string().openapi({ description: "The metric's identifier — the key it occupies in a measurement's metrics bag (snake_case: lowercase alphanumerics and underscores, unique within the account)." }),
    label: z.string().openapi({ description: "The metric's human-readable display name." }),
    description: z.string().nullable().openapi({ description: "An optional longer description of the metric." }),
    type: metricType.openapi({ description: "The metric's semantic value type." }),
    kind: metricKind.openapi({ description: "STORED — a value clients POST on each measurement; or DERIVED — computed on read from a formula." }),
    formula: MetricFormula.nullable().openapi({ description: "The built-in derived formula (DERIVED metrics only); null for STORED." }),
    expr: z.record(z.unknown()).nullable().openapi({ description: "The JSON Logic the formula compiles to — what the compute-on-read engine evaluates once the metric is attached to a benchmark; null for STORED.", type: "object" }),
    created_at: dateTime("When the metric was created."),
    updated_at: dateTime("When the metric was last updated."),
  }),
  z.object({
    name: z.string().optional().openapi({ description: "The metric's identifier. Normalized to snake_case (lowercase alphanumerics and underscores); derived from `label` when omitted; made unique within the account." }),
    label: z.string().max(200).openapi({ description: "The metric's display name. At most 200 characters." }),
    description: z.string().max(500).optional().openapi({ description: "An optional longer description. At most 500 characters." }),
    type: metricType.openapi({ description: "The metric's semantic value type." }),
    kind: metricKind.optional().openapi({ description: "STORED (the default) or DERIVED." }),
    formula: MetricFormula.optional().openapi({ description: "Required for a DERIVED metric — the built-in formula to compute it." }),
  }),
);

const benchmarkSubject = registerEntity(
  "BenchmarkSubject",
  "benchmark_subject",
  z.object({
    benchmark: idRef("The benchmark the subject is linked to."),
    subject: idRef("The subject linked to the benchmark."),
    created_at: dateTime("When the link was created."),
  }),
  z.object({
    benchmark: idRef("The benchmark to link the subject to."),
    subject: idRef("The subject to link. Must belong to the same account as the benchmark."),
  }),
);

const benchmarkMetric = registerEntity(
  "BenchmarkMetric",
  "benchmark_metric",
  z.object({
    benchmark: idRef("The benchmark the metric is linked to."),
    metric: idRef("The metric linked to the benchmark."),
    created_at: dateTime("When the link was created."),
  }),
  z.object({
    benchmark: idRef("The benchmark to link the metric to."),
    metric: idRef("The metric to link. Must belong to the same account as the benchmark."),
  }),
);

const run = registerEntity(
  "Run",
  "run",
  z.object({
    benchmark: idRef("The benchmark this run belongs to."),
    key: z.string().openapi({ description: "The run's human-readable identifier, unique within its benchmark." }),
    name: z.string().nullable().openapi({ description: "The run's display name, or null." }),
    details: z.record(z.unknown()).nullable().openapi({ description: "Arbitrary structured metadata about the run, or null.", type: "object" }),
    started_at: dateTime("When the run started, or null if not yet started.").nullable(),
    ended_at: dateTime("When the run ended, or null if still live.").nullable(),
    live: z.boolean().openapi({ description: "Whether the run is still accepting measurements." }),
    invalidated: z.boolean().openapi({ description: "Whether the run has been marked invalid and excluded from results." }),
    invalidated_at: dateTime("When the run was invalidated, or null.").nullable(),
    invalidation_reason: z.string().nullable().openapi({ description: "The stated reason the run was invalidated, or null." }),
    invalidated_by_user: z.string().nullable().openapi({ description: "The user who invalidated the run, or null." }),
    created_at: dateTime("When the run was created."),
    updated_at: dateTime("When the run was last updated."),
  }),
  z.object({
    benchmark: idRef("The benchmark to attach the run to."),
    key: z.string().max(100).optional().openapi({ description: "The run's human-readable identifier, unique within its benchmark. At most 100 characters. Auto-generated if omitted." }),
    name: z.string().max(200).optional().openapi({ description: "The run's display name. At most 200 characters." }),
    details: z.record(z.unknown()).optional().openapi({ description: "Arbitrary structured metadata about the run.", type: "object" }),
    started_at: dateTime("When the run started. Defaults to the time of creation.").optional(),
  }),
);

const measurement = registerEntity(
  "Measurement",
  "measurement",
  z.object({
    run: idRef("The run (occasion) this measurement belongs to."),
    subject: idRef("The subject this measurement is of."),
    created_at: dateTime("When the measurement was recorded."),
    metrics: z
      .record(z.number())
      .optional()
      .openapi({
        description:
          "A flat map of metric name to numeric value. Stored and derived metrics are merged into one map; the derived values are computed when the measurement is read.",
        type: "object",
      }),
    meta: jsonObject("Arbitrary structured metadata attached to the measurement.").optional(),
  }),
  z.object({
    run: idRef("The run (occasion) to attach the measurement to."),
    subject: idRef("The subject being measured. Must be linked to the same benchmark as the run."),
    created_at: dateTime("When the measurement occurred. Defaults to the time of ingest.").optional(),
    metrics: z
      .record(z.number())
      .optional()
      .openapi({ description: "A flat map of stored metric name to numeric value.", type: "object" }),
    meta: jsonObject("Arbitrary structured metadata to attach to the measurement.").optional(),
  }),
);

const publisher = registerEntity(
  "Publisher",
  "publisher",
  z.object({
    account: idRef("The account that owns this publisher."),
    domain: z.string().openapi({ description: "The exact registrable domain that IS this publisher, e.g. \"microsoft.com\" (no subdomain inference). A benchmark published under this publisher is attributed to this domain." }),
    status: z
      .enum(["PENDING", "VERIFIED", "LAPSED"])
      .openapi({ description: "The domain's verification state. PENDING awaits a successful check; VERIFIED has proven ownership; LAPSED was verified but the DNS record has since disappeared. Only a VERIFIED publisher can be published under." }),
    verification_token: z.string().openapi({ description: "The TXT record value to add to the domain's DNS to prove ownership. Add a TXT record with this value at either the domain root or the `_smplmark-verify` subdomain (e.g. `_smplmark-verify.example.com`), then run the verify action." }),
    verified: z.boolean().openapi({ description: "Whether the domain is currently verified." }),
    verified_at: dateTime("When the domain was last verified, or null if it has never verified.").nullable(),
    last_checked_at: dateTime("When the domain was last checked, or null if it has never been checked.").nullable(),
    icon: z.enum(["monogram", "favicon"]).openapi({ description: "How this publisher's icon is displayed: a domain-initial monogram, or the domain's own favicon." }),
    created_at: dateTime("When the publisher was created."),
  }),
  z.object({
    domain: z.string().openapi({ description: "The exact registrable domain to add as a publisher, e.g. \"microsoft.com\"." }),
  }),
);

const publisherUpdate = registry.register(
  "PublisherUpdateRequest",
  z
    .object({
      data: z.object({
        type: z.literal("publisher").openapi({ description: "Always \"publisher\"." }),
        attributes: z.object({
          icon: z.enum(["monogram", "favicon"]).openapi({ description: "How to display this publisher's icon: a domain-initial monogram, or the domain's favicon." }),
        }),
      }),
    })
    .openapi("PublisherUpdateRequest", { description: "A request to change a publisher's icon preference." }),
);

// ── Auth (non-resource) schemas ──────────────────────────────────────────────

const RegisterRequest = registry.register(
  "RegisterRequest",
  z
    .object({
      email: z.string().openapi({ description: "The email address to register." }),
      password: z.string().openapi({ description: "The password to set for the new account." }),
      display_name: z.string().optional().openapi({ description: "An optional display name for the new user." }),
    })
    .openapi({ description: "Registration details for a new user and account." }),
);

const LoginRequest = registry.register(
  "LoginRequest",
  z
    .object({
      email: z.string().openapi({ description: "The registered email address." }),
      password: z.string().openapi({ description: "The account password." }),
    })
    .openapi({ description: "Credentials for password login." }),
);

const VerifyEmailRequest = registry.register(
  "VerifyEmailRequest",
  z
    .object({
      token: z.string().openapi({ description: "The verification token from the confirmation email." }),
    })
    .openapi({ description: "A request to confirm an email address." }),
);

const AuthTokenResponse = registry.register(
  "AuthTokenResponse",
  z
    .object({
      token: z.string().openapi({ description: "A session token to use as a bearer credential." }),
      expires_in: z.number().int().openapi({ description: "The token's lifetime in seconds." }),
      account_id: z.string().openapi({ description: "The id of the authenticated account." }),
      user_id: z.string().openapi({ description: "The id of the authenticated user." }),
      verified: z.boolean().openapi({ description: "Whether the user's email address has been confirmed." }),
    })
    .openapi({ description: "A newly issued session token and its context." }),
);

const OkResponse = registry.register(
  "OkResponse",
  z
    .object({ ok: z.boolean().openapi({ description: "True when the operation succeeded." }) })
    .openapi({ description: "A simple success acknowledgement." }),
);

const VerifiedResponse = registry.register(
  "VerifiedResponse",
  z
    .object({ verified: z.boolean().openapi({ description: "Whether the email address is now confirmed." }) })
    .openapi({ description: "The result of an email-verification attempt." }),
);

// ── Body / response helpers ──────────────────────────────────────────────────

const domainBody = (schema: z.ZodTypeAny, description: string) => ({
  required: true,
  description,
  content: { "application/vnd.api+json": { schema } },
});

const jsonBody = (schema: z.ZodTypeAny, description: string) => ({
  required: true,
  description,
  content: { "application/json": { schema } },
});

const domainResponse = (schema: z.ZodTypeAny, description: string) => ({
  description,
  content: { "application/vnd.api+json": { schema } },
});

const jsonResponse = (schema: z.ZodTypeAny, description: string) => ({
  description,
  content: { "application/json": { schema } },
});

// ── Query parameters ─────────────────────────────────────────────────────────

const pageNumberParam = registry.registerParameter(
  "PageNumber",
  z.string().optional().openapi({
    param: { name: "page[number]", in: "query" },
    description: "The 1-based page number to return.",
  }),
);
const pageSizeParam = registry.registerParameter(
  "PageSize",
  z.string().optional().openapi({
    param: { name: "page[size]", in: "query" },
    description: "The number of items per page.",
  }),
);
const metaTotalParam = registry.registerParameter(
  "MetaTotal",
  z.string().optional().openapi({
    param: { name: "meta[total]", in: "query" },
    description: "Set to request a total item count in the response meta.",
  }),
);
const sortParam = registry.registerParameter(
  "Sort",
  z.string().optional().openapi({
    param: { name: "sort", in: "query" },
    description: "A comma-separated list of fields to sort by; prefix a field with \"-\" for descending order.",
  }),
);

/** An inline filter[...] query parameter. */
const filterParam = (name: string, description: string, required = false) => ({
  name: `filter[${name}]`,
  in: "query" as const,
  required,
  description,
  schema: { type: "string" as const },
});

const paginationParams = [
  { $ref: "#/components/parameters/Sort" },
  { $ref: "#/components/parameters/PageNumber" },
  { $ref: "#/components/parameters/PageSize" },
  { $ref: "#/components/parameters/MetaTotal" },
];

const bearerSecurity = [{ bearerAuth: [] }];

// Registered once at module load so buildOpenApiDocument() stays idempotent across calls.
registry.registerComponent("securitySchemes", "bearerAuth", {
  type: "http",
  scheme: "bearer",
  description: "An API key (`sm_api_...`) or a session token.",
});

// ── Paths: Auth ──────────────────────────────────────────────────────────────

registry.registerPath({
  method: "post",
  path: "/api/v1/auth/register",
  tags: ["Auth"],
  summary: "Register a new user and account",
  request: { body: jsonBody(RegisterRequest, "The new user's details.") },
  responses: {
    "201": jsonResponse(AuthTokenResponse, "The account was created and a session token issued."),
    "400": errorJson("The request was malformed."),
    "409": errorJson("An account with that email already exists."),
  },
});

registry.registerPath({
  method: "post",
  path: "/api/v1/auth/login",
  tags: ["Auth"],
  summary: "Log in with email and password",
  request: { body: jsonBody(LoginRequest, "Login credentials.") },
  responses: {
    "200": jsonResponse(AuthTokenResponse, "Authentication succeeded and a session token was issued."),
    "400": errorJson("The request was malformed."),
    "401": errorJson("The credentials were not accepted."),
  },
});

registry.registerPath({
  method: "post",
  path: "/api/v1/auth/verify-email",
  tags: ["Auth"],
  summary: "Confirm an email address",
  request: { body: jsonBody(VerifyEmailRequest, "The verification token.") },
  responses: {
    "200": jsonResponse(VerifiedResponse, "The email address was confirmed."),
    "400": errorJson("The token was missing, malformed, or expired."),
  },
});

registry.registerPath({
  method: "post",
  path: "/api/v1/auth/resend-verification",
  tags: ["Auth"],
  summary: "Resend the email-verification message",
  security: bearerSecurity,
  responses: {
    "200": jsonResponse(OkResponse, "A verification email was sent."),
    "401": errorJson("Authentication credentials are missing, invalid, expired, or revoked."),
  },
});

registry.registerPath({
  method: "post",
  path: "/api/v1/auth/logout",
  tags: ["Auth"],
  summary: "Revoke the current session token",
  security: bearerSecurity,
  responses: {
    "200": jsonResponse(OkResponse, "The session token was revoked."),
    "401": errorJson("Authentication credentials are missing, invalid, expired, or revoked."),
  },
});

registry.registerPath({
  method: "get",
  path: "/api/v1/auth/oidc/{provider}",
  tags: ["Auth"],
  summary: "Begin an OIDC login",
  description: "Redirects the browser to the chosen identity provider's authorization endpoint.",
  request: {
    params: z.object({
      provider: z
        .enum(["google", "microsoft"])
        .openapi({ param: { name: "provider", in: "path" }, description: "The identity provider to authenticate with." }),
    }),
  },
  responses: {
    "302": { description: "Redirect to the identity provider's authorization endpoint." },
    "503": errorJson("The requested identity provider is not configured for this deployment."),
  },
});

registry.registerPath({
  method: "get",
  path: "/api/v1/auth/callback/{provider}",
  tags: ["Auth"],
  summary: "Complete an OIDC login",
  description: "The identity provider redirects here after authentication; the browser is redirected onward with a session established.",
  request: {
    params: z.object({
      provider: z
        .enum(["google", "microsoft"])
        .openapi({ param: { name: "provider", in: "path" }, description: "The identity provider that authenticated the user." }),
    }),
  },
  responses: {
    "302": { description: "Redirect onward with a session established." },
    "400": errorJson("The provider callback was malformed or the login could not be completed."),
  },
});

// ── Paths: Users ─────────────────────────────────────────────────────────────

registry.registerPath({
  method: "get",
  path: "/api/v1/users/current",
  tags: ["Users"],
  summary: "Get the current user",
  security: bearerSecurity,
  responses: {
    "200": domainResponse(user.Response, "The authenticated user."),
    "401": errorJson("Authentication credentials are missing, invalid, expired, or revoked."),
  },
});

registry.registerPath({
  method: "put",
  path: "/api/v1/users/current",
  tags: ["Users"],
  summary: "Update the current user",
  security: bearerSecurity,
  request: { body: domainBody(user.Request, "The updated user.") },
  responses: {
    "200": domainResponse(user.Response, "The updated user."),
    "400": errorJson("The request was malformed."),
    "401": errorJson("Authentication credentials are missing, invalid, expired, or revoked."),
  },
});

registry.registerPath({
  method: "get",
  path: "/api/v1/users/current/settings",
  tags: ["Users"],
  summary: "Get the current user's settings",
  description:
    "Returns the current user's saved preferences for this account (such as the console theme) as a JSON object, empty when none are set. Requires a session credential.",
  security: bearerSecurity,
  responses: {
    "200": jsonResponse(UserSettings, "The current user's settings."),
    "401": errorJson("Authentication credentials are missing, invalid, expired, or revoked."),
    "403": errorJson("The credential is not permitted to perform this action."),
  },
});

registry.registerPath({
  method: "put",
  path: "/api/v1/users/current/settings",
  tags: ["Users"],
  summary: "Replace the current user's settings",
  description:
    "Replaces the current user's saved preferences for this account with the supplied object; keys that are omitted are removed. Returns the stored settings. Requires a session credential.",
  security: bearerSecurity,
  request: { body: jsonBody(UserSettings, "The settings to store.") },
  responses: {
    "200": jsonResponse(UserSettings, "The stored settings."),
    "400": errorJson("The request was malformed."),
    "401": errorJson("Authentication credentials are missing, invalid, expired, or revoked."),
    "403": errorJson("The credential is not permitted to perform this action."),
  },
});

// ── Paths: Accounts ──────────────────────────────────────────────────────────

registry.registerPath({
  method: "get",
  path: "/api/v1/accounts/current",
  tags: ["Accounts"],
  summary: "Get the current account",
  security: bearerSecurity,
  responses: {
    "200": domainResponse(account.Response, "The authenticated account."),
    "401": errorJson("Authentication credentials are missing, invalid, expired, or revoked."),
  },
});

registry.registerPath({
  method: "put",
  path: "/api/v1/accounts/current",
  tags: ["Accounts"],
  summary: "Update the current account",
  security: bearerSecurity,
  request: { body: domainBody(account.Request, "The updated account.") },
  responses: {
    "200": domainResponse(account.Response, "The updated account."),
    "400": errorJson("The request was malformed."),
    "401": errorJson("Authentication credentials are missing, invalid, expired, or revoked."),
  },
});

registry.registerPath({
  method: "delete",
  path: "/api/v1/accounts/current",
  tags: ["Accounts"],
  summary: "Delete the current account",
  description: "Deletes the account and blocks all further access with its credentials. Owner-only, and only with a session credential (not an API key).",
  security: bearerSecurity,
  responses: {
    "204": { description: "The account was deleted." },
    "401": errorJson("Authentication credentials are missing, invalid, expired, or revoked."),
    "403": errorJson("Only the account owner can delete the account."),
  },
});

registry.registerPath({
  method: "get",
  path: "/api/v1/accounts/{id}",
  tags: ["Accounts"],
  summary: "Get an account by id",
  request: { params: z.object({ id: z.string().openapi({ param: { name: "id", in: "path" }, description: "The id of the account." }) }) },
  responses: {
    "200": domainResponse(account.Response, "The requested account."),
    "404": errorJson("The requested resource was not found."),
  },
});

// ── Paths: Account members ───────────────────────────────────────────────────

registry.registerPath({
  method: "get",
  path: "/api/v1/account_users",
  tags: ["Account members"],
  summary: "List members of the current account",
  security: bearerSecurity,
  request: { query: z.object({}) },
  responses: {
    "200": domainResponse(accountUser.ListResponse, "The account's members."),
    "401": errorJson("Authentication credentials are missing, invalid, expired, or revoked."),
  },
});

const memberIdParam = z.object({
  userId: z.string().openapi({ param: { name: "userId", in: "path" }, description: "The member's user id." }),
});

registry.registerPath({
  method: "put",
  path: "/api/v1/account_users/{userId}",
  tags: ["Account members"],
  summary: "Change a member's role",
  description: "Admin-only. The owner's role is immutable; admins may assign only MEMBER or VIEWER.",
  security: bearerSecurity,
  request: { params: memberIdParam, body: domainBody(accountUser.Request, "The new role.") },
  responses: {
    "200": domainResponse(accountUser.Response, "The updated membership."),
    ...commonErrors,
  },
});

registry.registerPath({
  method: "delete",
  path: "/api/v1/account_users/{userId}",
  tags: ["Account members"],
  summary: "Remove a member",
  description: "Admin-only. You cannot remove yourself or the account owner.",
  security: bearerSecurity,
  request: { params: memberIdParam },
  responses: {
    "204": { description: "The member was removed." },
    ...commonErrors,
  },
});

// ── Paths: Account switcher + switch session ─────────────────────────────────

registry.registerPath({
  method: "get",
  path: "/api/v1/accounts",
  tags: ["Accounts"],
  summary: "List the accounts you belong to",
  description: "Every account the current user is a member of, with their role in each.",
  security: bearerSecurity,
  responses: {
    "200": domainResponse(accountMembership.ListResponse, "The caller's account memberships."),
    "401": errorJson("Authentication credentials are missing, invalid, expired, or revoked."),
  },
});

registry.registerPath({
  method: "post",
  path: "/api/v1/auth/switch",
  tags: ["Auth"],
  summary: "Switch the active account",
  description: "Re-issues a session token for another account the caller is a member of.",
  security: bearerSecurity,
  request: {
    body: jsonBody(
      z
        .object({ account_id: z.string().openapi({ description: "The account to switch to." }) })
        .openapi("SwitchAccountRequest", { description: "The account to make active." }),
      "The account to switch to.",
    ),
  },
  responses: {
    "200": jsonResponse(AuthTokenResponse, "A session token for the selected account."),
    ...commonErrors,
  },
});

// ── Paths: Invitations ───────────────────────────────────────────────────────

const invitationIdParam = z.object({
  id: z.string().openapi({ param: { name: "id", in: "path" }, description: "The id of the invitation." }),
});

registry.registerPath({
  method: "post",
  path: "/api/v1/invitations",
  tags: ["Invitations"],
  summary: "Invite a member",
  description: "Admin-only. Emails the invitee a link to accept and join the account at the given role.",
  security: bearerSecurity,
  request: { body: domainBody(invitation.Request, "The invitation to send.") },
  responses: {
    "201": domainResponse(invitation.Response, "The created invitation (includes the token once)."),
    ...commonErrors,
    "409": errorJson("The person is already a member or already has a pending invitation."),
  },
});

registry.registerPath({
  method: "get",
  path: "/api/v1/invitations",
  tags: ["Invitations"],
  summary: "List invitations, or preview one by token",
  description:
    "With filter[token] (no auth required) returns the single matching invitation for the sign-in preview. Otherwise lists the current account's invitations (admin-only), optionally filtered by status.",
  parameters: [
    filterParam("token", "Look up a single invitation by its token (unauthenticated preview)."),
    filterParam("status", "Limit to invitations in this status (PENDING, ACCEPTED, REVOKED, EXPIRED)."),
    ...paginationParams,
  ],
  responses: {
    "200": domainResponse(invitation.ListResponse, "The matching invitations."),
    "403": errorJson("The credential is not permitted to list invitations."),
  },
});

registry.registerPath({
  method: "post",
  path: "/api/v1/invitations/{id}/actions/revoke",
  tags: ["Invitations"],
  summary: "Revoke a pending invitation",
  security: bearerSecurity,
  request: { params: invitationIdParam },
  responses: {
    "200": domainResponse(invitation.Response, "The revoked invitation."),
    ...commonErrors,
    "409": errorJson("Only a pending invitation can be revoked."),
  },
});

registry.registerPath({
  method: "post",
  path: "/api/v1/invitations/{id}/actions/resend",
  tags: ["Invitations"],
  summary: "Resend a pending invitation",
  description: "Issues a fresh token, extends the expiry, and re-sends the invitation email.",
  security: bearerSecurity,
  request: { params: invitationIdParam },
  responses: {
    "200": domainResponse(invitation.Response, "The invitation, with a new token."),
    ...commonErrors,
    "409": errorJson("Only a pending invitation can be resent."),
  },
});

registry.registerPath({
  method: "post",
  path: "/api/v1/invitations/accept",
  tags: ["Invitations"],
  summary: "Accept an invitation",
  description: "The signed-in user (whose email must match the invitation) joins the account.",
  security: bearerSecurity,
  request: { body: domainBody(AcceptInvitationRequest, "The invitation token.") },
  responses: {
    "200": domainResponse(invitation.Response, "The accepted invitation."),
    ...commonErrors,
    "409": errorJson("The invitation has already been used, revoked, or expired."),
    "410": errorJson("The invitation has expired."),
  },
});

// ── Paths: Contact ───────────────────────────────────────────────────────────

registry.registerPath({
  method: "post",
  path: "/api/v1/emails",
  tags: ["Contact"],
  summary: "Send a message to support",
  description: "Emails the smplmark team and sends the sender an acknowledgement.",
  security: bearerSecurity,
  request: { body: domainBody(contactEmail.Request, "The message to send.") },
  responses: {
    "201": domainResponse(contactEmail.Response, "The message was sent."),
    ...commonErrors,
    "503": errorJson("Messaging is not available in this deployment."),
  },
});

// ── Paths: API keys ──────────────────────────────────────────────────────────

registry.registerPath({
  method: "post",
  path: "/api/v1/api_keys",
  tags: ["API keys"],
  summary: "Create an API key",
  security: bearerSecurity,
  request: { body: domainBody(apiKey.Request, "The key to create.") },
  responses: {
    "201": domainResponse(apiKey.Response, "The created key, including its value (returned only here)."),
    ...commonErrors,
  },
});

registry.registerPath({
  method: "get",
  path: "/api/v1/api_keys",
  tags: ["API keys"],
  summary: "List API keys",
  security: bearerSecurity,
  parameters: [
    filterParam("scope_type", "Limit results to keys of this scope: ACCOUNT, BENCHMARK, or RUN."),
    filterParam("scope_ref", "Limit results to keys scoped to this specific benchmark or run id (use with filter[scope_type])."),
    ...paginationParams,
  ],
  responses: {
    "200": domainResponse(apiKey.ListResponse, "The account's API keys. The key value is omitted."),
    "401": errorJson("Authentication credentials are missing, invalid, expired, or revoked."),
  },
});

registry.registerPath({
  method: "get",
  path: "/api/v1/api_keys/{id}",
  tags: ["API keys"],
  summary: "Reveal an API key",
  description: "Returns the key including its value.",
  security: bearerSecurity,
  request: { params: z.object({ id: z.string().openapi({ param: { name: "id", in: "path" }, description: "The id of the API key." }) }) },
  responses: {
    "200": domainResponse(apiKey.Response, "The key, including its value."),
    ...commonErrors,
  },
});

registry.registerPath({
  method: "put",
  path: "/api/v1/api_keys/{id}",
  tags: ["API keys"],
  summary: "Rename an API key",
  description: "Updates the key's name. Its scope and expiry are fixed at creation and cannot be changed.",
  security: bearerSecurity,
  request: {
    params: z.object({ id: z.string().openapi({ param: { name: "id", in: "path" }, description: "The id of the API key." }) }),
    body: domainBody(
      z
        .object({
          data: z.object({
            type: z.literal("api_key").openapi({ description: "Always \"api_key\"." }),
            attributes: z.object({ name: z.string().openapi({ description: "A human-readable label for the key." }) }),
          }),
        })
        .openapi("ApiKeyUpdateRequest", { description: "A request to rename an API key." }),
      "The key's new name.",
    ),
  },
  responses: {
    "200": domainResponse(apiKey.Response, "The updated key."),
    ...commonErrors,
  },
});

registry.registerPath({
  method: "post",
  path: "/api/v1/api_keys/{id}/actions/revoke",
  tags: ["API keys"],
  summary: "Revoke an API key",
  description: "Disables the key immediately. It stops authenticating but stays listed with a revoked status; use Delete to remove it entirely.",
  security: bearerSecurity,
  request: { params: z.object({ id: z.string().openapi({ param: { name: "id", in: "path" }, description: "The id of the API key." }) }) },
  responses: {
    "200": domainResponse(apiKey.Response, "The revoked key."),
    ...commonErrors,
  },
});

registry.registerPath({
  method: "post",
  path: "/api/v1/api_keys/{id}/actions/rotate",
  tags: ["API keys"],
  summary: "Rotate an API key",
  description: "Revokes the existing key value and issues a new one, returned only in this response.",
  security: bearerSecurity,
  request: { params: z.object({ id: z.string().openapi({ param: { name: "id", in: "path" }, description: "The id of the API key." }) }) },
  responses: {
    "200": domainResponse(apiKey.Response, "The rotated key, including its new value."),
    ...commonErrors,
  },
});

registry.registerPath({
  method: "delete",
  path: "/api/v1/api_keys/{id}",
  tags: ["API keys"],
  summary: "Delete an API key",
  description: "Permanently removes the key. To disable a key while keeping a record of it, revoke it instead.",
  security: bearerSecurity,
  request: { params: z.object({ id: z.string().openapi({ param: { name: "id", in: "path" }, description: "The id of the API key." }) }) },
  responses: {
    "204": { description: "The key was deleted." },
    ...commonErrors,
  },
});

// ── Paths: Benchmarks ────────────────────────────────────────────────────────

const benchmarkIdParam = z.object({
  id: z.string().openapi({ param: { name: "id", in: "path" }, description: "The id of the benchmark." }),
});

registry.registerPath({
  method: "post",
  path: "/api/v1/benchmarks",
  tags: ["Benchmarks"],
  summary: "Create a benchmark",
  security: bearerSecurity,
  request: { body: domainBody(benchmark.Request, "The benchmark to create.") },
  responses: {
    "201": domainResponse(benchmark.Response, "The created benchmark."),
    ...commonErrors,
    "409": errorJson("A benchmark with that key already exists in the account, or the account has reached its limit of 100 benchmarks."),
  },
});

registry.registerPath({
  method: "get",
  path: "/api/v1/benchmarks",
  tags: ["Benchmarks"],
  summary: "List benchmarks",
  description:
    "Sortable by name, created_at, updated_at, published_at, and popularity: views (all-time) or the rolling windows views_today, views_week, views_month, views_year (prefix with - for descending, e.g. sort=-published_at for the most recently published).",
  parameters: [
    filterParam("account", "Limit results to benchmarks owned by this account id."),
    filterParam("publisher", "Limit results to benchmarks published by the account with this key (URL slug), e.g. stanford-helm."),
    filterParam("key", "Limit results to the benchmark with this key."),
    filterParam("tag", "Limit results to benchmarks carrying this tag (exact match on the tag's lowercase slug)."),
    filterParam("category", "Limit results to benchmarks in this category: HARDWARE, DATABASE, ML_AI, STORAGE, NETWORK, or OTHER."),
    filterParam("search", "Free-text search. Every term must match (AND) as a case-insensitive substring of the benchmark's key, name, description, about, methodology, category, tags, ingested source name, or the name or key of any of its subjects — so searching for a model or system (e.g. \"llama 3\") finds the benchmark that contains it. Double-quote a phrase to match it exactly, e.g. \"blender 4.2\". At most 8 terms."),
    ...paginationParams,
  ],
  responses: {
    "200": domainResponse(benchmark.ListResponse, "A page of benchmarks."),
    "400": errorJson("The query parameters were malformed."),
  },
});

registry.registerPath({
  method: "get",
  path: "/api/v1/external_sources",
  tags: ["External sources"],
  summary: "List external sources",
  description:
    "The third-party sources smplmark republishes openly licensed benchmark results from. Each entry names the source, what it publishes, its license, and when data was last retrieved from it. Sortable by name (the default), key, retrieved_at, and benchmark_count (prefix with - for descending).",
  parameters: [...paginationParams],
  responses: {
    "200": domainResponse(externalSource.ListResponse, "The source catalog."),
    "400": errorJson("The query parameters were malformed."),
  },
});

registry.registerPath({
  method: "get",
  path: "/api/v1/benchmarks/{id}",
  tags: ["Benchmarks"],
  summary: "Get a benchmark by id",
  request: { params: benchmarkIdParam },
  responses: {
    "200": domainResponse(benchmark.Response, "The requested benchmark."),
    "404": errorJson("The requested resource was not found."),
  },
});

for (const [action, summary, description] of [
  ["close", "Close a benchmark", "Marks the benchmark complete: no new subjects, runs, or measurements may be added. Existing data stays public and append-only. Reversible via actions/reopen."],
  ["reopen", "Reopen a benchmark", "Clears the complete mark so new subjects, runs, and measurements may be added again."],
] as const) {
  registry.registerPath({
    method: "post",
    path: `/api/v1/benchmarks/{id}/actions/${action}`,
    tags: ["Benchmarks"],
    summary,
    description,
    security: bearerSecurity,
    request: { params: benchmarkIdParam },
    responses: {
      "200": domainResponse(benchmark.Response, "The updated benchmark."),
      ...commonErrors,
      "409": errorJson(action === "close" ? "The benchmark is already closed." : "The benchmark is not closed."),
    },
  });
}

registry.registerPath({
  method: "post",
  path: "/api/v1/benchmarks/{id}/actions/view",
  tags: ["Benchmarks"],
  summary: "Record a page view",
  description:
    "Increments the benchmark's view counters (all-time plus the current day's bucket, which feeds the windowed popularity sorts). Unauthenticated and best-effort: benchmark pages fire it once per load. Only world-visible benchmarks accept views.",
  request: { params: benchmarkIdParam },
  responses: {
    "204": { description: "The view was recorded." },
    "404": errorJson("The requested resource was not found."),
  },
});

registry.registerPath({
  method: "put",
  path: "/api/v1/benchmarks/{id}",
  tags: ["Benchmarks"],
  summary: "Update a benchmark",
  security: bearerSecurity,
  request: { params: benchmarkIdParam, body: domainBody(benchmark.Request, "The updated benchmark.") },
  responses: {
    "200": domainResponse(benchmark.Response, "The updated benchmark."),
    ...commonErrors,
  },
});

registry.registerPath({
  method: "delete",
  path: "/api/v1/benchmarks/{id}",
  tags: ["Benchmarks"],
  summary: "Delete a benchmark",
  security: bearerSecurity,
  request: { params: benchmarkIdParam },
  responses: {
    "204": { description: "The benchmark was deleted." },
    ...commonErrors,
  },
});

registry.registerPath({
  method: "post",
  path: "/api/v1/benchmarks/{id}/actions/mark_ready",
  tags: ["Benchmarks"],
  summary: "Mark a benchmark ready to publish",
  description:
    "Moves the benchmark out of draft. Its data is then locked until it is published or returned to draft. Allowed for the benchmark's author or an admin.",
  security: bearerSecurity,
  request: { params: benchmarkIdParam },
  responses: {
    "200": domainResponse(benchmark.Response, "The benchmark, now marked ready."),
    ...commonErrors,
    "409": errorJson("Only a private benchmark can be marked ready."),
  },
});

registry.registerPath({
  method: "post",
  path: "/api/v1/benchmarks/{id}/actions/return_to_draft",
  tags: ["Benchmarks"],
  summary: "Return a benchmark to draft",
  description:
    "Unlocks a benchmark that was marked ready so it can be edited again. Serves as both author recall and admin reject; an optional reason is echoed back in the response meta.",
  security: bearerSecurity,
  request: {
    params: benchmarkIdParam,
    body: domainBody(
      z
        .object({
          reason: z.string().optional().openapi({ description: "An optional note explaining why the benchmark was returned to draft." }),
        })
        .openapi("BenchmarkReturnToDraftRequest", { description: "Details for returning a benchmark to draft." }),
      "An optional reason.",
    ),
  },
  responses: {
    "200": domainResponse(benchmark.Response, "The benchmark, returned to draft."),
    ...commonErrors,
    "409": errorJson("Only a private benchmark can be returned to draft."),
  },
});

registry.registerPath({
  method: "post",
  path: "/api/v1/benchmarks/{id}/actions/publish",
  tags: ["Benchmarks"],
  summary: "Publish a benchmark",
  description:
    "Makes the benchmark and its data publicly readable, attributing it either to a verified publisher domain (pass publisher, admin only) or to the author personally (omit it, when the account allows personal publishing). The benchmark must be marked ready first, and requires a signed-in user — API keys cannot publish.",
  security: bearerSecurity,
  request: {
    params: benchmarkIdParam,
    body: {
      required: false,
      description: "How to attribute the published benchmark. Omit entirely for a personal publish.",
      content: {
        "application/vnd.api+json": {
          schema: z
            .object({
              publisher: z
                .string()
                .optional()
                .openapi({ description: "The verified publisher (domain) to attribute the benchmark to. Omit (or pass \"self\") to publish under the author's personal identity." }),
            })
            .openapi("BenchmarkPublishRequest", { description: "How to attribute the published benchmark." }),
        },
      },
    },
  },
  responses: {
    "200": domainResponse(benchmark.Response, "The published benchmark."),
    ...commonErrors,
    "409": errorJson("The benchmark cannot be published from its current state, or the chosen publisher's domain is not verified."),
  },
});

registry.registerPath({
  method: "post",
  path: "/api/v1/benchmarks/{id}/actions/withdraw",
  tags: ["Benchmarks"],
  summary: "Withdraw a benchmark",
  description: "Removes a published benchmark from public view.",
  security: bearerSecurity,
  request: {
    params: benchmarkIdParam,
    body: domainBody(
      z
        .object({ withdrawal_reason: z.string().openapi({ description: "The reason the benchmark is being withdrawn." }) })
        .openapi("BenchmarkWithdrawRequest", { description: "Details for withdrawing a benchmark." }),
      "The withdrawal reason.",
    ),
  },
  responses: {
    "200": domainResponse(benchmark.Response, "The withdrawn benchmark."),
    ...commonErrors,
    "409": errorJson("The benchmark cannot be withdrawn from its current state."),
  },
});

// ── Paths: Subjects ───────────────────────────────────────────────────────────

const subjectIdParam = z.object({
  id: z.string().openapi({ param: { name: "id", in: "path" }, description: "The id of the subject." }),
});

registry.registerPath({
  method: "post",
  path: "/api/v1/subjects",
  tags: ["Subjects"],
  summary: "Create a subject",
  description:
    "Creates a subject owned by your account. A subject is a reusable entity (a system, model, or configuration you measure); link it into one or more benchmarks with POST /api/v1/benchmark_subjects.",
  security: bearerSecurity,
  request: { body: domainBody(subject.Request, "The subject to create.") },
  responses: {
    "201": domainResponse(subject.Response, "The created subject."),
    ...commonErrors,
    "409": errorJson("A subject with that key already exists in your account, or the account has reached its subject limit."),
  },
});

registry.registerPath({
  method: "get",
  path: "/api/v1/subjects",
  tags: ["Subjects"],
  summary: "List subjects",
  description:
    "With filter[benchmark], lists the subjects linked to that benchmark (public benchmarks are world-visible). Without it, lists your own account's subjects and requires authentication.",
  parameters: [
    filterParam("benchmark", "Limit results to subjects linked to this benchmark id."),
    filterParam("subject_type", "Limit account-scoped results to subjects of this subject type id."),
    filterParam("key", "Limit results to the subject with this key."),
    ...paginationParams,
  ],
  responses: {
    "200": domainResponse(subject.ListResponse, "A page of subjects."),
    "400": errorJson("The query parameters were malformed."),
  },
});

registry.registerPath({
  method: "get",
  path: "/api/v1/subjects/{id}",
  tags: ["Subjects"],
  summary: "Get a subject by id",
  request: { params: subjectIdParam },
  responses: {
    "200": domainResponse(subject.Response, "The requested subject."),
    "404": errorJson("The requested resource was not found."),
  },
});

registry.registerPath({
  method: "put",
  path: "/api/v1/subjects/{id}",
  tags: ["Subjects"],
  summary: "Update a subject",
  security: bearerSecurity,
  request: { params: subjectIdParam, body: domainBody(subject.Request, "The updated subject.") },
  responses: {
    "200": domainResponse(subject.Response, "The updated subject."),
    ...commonErrors,
  },
});

registry.registerPath({
  method: "delete",
  path: "/api/v1/subjects/{id}",
  tags: ["Subjects"],
  summary: "Delete a subject",
  description:
    "Deletes an account-owned subject along with its measurements and benchmark links. A subject linked to a published benchmark cannot be deleted until it is unlinked there.",
  security: bearerSecurity,
  request: { params: subjectIdParam },
  responses: {
    "204": { description: "The subject was deleted." },
    ...commonErrors,
    "409": errorJson("The subject is linked to a published benchmark; unlink it there before deleting."),
  },
});

// ── Paths: Subject types (the field schema for subjects) ──────────────────────
const subjectTypeIdParam = z.object({
  id: z.string().openapi({ param: { name: "id", in: "path" }, description: "The id of the subject type." }),
});

registry.registerPath({
  method: "post",
  path: "/api/v1/subject_types",
  tags: ["Subject types"],
  summary: "Create a subject type",
  description:
    "Creates a subject type — a named schema of typed `fields` that subjects of this type conform to. The key is derived from the name automatically. Requires an account-scoped credential.",
  security: bearerSecurity,
  request: { body: domainBody(subjectType.Request, "The subject type to create.") },
  responses: {
    "201": domainResponse(subjectType.Response, "The created subject type."),
    ...commonErrors,
    "409": errorJson("The account has reached its subject-type limit."),
  },
});

registry.registerPath({
  method: "get",
  path: "/api/v1/subject_types",
  tags: ["Subject types"],
  summary: "List subject types",
  description: "Lists your account's subject types. Requires an account-scoped credential.",
  security: bearerSecurity,
  parameters: [...paginationParams],
  responses: {
    "200": domainResponse(subjectType.ListResponse, "A page of subject types."),
    ...commonErrors,
  },
});

registry.registerPath({
  method: "get",
  path: "/api/v1/subject_types/{id}",
  tags: ["Subject types"],
  summary: "Get a subject type by id",
  security: bearerSecurity,
  request: { params: subjectTypeIdParam },
  responses: {
    "200": domainResponse(subjectType.Response, "The requested subject type."),
    ...commonErrors,
    "404": errorJson("The requested resource was not found."),
  },
});

registry.registerPath({
  method: "put",
  path: "/api/v1/subject_types/{id}",
  tags: ["Subject types"],
  summary: "Update a subject type",
  description: "Updates a subject type's name and fields. Its key is immutable.",
  security: bearerSecurity,
  request: { params: subjectTypeIdParam, body: domainBody(subjectType.Request, "The updated subject type.") },
  responses: {
    "200": domainResponse(subjectType.Response, "The updated subject type."),
    ...commonErrors,
  },
});

registry.registerPath({
  method: "delete",
  path: "/api/v1/subject_types/{id}",
  tags: ["Subject types"],
  summary: "Delete a subject type",
  security: bearerSecurity,
  request: { params: subjectTypeIdParam },
  responses: {
    "204": { description: "The subject type was deleted." },
    ...commonErrors,
  },
});

// ── Paths: Metrics (the reusable metric catalogue) ───────────────────────────
const metricIdParam = z.object({
  id: z.string().openapi({ param: { name: "id", in: "path" }, description: "The id of the metric." }),
});

registry.registerPath({
  method: "post",
  path: "/api/v1/metrics",
  tags: ["Metrics"],
  summary: "Create a metric",
  description:
    "Creates a metric — a reusable definition (STORED value or DERIVED, computed on read). The name is normalized to snake_case and derived from the label when omitted. Requires an account-scoped credential.",
  security: bearerSecurity,
  request: { body: domainBody(metric.Request, "The metric to create.") },
  responses: {
    "201": domainResponse(metric.Response, "The created metric."),
    ...commonErrors,
    "409": errorJson("The account has reached its metric limit, or the name is taken."),
  },
});

registry.registerPath({
  method: "get",
  path: "/api/v1/metrics",
  tags: ["Metrics"],
  summary: "List metrics",
  description: "Lists your account's metrics. Requires an account-scoped credential.",
  security: bearerSecurity,
  parameters: [...paginationParams],
  responses: {
    "200": domainResponse(metric.ListResponse, "A page of metrics."),
    ...commonErrors,
  },
});

registry.registerPath({
  method: "get",
  path: "/api/v1/metrics/{id}",
  tags: ["Metrics"],
  summary: "Get a metric by id",
  security: bearerSecurity,
  request: { params: metricIdParam },
  responses: {
    "200": domainResponse(metric.Response, "The requested metric."),
    ...commonErrors,
    "404": errorJson("The requested resource was not found."),
  },
});

registry.registerPath({
  method: "put",
  path: "/api/v1/metrics/{id}",
  tags: ["Metrics"],
  summary: "Update a metric",
  description: "Updates a metric's label, description, type, kind, and formula. Its name is immutable.",
  security: bearerSecurity,
  request: { params: metricIdParam, body: domainBody(metric.Request, "The updated metric.") },
  responses: {
    "200": domainResponse(metric.Response, "The updated metric."),
    ...commonErrors,
  },
});

registry.registerPath({
  method: "delete",
  path: "/api/v1/metrics/{id}",
  tags: ["Metrics"],
  summary: "Delete a metric",
  security: bearerSecurity,
  request: { params: metricIdParam },
  responses: {
    "204": { description: "The metric was deleted." },
    ...commonErrors,
  },
});

// ── Paths: Benchmark subjects (the M:N link) ──────────────────────────────────

const benchmarkSubjectIdParam = z.object({
  id: z.string().openapi({ param: { name: "id", in: "path" }, description: "The id of the benchmark–subject link." }),
});

registry.registerPath({
  method: "post",
  path: "/api/v1/benchmark_subjects",
  tags: ["Subjects"],
  summary: "Link a subject to a benchmark",
  description:
    "Adds an existing account-owned subject to a benchmark. Adding a subject is an append, so it is allowed while the benchmark is a draft or already published — but not while it is marked ready or closed.",
  security: bearerSecurity,
  request: { body: domainBody(benchmarkSubject.Request, "The benchmark and subject to link.") },
  responses: {
    "201": domainResponse(benchmarkSubject.Response, "The created link."),
    ...commonErrors,
    "409": errorJson("The subject is already linked to this benchmark, does not belong to the benchmark's account, or the benchmark has reached its subject limit."),
  },
});

registry.registerPath({
  method: "get",
  path: "/api/v1/benchmark_subjects",
  tags: ["Subjects"],
  summary: "List benchmark–subject links",
  description: "Provide at least one of filter[benchmark] or filter[subject] to scope the results.",
  parameters: [
    filterParam("benchmark", "Limit results to links of this benchmark id."),
    filterParam("subject", "Limit results to links of this subject id."),
    ...paginationParams,
  ],
  responses: {
    "200": domainResponse(benchmarkSubject.ListResponse, "A page of links."),
    "400": errorJson("The query parameters were malformed."),
  },
});

registry.registerPath({
  method: "delete",
  path: "/api/v1/benchmark_subjects/{id}",
  tags: ["Subjects"],
  summary: "Unlink a subject from a benchmark",
  description:
    "Removes a subject from a benchmark and deletes the measurements it had under that benchmark's runs. The subject itself survives (it is account-owned). Only allowed while the benchmark is a draft; a published benchmark's subject set is frozen.",
  security: bearerSecurity,
  request: { params: benchmarkSubjectIdParam },
  responses: {
    "204": { description: "The link was removed." },
    ...commonErrors,
    "409": errorJson("Published benchmark data is append-only; the subject cannot be unlinked."),
  },
});

// ── Paths: Benchmark metrics (the M:N link) ───────────────────────────────────

const benchmarkMetricIdParam = z.object({
  id: z.string().openapi({ param: { name: "id", in: "path" }, description: "The id of the benchmark–metric link." }),
});

registry.registerPath({
  method: "post",
  path: "/api/v1/benchmark_metrics",
  tags: ["Metrics"],
  summary: "Link a metric to a benchmark",
  description:
    "Links a metric from the account's library to a benchmark, copying its definition into the benchmark's measurement schema (a stored value, or a derived value with its computed expression). Adding a metric is an append, so it is allowed while the benchmark is a draft or already published — but not while it is marked ready or closed.",
  security: bearerSecurity,
  request: { body: domainBody(benchmarkMetric.Request, "The benchmark and metric to link.") },
  responses: {
    "201": domainResponse(benchmarkMetric.Response, "The created link."),
    ...commonErrors,
    "409": errorJson("The metric is already linked to this benchmark, its name is already defined on the benchmark, it does not belong to the benchmark's account, or the benchmark has reached its metric limit."),
  },
});

registry.registerPath({
  method: "get",
  path: "/api/v1/benchmark_metrics",
  tags: ["Metrics"],
  summary: "List benchmark–metric links",
  description: "Provide at least one of filter[benchmark] or filter[metric] to scope the results.",
  parameters: [
    filterParam("benchmark", "Limit results to links of this benchmark id."),
    filterParam("metric", "Limit results to links of this metric id."),
    ...paginationParams,
  ],
  responses: {
    "200": domainResponse(benchmarkMetric.ListResponse, "A page of links."),
    "400": errorJson("The query parameters were malformed."),
  },
});

registry.registerPath({
  method: "delete",
  path: "/api/v1/benchmark_metrics/{id}",
  tags: ["Metrics"],
  summary: "Unlink a metric from a benchmark",
  description:
    "Removes a metric from a benchmark, dropping its definition from the benchmark's measurement schema. Existing measurement data is retained but the metric is no longer part of the benchmark. Only allowed while the benchmark is a draft; a published benchmark's metric set is frozen.",
  security: bearerSecurity,
  request: { params: benchmarkMetricIdParam },
  responses: {
    "204": { description: "The link was removed." },
    ...commonErrors,
    "409": errorJson("Published benchmark data is append-only; the metric cannot be unlinked."),
  },
});

// ── Paths: Runs ──────────────────────────────────────────────────────────────

const runIdParam = z.object({
  id: z.string().openapi({ param: { name: "id", in: "path" }, description: "The id of the run." }),
});

registry.registerPath({
  method: "post",
  path: "/api/v1/runs",
  tags: ["Runs"],
  summary: "Create a run",
  security: bearerSecurity,
  request: { body: domainBody(run.Request, "The run to create.") },
  responses: {
    "201": domainResponse(run.Response, "The created run."),
    ...commonErrors,
    "409": errorJson("A run with that key already exists in the benchmark, or the benchmark has reached its run limit."),
  },
});

registry.registerPath({
  method: "get",
  path: "/api/v1/runs",
  tags: ["Runs"],
  summary: "List runs",
  parameters: [
    filterParam("benchmark", "Limit results to runs of this benchmark id — one request for a whole leaderboard. Required.", true),
    filterParam("key", "Limit results to the run with this key."),
    ...paginationParams,
  ],
  responses: {
    "200": domainResponse(run.ListResponse, "A page of runs."),
    "400": errorJson("The query parameters were malformed."),
    "404": errorJson("filter[benchmark] was missing, or no benchmark with that id is visible."),
  },
});

registry.registerPath({
  method: "get",
  path: "/api/v1/runs/{id}",
  tags: ["Runs"],
  summary: "Get a run by id",
  request: { params: runIdParam },
  responses: {
    "200": domainResponse(run.Response, "The requested run."),
    "404": errorJson("The requested resource was not found."),
  },
});

registry.registerPath({
  method: "put",
  path: "/api/v1/runs/{id}",
  tags: ["Runs"],
  summary: "Update a run",
  security: bearerSecurity,
  request: { params: runIdParam, body: domainBody(run.Request, "The updated run.") },
  responses: {
    "200": domainResponse(run.Response, "The updated run."),
    ...commonErrors,
    "409": errorJson("The run's started_at is frozen once its benchmark is published."),
  },
});

registry.registerPath({
  method: "delete",
  path: "/api/v1/runs/{id}",
  tags: ["Runs"],
  summary: "Delete a run",
  security: bearerSecurity,
  request: { params: runIdParam },
  responses: {
    "204": { description: "The run was deleted." },
    ...commonErrors,
    "409": errorJson("Published benchmark data is append-only; a run cannot be deleted. Invalidate it instead."),
  },
});

registry.registerPath({
  method: "post",
  path: "/api/v1/runs/{id}/actions/end",
  tags: ["Runs"],
  summary: "End a run",
  description: "Marks the run as no longer live; it stops accepting new measurements.",
  security: bearerSecurity,
  request: { params: runIdParam },
  responses: {
    "200": domainResponse(run.Response, "The ended run."),
    ...commonErrors,
    "409": errorJson("The run cannot be ended from its current state."),
  },
});

registry.registerPath({
  method: "post",
  path: "/api/v1/runs/{id}/actions/invalidate",
  tags: ["Runs"],
  summary: "Invalidate a run",
  description: "Marks the run invalid so it is excluded from published results.",
  security: bearerSecurity,
  request: {
    params: runIdParam,
    // JSON:API envelope (data.type.attributes), matching how the handler reads the body — a flat
    // { invalidation_reason } is not accepted, so the spec must advertise the wrapped shape.
    body: domainBody(
      z
        .object({
          data: z.object({
            type: z.literal("run").openapi({ description: 'Always "run".' }),
            attributes: z.object({
              invalidation_reason: z
                .string()
                .optional()
                .openapi({ description: "An optional reason the run is being invalidated." }),
            }),
          }),
        })
        .openapi("RunInvalidateRequest", { description: "Details for invalidating a run." }),
      "The invalidation reason.",
    ),
  },
  responses: {
    "200": domainResponse(run.Response, "The invalidated run."),
    ...commonErrors,
  },
});

// ── Paths: Measurements ──────────────────────────────────────────────────────

registry.registerPath({
  method: "post",
  path: "/api/v1/measurements",
  tags: ["Measurements"],
  summary: "Record a measurement",
  security: bearerSecurity,
  request: { body: domainBody(measurement.Request, "The measurement to record.") },
  responses: {
    "201": domainResponse(measurement.Response, "The recorded measurement, with derived metrics computed."),
    ...commonErrors,
    "409": errorJson("The run and subject belong to different benchmarks, or the benchmark/subject is closed or the run has ended."),
  },
});

registry.registerPath({
  method: "get",
  path: "/api/v1/measurements",
  tags: ["Measurements"],
  summary: "List measurements",
  description:
    "Reads measurements for exactly one of a run, subject, or benchmark. With an Accept header of text/csv, the response is a CSV export of the same data.",
  parameters: [
    filterParam("run", "Read measurements for this run id. Provide exactly one of filter[run], filter[subject], or filter[benchmark]."),
    filterParam("subject", "Read measurements for this subject id. Provide exactly one of filter[run], filter[subject], or filter[benchmark]."),
    filterParam("benchmark", "Read measurements for this benchmark id. Provide exactly one of filter[run], filter[subject], or filter[benchmark]."),
    filterParam(
      "created_at",
      "Restrict to a time interval using the grammar [start,end) — a half-open range where start is inclusive and end is exclusive; use * for an open edge, e.g. [2026-01-01T00:00:00Z,*).",
    ),
    ...paginationParams,
  ],
  responses: {
    "200": {
      description: "A page of measurements, as JSON or CSV depending on the Accept header.",
      content: {
        "application/vnd.api+json": { schema: measurement.ListResponse },
        "text/csv": {
          schema: {
            type: "string",
            description: "A CSV export with one row per measurement and one column per metric.",
          },
        },
      },
    },
    "400": errorJson("The query parameters were malformed, or not exactly one resource filter was provided."),
    "404": errorJson("The scoped run, subject, or benchmark does not exist or is not visible."),
  },
});

registry.registerPath({
  method: "delete",
  path: "/api/v1/measurements/{id}",
  tags: ["Measurements"],
  summary: "Delete a measurement",
  description:
    "Removes a single measurement. Measurements are append-only once their benchmark is published; deletion is only allowed while the benchmark is a draft. On a published benchmark, invalidate the whole run instead.",
  security: bearerSecurity,
  request: {
    params: z.object({
      id: z.string().openapi({ param: { name: "id", in: "path" }, description: "The id of the measurement." }),
    }),
  },
  responses: {
    "204": { description: "The measurement was deleted." },
    ...commonErrors,
    "409": errorJson("The measurement's benchmark is published; measurements there are append-only."),
  },
});

// ── Paths: Publishers ────────────────────────────────────────────────────────

const publisherIdParam = z.object({
  id: z.string().openapi({ param: { name: "id", in: "path" }, description: "The id of the publisher." }),
});

registry.registerPath({
  method: "post",
  path: "/api/v1/publishers",
  tags: ["Publishers"],
  summary: "Add a publisher (domain)",
  description:
    "Admin-only. A publisher is a domain you publish benchmarks under. Returns a verification token to add to the domain's DNS as a TXT record; then call the verify action to prove ownership.",
  security: bearerSecurity,
  request: { body: domainBody(publisher.Request, "The domain to add.") },
  responses: {
    "201": domainResponse(publisher.Response, "The created publisher, including the token to add to DNS."),
    ...commonErrors,
    "409": errorJson("That domain is already a publisher for this account."),
  },
});

registry.registerPath({
  method: "get",
  path: "/api/v1/publishers",
  tags: ["Publishers"],
  summary: "List publishers",
  description: "Lists the current account's publishers (domains).",
  security: bearerSecurity,
  parameters: [filterParam("status", "Limit results to publishers in this state (PENDING, VERIFIED, LAPSED).")],
  responses: {
    "200": domainResponse(publisher.ListResponse, "The account's publishers."),
    ...commonErrors,
  },
});

registry.registerPath({
  method: "get",
  path: "/api/v1/publishers/{id}",
  tags: ["Publishers"],
  summary: "Get a publisher by id",
  security: bearerSecurity,
  request: { params: publisherIdParam },
  responses: {
    "200": domainResponse(publisher.Response, "The requested publisher."),
    ...commonErrors,
  },
});

registry.registerPath({
  method: "put",
  path: "/api/v1/publishers/{id}",
  tags: ["Publishers"],
  summary: "Update a publisher's icon",
  description: "Admin-only. Sets whether the publisher displays a domain-initial monogram or its favicon. The domain itself is immutable.",
  security: bearerSecurity,
  request: { params: publisherIdParam, body: domainBody(publisherUpdate, "The icon preference to set.") },
  responses: {
    "200": domainResponse(publisher.Response, "The updated publisher."),
    ...commonErrors,
  },
});

registry.registerPath({
  method: "post",
  path: "/api/v1/publishers/{id}/actions/verify",
  tags: ["Publishers"],
  summary: "Verify a publisher's domain",
  description:
    "Admin-only. Checks the domain's DNS TXT records now — at both the domain root and the `_smplmark-verify` subdomain — for the verification token, and updates the publisher's status accordingly.",
  security: bearerSecurity,
  request: { params: publisherIdParam },
  responses: {
    "200": domainResponse(publisher.Response, "The publisher, with its updated verification status."),
    ...commonErrors,
  },
});

registry.registerPath({
  method: "delete",
  path: "/api/v1/publishers/{id}",
  tags: ["Publishers"],
  summary: "Delete a publisher",
  description:
    "Admin-only. Allowed even if a published benchmark references it — that benchmark keeps its frozen attribution badge; only future publishes are affected.",
  security: bearerSecurity,
  request: { params: publisherIdParam },
  responses: {
    "204": { description: "The publisher was deleted." },
    ...commonErrors,
  },
});

// ── Document assembly ────────────────────────────────────────────────────────

/**
 * Builds the full OpenAPI 3.0.3 document for the given public origin. Pure: no I/O, no top-level
 * await. `serverUrl` is the public origin, e.g. "https://www.smplmark.org".
 */
export function buildOpenApiDocument(serverUrl: string): Record<string, unknown> {
  const generator = new OpenApiGeneratorV3(registry.definitions);
  const document = generator.generateDocument({
    openapi: "3.0.3",
    info: {
      title: "smplmark API",
      version: "1.0.0",
      description:
        "The smplmark benchmark-hosting API. Publish benchmarks, upload measurements, and read any published benchmark's data as JSON or CSV.",
    },
    servers: [{ url: serverUrl }],
    // Alphabetized tag list.
    tags: [
      { name: "Account members" },
      { name: "Accounts" },
      { name: "API keys" },
      { name: "Auth" },
      { name: "Benchmarks" },
      { name: "Contact" },
      { name: "External sources" },
      { name: "Invitations" },
      { name: "Measurements" },
      { name: "Metrics" },
      { name: "Publishers" },
      { name: "Runs" },
      { name: "Subject types" },
      { name: "Subjects" },
      { name: "Users" },
    ],
  });

  return document as unknown as Record<string, unknown>;
}
