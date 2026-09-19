import { z } from "zod";

/**
 * The shape @kb/ai's `Ai.describe()` returns, mirrored by hand (this
 * package can't import @kb/ai — see chat-events.ts's doc comment for why).
 * `apiKeyMasked` is included because the backend sends it (already masked
 * server-side, never a real key — see packages/ai/src/create-ai.ts's
 * `maskKey`), not because apps/web displays it; the provider badge only
 * shows `provider`/`model`.
 */
export const AiDescriptorSchema = z.object({
  provider: z.string(),
  model: z.string(),
  baseUrl: z.string(),
  apiKeyMasked: z.string().optional(),
});

export const AiInfoResponseSchema = z.object({
  chat: AiDescriptorSchema,
  embedding: AiDescriptorSchema.extend({ dimensions: z.number().int().positive() }),
});
export type AiInfoResponse = z.infer<typeof AiInfoResponseSchema>;
