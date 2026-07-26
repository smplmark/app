import { describe, expect, it } from "vitest";
import { BadRequestError } from "../../src/errors";
import {
  JSONAPI_CONTENT_TYPE,
  collectionResponse,
  errorResponse,
  resourceResponse,
  type ResourceObject,
} from "../../src/http/jsonapi";

const R: ResourceObject = { type: "benchmark", id: "1", attributes: { key: "k" } };

describe("resourceResponse", () => {
  it("defaults to 200 with the JSON:API media type", async () => {
    const res = resourceResponse(R);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe(JSONAPI_CONTENT_TYPE);
    expect(await res.json()).toEqual({ data: R });
  });

  it("honours status, meta, and extra headers", async () => {
    const res = resourceResponse(R, {
      status: 201,
      meta: { secret: "s" },
      headers: { "X-Test": "1" },
    });
    expect(res.status).toBe(201);
    expect(res.headers.get("X-Test")).toBe("1");
    expect(await res.json()).toEqual({ data: R, meta: { secret: "s" } });
  });
});

describe("collectionResponse", () => {
  it("emits a bare data array when no meta is given", async () => {
    const res = collectionResponse([R]);
    expect(await res.json()).toEqual({ data: [R] });
  });

  it("includes meta and headers when provided", async () => {
    const res = collectionResponse([R], {
      meta: { pagination: { page: 1, size: 1000 } },
      headers: { Vary: "Accept" },
    });
    expect(res.headers.get("Vary")).toBe("Accept");
    expect(await res.json()).toEqual({
      data: [R],
      meta: { pagination: { page: 1, size: 1000 } },
    });
  });
});

describe("errorResponse", () => {
  it("renders an AppError", async () => {
    const res = errorResponse(new BadRequestError("bad"));
    expect(res.status).toBe(400);
    expect(res.headers.get("Content-Type")).toBe(JSONAPI_CONTENT_TYPE);
    expect(await res.json()).toEqual({
      errors: [{ status: "400", title: "Bad Request", detail: "bad" }],
    });
  });

  it("renders an unexpected error as a 500", async () => {
    const res = errorResponse(new Error("boom"));
    expect(res.status).toBe(500);
  });
});
