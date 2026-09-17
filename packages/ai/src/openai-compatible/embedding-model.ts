import OpenAI from "openai";
import { countTokens } from "gpt-tokenizer";

import type { CallOptions, EmbeddingModel, ModelDescriptor, TokenUsage } from "../types.js";
import type { ProviderCapabilities } from "../presets.js";
import { AiError } from "../errors.js";
import { withRetry } from "../retry.js";
import { mapOpenAiError } from "./map-error.js";

export interface OpenAiCompatibleEmbeddingModelOptions {
  provider: string;
  model: string;
  baseUrl: string;
  apiKey?: string;
  capabilities: ProviderCapabilities;
  dimensions: number;
  requestTimeoutMs: number;
  maxRetries: number;
  /** Inputs per request. Configurable mainly for tests. */
  batchSize?: number;
  /** Concurrent in-flight batch requests. */
  concurrency?: number;
}

interface Batch {
  inputs: string[];
}

interface BatchResult {
  vectors: number[][];
  usage: TokenUsage;
}

const DEFAULT_BATCH_SIZE = 96;
const DEFAULT_CONCURRENCY = 3;

export class OpenAiCompatibleEmbeddingModel implements EmbeddingModel {
  readonly descriptor: ModelDescriptor & { dimensions: number };
  private readonly client: OpenAI;
  private readonly capabilities: ProviderCapabilities;
  private readonly maxRetries: number;
  private readonly batchSize: number;
  private readonly concurrency: number;

  constructor(opts: OpenAiCompatibleEmbeddingModelOptions) {
    this.descriptor = {
      provider: opts.provider,
      model: opts.model,
      baseUrl: opts.baseUrl,
      dimensions: opts.dimensions,
    };
    this.capabilities = opts.capabilities;
    this.maxRetries = opts.maxRetries;
    this.batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
    this.concurrency = opts.concurrency ?? DEFAULT_CONCURRENCY;
    this.client = new OpenAI({
      apiKey: opts.apiKey ?? "not-needed",
      baseURL: opts.baseUrl,
      timeout: opts.requestTimeoutMs,
      maxRetries: 0,
    });
  }

  async embed(
    inputs: string[],
    opts: CallOptions = {},
  ): Promise<{ vectors: number[][]; usage: TokenUsage }> {
    if (inputs.length === 0) {
      throw new AiError("bad_request", "embed() requires at least one input.", {
        provider: this.descriptor.provider,
      });
    }

    const batches: Batch[] = [];
    for (let i = 0; i < inputs.length; i += this.batchSize) {
      batches.push({ inputs: inputs.slice(i, i + this.batchSize) });
    }

    const results = new Array<BatchResult>(batches.length);
    let cursor = 0;
    const runWorker = async (): Promise<void> => {
      for (;;) {
        const index = cursor;
        cursor += 1;
        if (index >= batches.length) {
          return;
        }
        const batch = batches[index]!;
        results[index] = await withRetry(() => this.embedBatch(batch, opts), {
          maxRetries: this.maxRetries,
          signal: opts.signal,
        });
      }
    };

    const workerCount = Math.min(this.concurrency, batches.length);
    await Promise.all(Array.from({ length: workerCount }, () => runWorker()));

    const vectors = results.flatMap((r) => r.vectors);
    const usage = results.reduce<TokenUsage>(
      (acc, r) => ({
        promptTokens: acc.promptTokens + r.usage.promptTokens,
        completionTokens: acc.completionTokens + r.usage.completionTokens,
        totalTokens: acc.totalTokens + r.usage.totalTokens,
        estimated: acc.estimated || r.usage.estimated,
      }),
      { promptTokens: 0, completionTokens: 0, totalTokens: 0, estimated: false },
    );

    if (vectors.length !== inputs.length) {
      throw new AiError(
        "invalid_response",
        `${this.descriptor.provider} returned ${vectors.length} vectors for ${inputs.length} inputs.`,
        { provider: this.descriptor.provider },
      );
    }
    for (const vector of vectors) {
      if (vector.length !== this.descriptor.dimensions) {
        throw new AiError(
          "invalid_response",
          `${this.descriptor.provider} returned a ${vector.length}-dimension vector, expected ${this.descriptor.dimensions}.`,
          { provider: this.descriptor.provider },
        );
      }
    }

    return { vectors, usage };
  }

  private async embedBatch(batch: Batch, opts: CallOptions): Promise<BatchResult> {
    try {
      const params: OpenAI.Embeddings.EmbeddingCreateParams = {
        model: this.descriptor.model,
        input: batch.inputs,
      };
      if (this.capabilities.embeddingDimensionsParam) {
        params.dimensions = this.descriptor.dimensions;
      }
      const response = await this.client.embeddings.create(params, { signal: opts.signal });
      const vectors = [...response.data].sort((a, b) => a.index - b.index).map((d) => d.embedding);
      const usage: TokenUsage = response.usage
        ? {
            promptTokens: response.usage.prompt_tokens,
            completionTokens: 0,
            totalTokens: response.usage.total_tokens,
            estimated: false,
          }
        : this.estimateUsage(batch.inputs);
      return { vectors, usage };
    } catch (error) {
      throw mapOpenAiError(error, this.descriptor.provider);
    }
  }

  private estimateUsage(inputs: string[]): TokenUsage {
    const promptTokens = inputs.reduce((sum, input) => sum + countTokens(input), 0);
    return { promptTokens, completionTokens: 0, totalTokens: promptTokens, estimated: true };
  }
}
