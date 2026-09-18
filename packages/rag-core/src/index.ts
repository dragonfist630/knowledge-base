/**
 * @kb/rag-core
 *
 * Pure, framework-free RAG functions: the markdown-aware token chunker,
 * the citation-stream parser, and the prompt builder. No Nest, no Supabase
 * client, no network calls — just input in, output out, which is what makes
 * this package unit-testable and reusable from a future worker process.
 *
 * Phase 0 wired up the package (build, typecheck, workspace linking).
 * Phase 4 landed the chunker (chunker.ts). Phase 5 lands citations.ts and
 * prompt.ts.
 */

export const KB_RAG_CORE_VERSION = "0.0.0-phase0";

// Re-exported so apps/api's other real token-count consumers (retrieval's
// context-budget packing, Phase 5) don't need their own direct dependency
// on gpt-tokenizer — this package already owns "token counting" as one of
// its stated responsibilities (see the module doc comment above), and the
// chunker itself already depends on the exact same function.
export { countTokens } from "gpt-tokenizer";

export { chunkDocument } from "./chunker.js";
export type { Chunk, ChunkOptions } from "./chunker.js";

export { createCitationStreamParser } from "./citations.js";
export type { CitationParseResult, CitationStreamParser } from "./citations.js";

export { buildChatMessages, buildSystemPrompt, stripCitationMarkers } from "./prompt.js";
export type { BuildPromptOptions, HistoryTurn, PromptMessage, PromptRole, PromptSource } from "./prompt.js";
