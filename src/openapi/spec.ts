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

// ── sample_schema (nested value object on benchmark) ─────────────────────────

const X_KINDS = ["TIME", "NUMBER", "CATEGORY"] as const;

const MetricDecl = z
  .object({
    name: z.string().openapi({ description: "The metric's identifier, used as its key in observation payloads." }),
    type: z.string().openapi({ description: "The value type of the metric, e.g. \"number\"." }),
    unit: z.string().optional().openapi({ description: "A display unit for the metric, e.g. \"ms\" or \"tokens\"." }),
    description: z.string().optional().openapi({ description: "A human-readable explanation of what the metric measures." }),
  })
  .openapi("MetricDecl", { description: "A metric a client supplies directly on each observation." });

const DerivedDecl = z
  .object({
    name: z.string().openapi({ description: "The derived metric's identifier, as it appears in the computed metrics map." }),
    expr: jsonObject(
      "A JSON Logic expression evaluated on read against the observation and its run context (e.g. elapsed_ms = created_at − run.started_at).",
    ),
    unit: z.string().optional().openapi({ description: "A display unit for the derived value, e.g. \"ms\"." }),
    description: z.string().optional().openapi({ description: "A human-readable explanation of what the derived value represents." }),
  })
  .openapi("DerivedDecl", { description: "A metric computed when an observation is read, from other metrics and run context." });

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

const SampleSchema = registry.register(
  "SampleSchema",
  z
    .object({
      metrics: z.array(MetricDecl).openapi({ description: "The metrics clients supply on each observation." }),
      derived: z.array(DerivedDecl).openapi({ description: "Metrics computed on read from stored metrics and run context." }),
      chart: ChartDecl.optional(),
    })
    .openapi({
      description:
        "The shape of the benchmark's observations. Stored and derived metrics are merged into one map; the derived values are computed when the observation is read.",
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

const account = registerEntity(
  "Account",
  "account",
  z.object({
    key: z.string().openapi({ description: "The account's human-readable, URL-safe identifier." }),
    name: z.string().openapi({ description: "The account's display name." }),
    description: z.string().nullable().openapi({ description: "A short description of the account, or null." }),
    url: z.string().nullable().openapi({ description: "The account's website URL, or null." }),
    allow_personal_publish: z.boolean().openapi({ description: "Whether members may publish their own benchmarks under their personal identity without an admin. When false, publishing is routed through an admin." }),
    created_at: dateTime("When the account was created."),
  }),
  z.object({
    name: z.string().openapi({ description: "The account's display name." }),
    description: z.string().nullable().openapi({ description: "A short description of the account." }),
    url: z.string().nullable().openapi({ description: "The account's website URL." }),
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
      .enum(["PERSONAL", "ORGANIZATION"])
      .openapi({ description: "How the benchmark is attributed: PERSONAL (its author) or ORGANIZATION (a publisher identity)." }),
    identity: z.string().nullable().optional().openapi({ description: "The publisher identity the benchmark was published under (ORGANIZATION only). Null if that identity has since been deleted." }),
    name: z.string().optional().openapi({ description: "The organization brand name captured at publish (ORGANIZATION only)." }),
    logo_url: z.string().nullable().optional().openapi({ description: "The organization logo captured at publish (ORGANIZATION only), or null." }),
    verified_domains: z.array(z.string()).optional().openapi({ description: "The domains that were verified at the instant of publish (ORGANIZATION only)." }),
    display_name: z.string().nullable().optional().openapi({ description: "The author's display name captured at publish (PERSONAL only), or null." }),
    gravatar_hash: z.string().optional().openapi({ description: "A SHA-256 hash of the author's email captured at publish (PERSONAL only), for rendering an avatar." }),
  })
  .openapi("PublishedAs", {
    description:
      "The attribution badge for a published benchmark, frozen at the moment of publishing. Rendered from this snapshot, never a live lookup, so it is unaffected if a domain later lapses or the identity is deleted.",
  });

const benchmark = registerEntity(
  "Benchmark",
  "benchmark",
  z.object({
    account: idRef("The account that owns the benchmark."),
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
    sample_schema: SampleSchema,
    created_at: dateTime("When the benchmark was created."),
    updated_at: dateTime("When the benchmark was last updated."),
  }),
  z.object({
    key: z.string().openapi({ description: "The benchmark's human-readable, URL-safe identifier." }),
    name: z.string().openapi({ description: "The benchmark's display name." }),
    description: z.string().optional().openapi({ description: "A one-line summary of the benchmark." }),
    about: z.string().optional().openapi({ description: "A longer description of the benchmark." }),
    methodology: z.string().optional().openapi({ description: "How the benchmark is run and measured." }),
    sample_schema: SampleSchema.optional(),
  }),
);

const target = registerEntity(
  "Target",
  "target",
  z.object({
    benchmark: idRef("The benchmark this target belongs to."),
    key: z.string().openapi({ description: "The target's human-readable identifier, unique within its benchmark." }),
    name: z.string().openapi({ description: "The target's display name." }),
    details: z.record(z.unknown()).nullable().openapi({ description: "Arbitrary structured metadata about the target, or null.", type: "object" }),
    created_at: dateTime("When the target was created."),
    updated_at: dateTime("When the target was last updated."),
  }),
  z.object({
    benchmark: idRef("The benchmark to attach the target to."),
    key: z.string().openapi({ description: "The target's human-readable identifier." }),
    name: z.string().openapi({ description: "The target's display name." }),
    details: z.record(z.unknown()).optional().openapi({ description: "Arbitrary structured metadata about the target.", type: "object" }),
  }),
);

const run = registerEntity(
  "Run",
  "run",
  z.object({
    target: idRef("The target this run belongs to."),
    key: z.string().openapi({ description: "The run's human-readable identifier, unique within its target." }),
    name: z.string().nullable().openapi({ description: "The run's display name, or null." }),
    details: z.record(z.unknown()).nullable().openapi({ description: "Arbitrary structured metadata about the run, or null.", type: "object" }),
    started_at: dateTime("When the run started, or null if not yet started.").nullable(),
    ended_at: dateTime("When the run ended, or null if still live.").nullable(),
    live: z.boolean().openapi({ description: "Whether the run is still accepting observations." }),
    invalidated: z.boolean().openapi({ description: "Whether the run has been marked invalid and excluded from results." }),
    invalidated_at: dateTime("When the run was invalidated, or null.").nullable(),
    invalidation_reason: z.string().nullable().openapi({ description: "The stated reason the run was invalidated, or null." }),
    invalidated_by_user: z.string().nullable().openapi({ description: "The user who invalidated the run, or null." }),
    created_at: dateTime("When the run was created."),
    updated_at: dateTime("When the run was last updated."),
  }),
  z.object({
    target: idRef("The target to attach the run to."),
    key: z.string().openapi({ description: "The run's human-readable identifier." }),
    name: z.string().optional().openapi({ description: "The run's display name." }),
    details: z.record(z.unknown()).optional().openapi({ description: "Arbitrary structured metadata about the run.", type: "object" }),
    started_at: dateTime("When the run started. Defaults to the time of creation.").optional(),
  }),
);

const observation = registerEntity(
  "Observation",
  "observation",
  z.object({
    run: idRef("The run this observation belongs to."),
    created_at: dateTime("When the observation was recorded."),
    metrics: z
      .record(z.number())
      .optional()
      .openapi({
        description:
          "A flat map of metric name to numeric value. Stored and derived metrics are merged into one map; the derived values are computed when the observation is read.",
        type: "object",
      }),
    meta: jsonObject("Arbitrary structured metadata attached to the observation.").optional(),
  }),
  z.object({
    run: idRef("The run to attach the observation to."),
    created_at: dateTime("When the observation occurred. Defaults to the time of ingest.").optional(),
    metrics: z
      .record(z.number())
      .optional()
      .openapi({ description: "A flat map of stored metric name to numeric value.", type: "object" }),
    meta: jsonObject("Arbitrary structured metadata to attach to the observation.").optional(),
  }),
);

const publisherIdentity = registerEntity(
  "PublisherIdentity",
  "publisher_identity",
  z.object({
    account: idRef("The account that owns this publisher identity."),
    key: z.string().openapi({ description: "The identity's human-readable, URL-safe handle, unique within the account." }),
    name: z.string().openapi({ description: "The organization's display brand name, e.g. \"Microsoft\"." }),
    logo_url: z.string().nullable().openapi({ description: "A URL to the organization's logo, or null." }),
    created_at: dateTime("When the identity was created."),
    updated_at: dateTime("When the identity was last updated."),
  }),
  z.object({
    key: z.string().openapi({ description: "The identity's human-readable, URL-safe handle." }),
    name: z.string().openapi({ description: "The organization's display brand name." }),
    logo_url: z.string().nullable().optional().openapi({ description: "A URL to the organization's logo." }),
  }),
);

const publisherDomain = registerEntity(
  "PublisherDomain",
  "publisher_domain",
  z.object({
    account: idRef("The account that owns this domain claim."),
    publisher_identity: idRef("The publisher identity this domain belongs to."),
    domain: z.string().openapi({ description: "The exact registrable domain being claimed, e.g. \"microsoft.com\" (no subdomain inference)." }),
    status: z
      .enum(["PENDING", "VERIFIED", "LAPSED"])
      .openapi({ description: "The domain's verification state. PENDING awaits a successful check; VERIFIED has proven ownership; LAPSED was verified but the record has since disappeared." }),
    verification_token: z.string().openapi({ description: "The TXT record value to add to your domain's DNS to prove ownership. Add a TXT record whose value is exactly this string, then run the verify action." }),
    verified: z.boolean().openapi({ description: "Whether the domain is currently verified." }),
    verified_at: dateTime("When the domain was last verified, or null if it has never verified.").nullable(),
    last_checked_at: dateTime("When the domain was last checked, or null if it has never been checked.").nullable(),
    created_at: dateTime("When the domain claim was created."),
  }),
  z.object({
    publisher_identity: idRef("The publisher identity to add the domain to."),
    domain: z.string().openapi({ description: "The exact registrable domain to claim, e.g. \"microsoft.com\"." }),
  }),
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
  summary: "Revoke an API key",
  security: bearerSecurity,
  request: { params: z.object({ id: z.string().openapi({ param: { name: "id", in: "path" }, description: "The id of the API key." }) }) },
  responses: {
    "204": { description: "The key was revoked." },
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
    "409": errorJson("A benchmark with that key already exists in the account."),
  },
});

registry.registerPath({
  method: "get",
  path: "/api/v1/benchmarks",
  tags: ["Benchmarks"],
  summary: "List benchmarks",
  parameters: [
    filterParam("account", "Limit results to benchmarks owned by this account id."),
    filterParam("key", "Limit results to the benchmark with this key."),
    ...paginationParams,
  ],
  responses: {
    "200": domainResponse(benchmark.ListResponse, "A page of benchmarks."),
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
    "Makes the benchmark and its data publicly readable, attributing it either to an organization identity (pass publisher_identity, admin only) or to the author personally (omit it, when the account allows personal publishing). The benchmark must be marked ready first, and requires a signed-in user — API keys cannot publish.",
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
              publisher_identity: z
                .string()
                .optional()
                .openapi({ description: "The publisher identity to attribute the benchmark to. Omit (or pass \"self\") to publish under the author's personal identity." }),
            })
            .openapi("BenchmarkPublishRequest", { description: "How to attribute the published benchmark." }),
        },
      },
    },
  },
  responses: {
    "200": domainResponse(benchmark.Response, "The published benchmark."),
    ...commonErrors,
    "409": errorJson("The benchmark cannot be published from its current state, or the chosen organization identity has no verified domain."),
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

// ── Paths: Targets ───────────────────────────────────────────────────────────

const targetIdParam = z.object({
  id: z.string().openapi({ param: { name: "id", in: "path" }, description: "The id of the target." }),
});

registry.registerPath({
  method: "post",
  path: "/api/v1/targets",
  tags: ["Targets"],
  summary: "Create a target",
  security: bearerSecurity,
  request: { body: domainBody(target.Request, "The target to create.") },
  responses: {
    "201": domainResponse(target.Response, "The created target."),
    ...commonErrors,
    "409": errorJson("A target with that key already exists in the benchmark."),
  },
});

registry.registerPath({
  method: "get",
  path: "/api/v1/targets",
  tags: ["Targets"],
  summary: "List targets",
  parameters: [
    filterParam("benchmark", "Limit results to targets of this benchmark id.", true),
    filterParam("key", "Limit results to the target with this key."),
    ...paginationParams,
  ],
  responses: {
    "200": domainResponse(target.ListResponse, "A page of targets."),
    "400": errorJson("The query parameters were malformed or filter[benchmark] was missing."),
  },
});

registry.registerPath({
  method: "get",
  path: "/api/v1/targets/{id}",
  tags: ["Targets"],
  summary: "Get a target by id",
  request: { params: targetIdParam },
  responses: {
    "200": domainResponse(target.Response, "The requested target."),
    "404": errorJson("The requested resource was not found."),
  },
});

registry.registerPath({
  method: "put",
  path: "/api/v1/targets/{id}",
  tags: ["Targets"],
  summary: "Update a target",
  security: bearerSecurity,
  request: { params: targetIdParam, body: domainBody(target.Request, "The updated target.") },
  responses: {
    "200": domainResponse(target.Response, "The updated target."),
    ...commonErrors,
  },
});

registry.registerPath({
  method: "delete",
  path: "/api/v1/targets/{id}",
  tags: ["Targets"],
  summary: "Delete a target",
  security: bearerSecurity,
  request: { params: targetIdParam },
  responses: {
    "204": { description: "The target was deleted." },
    ...commonErrors,
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
    "409": errorJson("A run with that key already exists in the target."),
  },
});

registry.registerPath({
  method: "get",
  path: "/api/v1/runs",
  tags: ["Runs"],
  summary: "List runs",
  parameters: [
    filterParam("target", "Limit results to runs of this target id.", true),
    filterParam("key", "Limit results to the run with this key."),
    ...paginationParams,
  ],
  responses: {
    "200": domainResponse(run.ListResponse, "A page of runs."),
    "400": errorJson("The query parameters were malformed or filter[target] was missing."),
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
  },
});

registry.registerPath({
  method: "post",
  path: "/api/v1/runs/{id}/actions/end",
  tags: ["Runs"],
  summary: "End a run",
  description: "Marks the run as no longer live; it stops accepting new observations.",
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
    body: domainBody(
      z
        .object({
          invalidation_reason: z
            .string()
            .optional()
            .openapi({ description: "An optional reason the run is being invalidated." }),
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

// ── Paths: Observations ──────────────────────────────────────────────────────

registry.registerPath({
  method: "post",
  path: "/api/v1/observations",
  tags: ["Observations"],
  summary: "Record an observation",
  security: bearerSecurity,
  request: { body: domainBody(observation.Request, "The observation to record.") },
  responses: {
    "201": domainResponse(observation.Response, "The recorded observation, with derived metrics computed."),
    ...commonErrors,
  },
});

registry.registerPath({
  method: "get",
  path: "/api/v1/observations",
  tags: ["Observations"],
  summary: "List observations",
  description:
    "Reads observations for exactly one of a run, target, or benchmark. With an Accept header of text/csv, the response is a CSV export of the same data.",
  parameters: [
    filterParam("run", "Read observations for this run id. Provide exactly one of filter[run], filter[target], or filter[benchmark]."),
    filterParam("target", "Read observations for this target id. Provide exactly one of filter[run], filter[target], or filter[benchmark]."),
    filterParam("benchmark", "Read observations for this benchmark id. Provide exactly one of filter[run], filter[target], or filter[benchmark]."),
    filterParam(
      "created_at",
      "Restrict to a time interval using the grammar [start,end) — a half-open range where start is inclusive and end is exclusive; use * for an open edge, e.g. [2026-01-01T00:00:00Z,*).",
    ),
    ...paginationParams,
  ],
  responses: {
    "200": {
      description: "A page of observations, as JSON or CSV depending on the Accept header.",
      content: {
        "application/vnd.api+json": { schema: observation.ListResponse },
        "text/csv": {
          schema: {
            type: "string",
            description: "A CSV export with one row per observation and one column per metric.",
          },
        },
      },
    },
    "400": errorJson("The query parameters were malformed, or not exactly one resource filter was provided."),
  },
});

// ── Paths: Publisher identities ──────────────────────────────────────────────

const publisherIdentityIdParam = z.object({
  id: z.string().openapi({ param: { name: "id", in: "path" }, description: "The id of the publisher identity." }),
});

registry.registerPath({
  method: "post",
  path: "/api/v1/publisher_identities",
  tags: ["Publisher identities"],
  summary: "Create a publisher identity",
  description: "Admin-only. Creates an organization brand a benchmark can later be published under.",
  security: bearerSecurity,
  request: { body: domainBody(publisherIdentity.Request, "The identity to create.") },
  responses: {
    "201": domainResponse(publisherIdentity.Response, "The created publisher identity."),
    ...commonErrors,
    "409": errorJson("A publisher identity with that key already exists in the account."),
  },
});

registry.registerPath({
  method: "get",
  path: "/api/v1/publisher_identities",
  tags: ["Publisher identities"],
  summary: "List publisher identities",
  description: "Lists the current account's publisher identities.",
  security: bearerSecurity,
  parameters: [filterParam("key", "Limit results to the identity with this key.")],
  responses: {
    "200": domainResponse(publisherIdentity.ListResponse, "The account's publisher identities."),
    ...commonErrors,
  },
});

registry.registerPath({
  method: "get",
  path: "/api/v1/publisher_identities/{id}",
  tags: ["Publisher identities"],
  summary: "Get a publisher identity by id",
  security: bearerSecurity,
  request: { params: publisherIdentityIdParam },
  responses: {
    "200": domainResponse(publisherIdentity.Response, "The requested publisher identity."),
    ...commonErrors,
  },
});

registry.registerPath({
  method: "put",
  path: "/api/v1/publisher_identities/{id}",
  tags: ["Publisher identities"],
  summary: "Update a publisher identity",
  description: "Admin-only.",
  security: bearerSecurity,
  request: { params: publisherIdentityIdParam, body: domainBody(publisherIdentity.Request, "The updated identity.") },
  responses: {
    "200": domainResponse(publisherIdentity.Response, "The updated publisher identity."),
    ...commonErrors,
    "409": errorJson("A publisher identity with that key already exists in the account."),
  },
});

registry.registerPath({
  method: "delete",
  path: "/api/v1/publisher_identities/{id}",
  tags: ["Publisher identities"],
  summary: "Delete a publisher identity",
  description:
    "Admin-only. Allowed even if a published benchmark references it — that benchmark keeps its frozen attribution badge; only future publishes are affected.",
  security: bearerSecurity,
  request: { params: publisherIdentityIdParam },
  responses: {
    "204": { description: "The publisher identity (and its domains) were deleted." },
    ...commonErrors,
  },
});

// ── Paths: Publisher domains ─────────────────────────────────────────────────

const publisherDomainIdParam = z.object({
  id: z.string().openapi({ param: { name: "id", in: "path" }, description: "The id of the publisher domain." }),
});

registry.registerPath({
  method: "post",
  path: "/api/v1/publisher_domains",
  tags: ["Publisher domains"],
  summary: "Add a domain to a publisher identity",
  description:
    "Admin-only. Returns a verification token to add to the domain's DNS as a TXT record; then call the verify action.",
  security: bearerSecurity,
  request: { body: domainBody(publisherDomain.Request, "The domain to claim.") },
  responses: {
    "201": domainResponse(publisherDomain.Response, "The created domain claim, including the token to add to DNS."),
    ...commonErrors,
    "409": errorJson("That domain is already claimed by this identity."),
  },
});

registry.registerPath({
  method: "get",
  path: "/api/v1/publisher_domains",
  tags: ["Publisher domains"],
  summary: "List publisher domains",
  description: "Lists the current account's domain claims.",
  security: bearerSecurity,
  parameters: [
    filterParam("publisher_identity", "Limit results to domains of this publisher identity id."),
    filterParam("status", "Limit results to domains in this state (PENDING, VERIFIED, LAPSED)."),
  ],
  responses: {
    "200": domainResponse(publisherDomain.ListResponse, "The account's publisher domains."),
    ...commonErrors,
  },
});

registry.registerPath({
  method: "post",
  path: "/api/v1/publisher_domains/{id}/actions/verify",
  tags: ["Publisher domains"],
  summary: "Verify a domain",
  description:
    "Admin-only. Checks the domain's DNS TXT records now for the verification token and updates the domain's status accordingly.",
  security: bearerSecurity,
  request: { params: publisherDomainIdParam },
  responses: {
    "200": domainResponse(publisherDomain.Response, "The domain, with its updated verification status."),
    ...commonErrors,
  },
});

registry.registerPath({
  method: "delete",
  path: "/api/v1/publisher_domains/{id}",
  tags: ["Publisher domains"],
  summary: "Remove a domain claim",
  description: "Admin-only.",
  security: bearerSecurity,
  request: { params: publisherDomainIdParam },
  responses: {
    "204": { description: "The domain claim was removed." },
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
        "The smplmark benchmark-hosting API. Publish benchmarks, upload observations, and read any published benchmark's data as JSON or CSV.",
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
      { name: "Invitations" },
      { name: "Observations" },
      { name: "Publisher domains" },
      { name: "Publisher identities" },
      { name: "Runs" },
      { name: "Targets" },
      { name: "Users" },
    ],
  });

  return document as unknown as Record<string, unknown>;
}
