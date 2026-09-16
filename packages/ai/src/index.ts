/**
 * @kb/ai
 *
 * The provider-agnostic AI layer. Application code depends on two small
 * interfaces (`ChatModel`, `EmbeddingModel`); which vendor sits behind them
 * is decided entirely by environment variables. This is the ONLY package
 * allowed to import the `openai` SDK (enforced by a repo-wide lint rule once
 * Phase 2 adds that dependency).
 *
 * Phase 0 only wires up the package (build, typecheck, workspace linking).
 * The real contents land in Phase 2:
 *   - types.ts, errors.ts, config.ts, presets.ts
 *   - openai-compatible/{chat-model,embedding-model,map-error}.ts
 *   - mock/{mock-chat-model,mock-embedding-model}.ts
 *   - retry.ts, create-ai.ts, contract.ts
 */

export const KB_AI_VERSION = "0.0.0-phase0";
