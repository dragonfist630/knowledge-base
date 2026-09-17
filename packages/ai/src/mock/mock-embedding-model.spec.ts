import { describe, expect, it } from "vitest";

import { runEmbeddingModelContract } from "../contract.js";
import { hashEmbed, MockEmbeddingModel } from "./mock-embedding-model.js";

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) {
    dot += (a[i] ?? 0) * (b[i] ?? 0);
  }
  return dot; // both vectors are already L2-normalized, so dot product == cosine similarity
}

describe("MockEmbeddingModel", () => {
  describe("contract", () => runEmbeddingModelContract(() => new MockEmbeddingModel()));

  it("hashEmbed is deterministic", () => {
    const a = hashEmbed("the quick brown fox jumps over the lazy dog");
    const b = hashEmbed("the quick brown fox jumps over the lazy dog");
    expect(a).toEqual(b);
  });

  it("hashEmbed returns L2-normalized vectors", () => {
    const vector = hashEmbed("some reasonably long sentence with several distinct words in it");
    const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
    expect(norm).toBeCloseTo(1, 5);
  });

  it("similar text scores higher cosine similarity than unrelated text", () => {
    const a = hashEmbed("cats are wonderful furry pets that purr");
    const b = hashEmbed("cats are lovely furry pets that purr loudly");
    const c = hashEmbed("quarterly tax filings are due next month");

    const simAB = cosineSimilarity(a, b);
    const simAC = cosineSimilarity(a, c);
    expect(simAB).toBeGreaterThan(simAC);
  });

  it("returns 1536-dimension vectors by default", async () => {
    const model = new MockEmbeddingModel();
    const { vectors } = await model.embed(["hello world"]);
    expect(vectors[0]).toHaveLength(1536);
  });
});
