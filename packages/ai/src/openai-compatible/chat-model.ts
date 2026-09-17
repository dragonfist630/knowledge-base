import OpenAI from "openai";
import { countTokens } from "gpt-tokenizer";

import type {
  CallOptions,
  ChatCompletion,
  ChatMessage,
  ChatModel,
  ChatStreamPart,
  FinishReason,
  ModelDescriptor,
  TokenUsage,
} from "../types.js";
import type { ProviderCapabilities } from "../presets.js";
import { AiError } from "../errors.js";
import { withRetry } from "../retry.js";
import { mapOpenAiError } from "./map-error.js";

export interface OpenAiCompatibleChatModelOptions {
  provider: string;
  model: string;
  baseUrl: string;
  apiKey?: string;
  capabilities: ProviderCapabilities;
  /** AI_CHAT_SUPPORTS_TEMPERATURE — some providers/models reject `temperature`. */
  supportsTemperature: boolean;
  requestTimeoutMs: number;
  maxRetries: number;
}

function mapFinishReason(reason: string | null | undefined): FinishReason {
  switch (reason) {
    case "stop":
      return "stop";
    case "length":
      return "length";
    default:
      // content_filter, tool_calls, function_call, null (still streaming), etc.
      return "other";
  }
}

/**
 * Implements ChatModel against any OpenAI-compatible /chat/completions
 * endpoint. This file (and embedding-model.ts / map-error.ts beside it) is
 * the ONLY place in the repo allowed to import the `openai` SDK — enforced
 * by both an eslint rule and Gate 2's grep check.
 */
export class OpenAiCompatibleChatModel implements ChatModel {
  readonly descriptor: ModelDescriptor;
  private readonly client: OpenAI;
  private readonly capabilities: ProviderCapabilities;
  private readonly supportsTemperature: boolean;
  private readonly maxRetries: number;

  constructor(opts: OpenAiCompatibleChatModelOptions) {
    this.descriptor = { provider: opts.provider, model: opts.model, baseUrl: opts.baseUrl };
    this.capabilities = opts.capabilities;
    this.supportsTemperature = opts.supportsTemperature;
    this.maxRetries = opts.maxRetries;
    this.client = new OpenAI({
      apiKey: opts.apiKey ?? "not-needed",
      baseURL: opts.baseUrl,
      timeout: opts.requestTimeoutMs,
      // retry.ts owns retries, so behavior (backoff, jitter, which codes
      // retry) is identical across every provider instead of the SDK's own.
      maxRetries: 0,
    });
  }

  private buildParams(
    messages: ChatMessage[],
    opts: CallOptions,
    stream: boolean,
  ): OpenAI.Chat.ChatCompletionCreateParams {
    const params: OpenAI.Chat.ChatCompletionCreateParams = {
      model: this.descriptor.model,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      stream,
    };
    if (opts.maxOutputTokens !== undefined) {
      params.max_tokens = opts.maxOutputTokens;
    }
    if (opts.temperature !== undefined && this.supportsTemperature) {
      params.temperature = opts.temperature;
    }
    if (stream && this.capabilities.streamUsage) {
      params.stream_options = { include_usage: true };
    }
    return params;
  }

  private estimateUsage(messages: ChatMessage[], completionText: string): TokenUsage {
    const promptTokens = countTokens(messages.map((m) => m.content).join("\n"));
    const completionTokens = countTokens(completionText);
    return { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens, estimated: true };
  }

  async complete(messages: ChatMessage[], opts: CallOptions = {}): Promise<ChatCompletion> {
    return withRetry(
      async () => {
        try {
          const response = (await this.client.chat.completions.create(
            this.buildParams(messages, opts, false) as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming,
            { signal: opts.signal },
          )) as OpenAI.Chat.ChatCompletion;
          const choice = response.choices[0];
          if (!choice) {
            throw new AiError("invalid_response", `${this.descriptor.provider} returned no choices.`, {
              provider: this.descriptor.provider,
            });
          }
          const text = choice.message?.content ?? "";
          const usage: TokenUsage = response.usage
            ? {
                promptTokens: response.usage.prompt_tokens,
                completionTokens: response.usage.completion_tokens,
                totalTokens: response.usage.total_tokens,
                estimated: false,
              }
            : this.estimateUsage(messages, text);
          return { text, usage, finishReason: mapFinishReason(choice.finish_reason) };
        } catch (error) {
          throw mapOpenAiError(error, this.descriptor.provider);
        }
      },
      { maxRetries: this.maxRetries, signal: opts.signal },
    );
  }

  async *stream(messages: ChatMessage[], opts: CallOptions = {}): AsyncIterable<ChatStreamPart> {
    let text = "";
    let finishReason: FinishReason = "other";
    let sawUsage = false;

    try {
      const streamResponse = await withRetry(
        async () => {
          try {
            return await this.client.chat.completions.create(
              this.buildParams(messages, opts, true) as OpenAI.Chat.ChatCompletionCreateParamsStreaming,
              { signal: opts.signal },
            );
          } catch (error) {
            // Map to AiError *before* it reaches withRetry's catch — withRetry
            // only retries AiErrors whose `.retryable` is true (isAiError()
            // is false for a raw SDK error), so without this the initial
            // connection attempt for a stream would never actually retry on
            // rate_limit/unavailable/timeout, silently defeating maxRetries
            // for the entire streaming path. complete() already does this;
            // stream() previously didn't, and only mapped the error in the
            // outer catch below — by which point withRetry had already given
            // up after a single attempt.
            throw mapOpenAiError(error, this.descriptor.provider);
          }
        },
        { maxRetries: this.maxRetries, signal: opts.signal },
      );

      for await (const chunk of streamResponse) {
        if (opts.signal?.aborted) {
          yield { type: "finish", usage: this.estimateUsage(messages, text), finishReason: "aborted" };
          return;
        }

        const choice = chunk.choices[0];
        const delta = choice?.delta?.content;
        if (delta) {
          text += delta;
          yield { type: "text-delta", text: delta };
        }
        if (choice?.finish_reason) {
          finishReason = mapFinishReason(choice.finish_reason);
        }
        if (chunk.usage) {
          sawUsage = true;
          yield {
            type: "finish",
            usage: {
              promptTokens: chunk.usage.prompt_tokens,
              completionTokens: chunk.usage.completion_tokens,
              totalTokens: chunk.usage.total_tokens,
              estimated: false,
            },
            finishReason,
          };
          return;
        }
      }
    } catch (error) {
      if (opts.signal?.aborted) {
        yield { type: "finish", usage: this.estimateUsage(messages, text), finishReason: "aborted" };
        return;
      }
      throw mapOpenAiError(error, this.descriptor.provider);
    }

    if (!sawUsage) {
      // Some HTTP stacks close the response body cleanly on abort rather
      // than rejecting the read — the `for await` above then ends as if the
      // stream simply finished, without ever revisiting the per-iteration
      // aborted check or throwing into the catch block. Re-check here so an
      // abort is never misreported as a normal "stop"/"length"/"other"
      // finish just because it happened to land between chunks.
      const effectiveFinishReason: FinishReason = opts.signal?.aborted ? "aborted" : finishReason;
      // Provider doesn't support stream_options.include_usage (or we didn't
      // ask, per capabilities) — estimate from what we actually emitted.
      yield { type: "finish", usage: this.estimateUsage(messages, text), finishReason: effectiveFinishReason };
    }
  }
}
