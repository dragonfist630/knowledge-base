/**
 * @kb/rag-core
 *
 * Pure, framework-free RAG functions: the markdown-aware token chunker,
 * the citation-stream parser, and the prompt builder. No Nest, no Supabase
 * client, no network calls — just input in, output out, which is what makes
 * this package unit-testable and reusable from a future worker process.
 *
 * Phase 0 wired up the package (build, typecheck, workspace linking).
 * Phase 4 lands the chunker (chunker.ts). Citations and the prompt builder
 * land in Phase 5 (citations.ts, prompt.ts).
 */

export const KB_RAG_CORE_VERSION = "0.0.0-phase0";

export { chunkDocument } from "./chunker.js";
export type { Chunk, ChunkOptions } from "./chunker.js";
