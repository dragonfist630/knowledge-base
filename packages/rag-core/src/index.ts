/**
 * @kb/rag-core
 *
 * Pure, framework-free RAG functions: the markdown-aware token chunker,
 * the citation-stream parser, and the prompt builder. No Nest, no Supabase
 * client, no network calls — just input in, output out, which is what makes
 * this package unit-testable and reusable from a future worker process.
 *
 * Phase 0 only wires up the package (build, typecheck, workspace linking).
 * The real contents land in Phase 4 (chunker.ts) and Phase 5
 * (citations.ts, prompt.ts).
 */

export const KB_RAG_CORE_VERSION = "0.0.0-phase0";
