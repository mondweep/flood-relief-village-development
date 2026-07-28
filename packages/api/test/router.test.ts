import { describe, expect, it } from "vitest";
import { json } from "../src/http-result.js";
import { Router, type RouteHandler } from "../src/router.js";

const noop: RouteHandler = async () => json(200, {});

function router(): Router {
  return new Router()
    .get("/villages", noop)
    .get("/villages/:id", noop)
    .post("/villages/:id/damage-assessments", noop)
    .post("/beneficiaries/:id/follow-ups/:followUpId/complete", noop);
}

describe("Router", () => {
  it("matches a literal path", () => {
    expect(router().match("GET", "/villages")?.params).toEqual({});
  });

  it("captures a single path parameter", () => {
    expect(router().match("GET", "/villages/village-1")?.params).toEqual({ id: "village-1" });
  });

  it("captures multiple path parameters", () => {
    const match = router().match("POST", "/beneficiaries/b-1/follow-ups/f-9/complete");

    expect(match?.params).toEqual({ id: "b-1", followUpId: "f-9" });
  });

  it("percent-decodes parameters", () => {
    expect(router().match("GET", "/villages/village%20one")?.params).toEqual({ id: "village one" });
  });

  it("tolerates trailing and duplicated slashes", () => {
    expect(router().match("GET", "/villages/")?.params).toEqual({});
    expect(router().match("GET", "//villages//village-1//")?.params).toEqual({ id: "village-1" });
  });

  it("does not match a different segment count", () => {
    expect(router().match("GET", "/villages/village-1/extra")).toBeNull();
  });

  it("is method-sensitive but reports the path exists", () => {
    const r = router();

    expect(r.match("DELETE", "/villages/village-1")).toBeNull();
    expect(r.hasPath("/villages/village-1")).toBe(true);
    expect(r.hasPath("/nope")).toBe(false);
  });

  it("treats malformed percent-encoding as a non-match rather than throwing", () => {
    expect(() => router().match("GET", "/villages/%E0%A4%A")).not.toThrow();
    expect(router().match("GET", "/villages/%E0%A4%A")).toBeNull();
  });
});
