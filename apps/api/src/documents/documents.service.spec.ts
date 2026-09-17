import { describe, expect, it } from "vitest";

import { computeContentHash } from "./documents.service.js";

describe("computeContentHash", () => {
  it("is stable for the same title + content", () => {
    expect(computeContentHash("Title", "Body")).toBe(computeContentHash("Title", "Body"));
  });

  it("changes when content changes", () => {
    expect(computeContentHash("Title", "Body")).not.toBe(computeContentHash("Title", "Body, edited"));
  });

  it("changes when the title changes (title feeds the embedding heading path)", () => {
    expect(computeContentHash("Title", "Body")).not.toBe(computeContentHash("Title, edited", "Body"));
  });

  it("does not depend on tags at all — tags never feed the embedding", () => {
    // computeContentHash intentionally takes no tags parameter; this test
    // documents that decision so a future refactor can't accidentally widen
    // its signature and start hashing tags in.
    expect(computeContentHash.length).toBe(2);
  });

  it("does not collide title/content across the boundary (e.g. ('a','bc') vs ('ab','c'))", () => {
    expect(computeContentHash("a", "bc")).not.toBe(computeContentHash("ab", "c"));
  });
});
