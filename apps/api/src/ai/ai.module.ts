import { Global, Module } from "@nestjs/common";
import { createAi } from "@kb/ai";
import type { Ai } from "@kb/ai";

export const AI = Symbol("AI");
export const CHAT_MODEL = Symbol("CHAT_MODEL");
export const EMBEDDING_MODEL = Symbol("EMBEDDING_MODEL");

/**
 * Wires @kb/ai into Nest's DI container once, at boot: `createAi(process.env)`
 * already validates the AI_* env (throwing one aggregated AiError if
 * anything's wrong — see @kb/ai/config.ts), so a broken AI config fails
 * exactly like a broken apps/api config does, at startup rather than on the
 * first chat request. Global so retrieval/chat (Phase 5) can inject
 * CHAT_MODEL/EMBEDDING_MODEL without importing this module by hand.
 *
 * `createAi` is called exactly once (the AI provider below) — CHAT_MODEL,
 * EMBEDDING_MODEL, and GET /meta/ai's descriptors all come from that same
 * instance, so there's one OpenAI client per model, not three.
 */
@Global()
@Module({
  providers: [
    { provide: AI, useFactory: (): Ai => createAi(process.env) },
    { provide: CHAT_MODEL, useFactory: (ai: Ai): Ai["chat"] => ai.chat, inject: [AI] },
    { provide: EMBEDDING_MODEL, useFactory: (ai: Ai): Ai["embeddings"] => ai.embeddings, inject: [AI] },
  ],
  exports: [AI, CHAT_MODEL, EMBEDDING_MODEL],
})
export class AiModule {}
