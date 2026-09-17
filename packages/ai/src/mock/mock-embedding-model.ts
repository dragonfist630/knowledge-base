import type { CallOptions, EmbeddingModel, ModelDescriptor, TokenUsage } from "../types.js";
import { AiError } from "../errors.js";

const DIMENSIONS = 1536;

/**
 * Deterministic, dependency-free feature-hashed bag-of-words embedder.
 * Every run of the same text produces the same vector, and texts that share
 * words score more similar under cosine distance than unrelated ones — which
 * is exactly what the contract needs for demo mode and tests to be
 * meaningful without a real model. This is NOT intended to produce
 * semantically strong embeddings, only ones that behave like real ones
 * structurally (fixed dimension, L2-normalized, similar text scores higher).
 */

// FNV-1a — small, dependency-free, and stable across Node versions.
function fnv1a(str: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Very small suffix stripper — just enough to fold "runs"/"running"/"ran"-ish
 * variants toward the same bucket most of the time. Not a real stemmer. */
function stem(word: string): string {
  let w = word;
  for (const suffix of ["ing", "edly", "ed", "es", "ly", "s"]) {
    if (w.length > suffix.length + 2 && w.endsWith(suffix)) {
      w = w.slice(0, -suffix.length);
      break;
    }
  }
  return w;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0)
    .map(stem);
}

export function hashEmbed(text: string, dimensions = DIMENSIONS): number[] {
  const vector = new Array<number>(dimensions).fill(0);
  for (const token of tokenize(text)) {
    const bucket = fnv1a(token) % dimensions;
    // Sign hash too, so unrelated tokens landing in the same bucket don't
    // always constructively add — a standard feature-hashing trick.
    const sign = fnv1a(`${token}#sign`) % 2 === 0 ? 1 : -1;
    vector[bucket] = (vector[bucket] ?? 0) + sign;
  }
  const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
  if (norm === 0) {
    return vector;
  }
  return vector.map((v) => v / norm);
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

export class MockEmbeddingModel implements EmbeddingModel {
  readonly descriptor: ModelDescriptor & { dimensions: number };

  constructor(model = "mock-embedding", dimensions = DIMENSIONS) {
    this.descriptor = { provider: "mock", model, baseUrl: "mock://local", dimensions };
  }

  async embed(
    inputs: string[],
    opts: CallOptions = {},
  ): Promise<{ vectors: number[][]; usage: TokenUsage }> {
    if (opts.signal?.aborted) {
      throw new AiError("aborted", "Request aborted.", { provider: "mock" });
    }
    if (inputs.length === 0) {
      throw new AiError("bad_request", "embed() requires at least one input.", { provider: "mock" });
    }

    const vectors = inputs.map((input) => hashEmbed(input, this.descriptor.dimensions));
    const promptTokens = inputs.reduce((sum, input) => sum + estimateTokens(input), 0);

    return {
      vectors,
      usage: {
        promptTokens,
        completionTokens: 0,
        totalTokens: promptTokens,
        estimated: true,
      },
    };
  }
}
