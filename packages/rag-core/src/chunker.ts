import { countTokens as gptCountTokens } from "gpt-tokenizer";

/**
 * A single chunk produced by {@link chunkDocument}. Field names are
 * camelCase here (pure TS boundary); the caller (apps/api's indexing
 * service, Phase 4) is responsible for translating this into the
 * snake_case jsonb shape `replace_document_chunks` expects via
 * `jsonb_to_recordset` — see supabase/migrations/*_init.sql.
 *
 * `charStart`/`charEnd` are offsets into the ORIGINAL `content` string
 * passed to `chunkDocument` (before any internal line-ending
 * normalization), so a caller can slice the original document to
 * highlight exactly what a chunk covers.
 */
export interface Chunk {
  chunkIndex: number;
  content: string;
  headingPath: string | null;
  tokenCount: number;
  charStart: number;
  charEnd: number;
}

export interface ChunkOptions {
  /** Soft token budget a chunk is packed toward. Default 450. */
  targetTokens?: number;
  /** Hard token ceiling a single chunk's own (non-overlap) content must never exceed. Default 600. */
  maxTokens?: number;
  /** Tokens of trailing context carried over from the previous chunk. Default 60. */
  overlapTokens?: number;
  /** A trailing chunk under this many tokens gets merged into its predecessor. Default 80. */
  minTrailingTokens?: number;
  /** Token counter, injectable for tests. Defaults to gpt-tokenizer's real BPE counter. */
  countTokens?: (text: string) => number;
}

const DEFAULT_OPTIONS: Required<ChunkOptions> = {
  targetTokens: 450,
  maxTokens: 600,
  overlapTokens: 60,
  minTrailingTokens: 80,
  countTokens: gptCountTokens,
};

// ---------------------------------------------------------------------------
// Line-ending normalization with an offset map back to the original string.
// ---------------------------------------------------------------------------

interface Normalized {
  text: string;
  /** normalized index -> original index. Length === text.length + 1 (last entry is the end-of-string position). */
  toOriginal: number[];
}

/**
 * Collapses "\r\n" and lone "\r" to "\n" so downstream regexes only ever
 * have to think about "\n", while keeping a map back to the original
 * (un-normalized) string's character offsets. This is the only
 * normalization applied — trailing-whitespace-per-line is deliberately
 * NOT stripped, so char offsets stay a straightforward, low-risk
 * position map rather than a lossy transform.
 */
function normalizeLineEndings(raw: string): Normalized {
  let text = "";
  const toOriginal: number[] = [];
  let i = 0;
  while (i < raw.length) {
    const ch = raw[i];
    if (ch === "\r") {
      text += "\n";
      toOriginal.push(i);
      i += raw[i + 1] === "\n" ? 2 : 1;
    } else {
      text += ch;
      toOriginal.push(i);
      i += 1;
    }
  }
  toOriginal.push(raw.length);
  return { text, toOriginal };
}

// ---------------------------------------------------------------------------
// Block parsing: headings, fenced code blocks, GFM tables, and plain text
// runs, each carrying [start, end) offsets in normalized-text coordinates.
// ---------------------------------------------------------------------------

type Block =
  | { type: "heading"; level: number; text: string; start: number; end: number }
  | { type: "code"; start: number; end: number }
  | { type: "table"; start: number; end: number }
  | { type: "text"; start: number; end: number };

const HEADING_RE = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const FENCE_RE = /^(`{3,}|~{3,})/;
const TABLE_ROW_RE = /^\s*\|?.+\|.*\|?\s*$/;
const TABLE_DELIM_RE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/;

function parseBlocks(text: string): Block[] {
  const lines = text.split("\n");
  // Char offset of the start of each line within `text`.
  const lineStarts: number[] = [];
  {
    let offset = 0;
    for (const line of lines) {
      lineStarts.push(offset);
      offset += line.length + 1; // +1 for the '\n' we split on
    }
  }

  const blocks: Block[] = [];
  let textRunStart: number | null = null;

  const flushTextRun = (endLineIndex: number) => {
    if (textRunStart === null) return;
    const end = lineStarts[endLineIndex] ?? text.length;
    if (end > textRunStart) {
      blocks.push({ type: "text", start: textRunStart, end });
    }
    textRunStart = null;
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    const headingMatch = HEADING_RE.exec(line);

    if (headingMatch) {
      flushTextRun(i);
      const lineEnd = (lineStarts[i] ?? 0) + line.length;
      blocks.push({
        type: "heading",
        level: headingMatch[1]?.length ?? 1,
        text: (headingMatch[2] ?? "").trim(),
        start: lineStarts[i] ?? 0,
        end: lineEnd,
      });
      i += 1;
      continue;
    }

    if (FENCE_RE.exec(line)) {
      flushTextRun(i);
      const fenceChar = line.trim()[0];
      const fenceStart = lineStarts[i] ?? 0;
      const closingPrefix = fenceChar === "`" ? "```" : "~~~";
      let j = i + 1;
      while (j < lines.length && !(lines[j] ?? "").trim().startsWith(closingPrefix)) {
        j += 1;
      }
      // j now points at the closing fence line, or lines.length if unterminated.
      const closingLineIndex = Math.min(j, lines.length - 1);
      const end = (lineStarts[closingLineIndex] ?? text.length) + (lines[closingLineIndex]?.length ?? 0);
      blocks.push({ type: "code", start: fenceStart, end });
      i = closingLineIndex + 1;
      continue;
    }

    if (
      TABLE_ROW_RE.test(line) &&
      line.includes("|") &&
      i + 1 < lines.length &&
      TABLE_DELIM_RE.test(lines[i + 1] ?? "")
    ) {
      flushTextRun(i);
      const tableStart = lineStarts[i] ?? 0;
      let j = i + 2;
      while (j < lines.length && TABLE_ROW_RE.test(lines[j] ?? "") && (lines[j] ?? "").includes("|") && (lines[j] ?? "").trim() !== "") {
        j += 1;
      }
      const closingLineIndex = j - 1;
      const end = (lineStarts[closingLineIndex] ?? text.length) + (lines[closingLineIndex]?.length ?? 0);
      blocks.push({ type: "table", start: tableStart, end });
      i = j;
      continue;
    }

    if (textRunStart === null) {
      textRunStart = lineStarts[i] ?? 0;
    }
    i += 1;
  }
  flushTextRun(lines.length);

  return blocks;
}

// ---------------------------------------------------------------------------
// Heading-path assignment: walk blocks in order, maintaining a heading
// stack, and attach the current path to every non-heading block.
// ---------------------------------------------------------------------------

interface PathedBlock {
  block: Block;
  headingPath: string | null;
}

function assignHeadingPaths(blocks: Block[], title: string): PathedBlock[] {
  const stack: { level: number; text: string }[] = [];
  const trimmedTitle = title.trim();

  const currentPath = (): string | null => {
    // A heading line with no actual title text after the hashes (e.g. a
    // bare "## ", or "## ##") is malformed but still valid per HEADING_RE
    // — it still counts as a section boundary (still pops/pushes the
    // stack, still forces a new chunk on transition), it just contributes
    // no text of its own to the path, so it's filtered out here rather
    // than leaving a dangling empty segment like "Doc > Title > ".
    const parts = [...(trimmedTitle ? [trimmedTitle] : []), ...stack.map((s) => s.text).filter((text) => text.length > 0)];
    return parts.length > 0 ? parts.join(" > ") : null;
  };

  const result: PathedBlock[] = [];
  for (const block of blocks) {
    if (block.type === "heading") {
      while (stack.length > 0 && (stack[stack.length - 1]?.level ?? 0) >= block.level) {
        stack.pop();
      }
      stack.push({ level: block.level, text: block.text });
      continue; // headings themselves don't become content blocks
    }
    result.push({ block, headingPath: currentPath() });
  }
  return result;
}

// ---------------------------------------------------------------------------
// Recursive splitting of plain-text runs into small "pieces" that greedy
// packing can then recombine up to the token budget.
// ---------------------------------------------------------------------------

interface Piece {
  text: string;
  start: number; // normalized-text coordinates
  end: number;
  atomic: boolean; // true for code/table blocks: never split further unless oversized
}

const SPLIT_SEPARATORS = [
  /\n[ \t]*\n+/g, // blank line(s)
  /\n/g, // single newline
  /(?<=[.!?])\s+/g, // sentence end
  /\s+/g, // whitespace (last resort)
];

function splitPreservingOffsets(text: string, base: number, sep: RegExp): { text: string; start: number; end: number }[] {
  const parts: { text: string; start: number; end: number }[] = [];
  let lastEnd = 0;
  sep.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = sep.exec(text)) !== null) {
    const piece = text.slice(lastEnd, match.index);
    if (piece.length > 0) {
      parts.push({ text: piece, start: base + lastEnd, end: base + match.index });
    }
    lastEnd = match.index + match[0].length;
    if (match[0].length === 0) break; // safety: avoid infinite loop on zero-width match
  }
  const tail = text.slice(lastEnd);
  if (tail.length > 0) {
    parts.push({ text: tail, start: base + lastEnd, end: base + text.length });
  }
  return parts;
}

function splitRecursive(
  text: string,
  start: number,
  countTokens: (text: string) => number,
  maxTokens: number,
  level = 0,
): Piece[] {
  if (text.trim().length === 0) return [];
  if (countTokens(text) <= maxTokens || level >= SPLIT_SEPARATORS.length) {
    return [{ text, start, end: start + text.length, atomic: false }];
  }
  const sep = SPLIT_SEPARATORS[level];
  if (!sep) return [{ text, start, end: start + text.length, atomic: false }];
  const parts = splitPreservingOffsets(text, start, sep);
  if (parts.length <= 1) {
    // Separator didn't actually split anything; try the next, finer one.
    return splitRecursive(text, start, countTokens, maxTokens, level + 1);
  }
  return parts.flatMap((part) =>
    countTokens(part.text) > maxTokens
      ? splitRecursive(part.text, part.start, countTokens, maxTokens, level + 1)
      : [{ text: part.text, start: part.start, end: part.end, atomic: false }],
  );
}

function blockToPieces(
  pathed: PathedBlock,
  normalizedText: string,
  countTokens: (text: string) => number,
  maxTokens: number,
): { pieces: Piece[]; headingPath: string | null } {
  const { block } = pathed;
  const raw = normalizedText.slice(block.start, block.end);

  if (block.type === "code" || block.type === "table") {
    // Atomic by default. Only if a single block blows past the hard max
    // do we fall back to splitting it (by line, the least-destructive
    // separator for either a code block or a table) so one huge block
    // can't produce one arbitrarily huge chunk.
    if (countTokens(raw) <= maxTokens) {
      return { pieces: [{ text: raw, start: block.start, end: block.end, atomic: true }], headingPath: pathed.headingPath };
    }
    const lineParts = splitPreservingOffsets(raw, block.start, /\n/g);
    const pieces = lineParts.map((p) => ({ text: p.text, start: p.start, end: p.end, atomic: true }));
    return { pieces, headingPath: pathed.headingPath };
  }

  // Plain text: recursively split blank-line -> newline -> sentence -> whitespace.
  const pieces = splitRecursive(raw, block.start, countTokens, maxTokens, 0);
  return { pieces, headingPath: pathed.headingPath };
}

// ---------------------------------------------------------------------------
// Greedy packing of pieces (in document order) into chunks bounded by the
// token budget. A heading-path change always starts a new chunk.
// ---------------------------------------------------------------------------

interface PackedChunk {
  headingPath: string | null;
  start: number; // normalized coords, before trim
  end: number;
}

function packPieces(
  items: { piece: Piece; headingPath: string | null }[],
  normalizedText: string,
  countTokens: (text: string) => number,
  targetTokens: number,
  maxTokens: number,
): PackedChunk[] {
  const chunks: PackedChunk[] = [];
  let current: { headingPath: string | null; start: number; end: number } | null = null;

  for (const { piece, headingPath } of items) {
    // Token budgets are checked against the ACTUAL slice a chunk would
    // become (start..end of the real text, separators included), not the
    // sum of each piece's own token count in isolation — the gap between
    // two packed pieces (blank lines, etc.) still costs tokens once it's
    // part of one contiguous chunk, and BPE merges can occur across a
    // piece boundary too. Both would otherwise let a chunk's real token
    // count creep past maxTokens even though the bookkeeping said it fit.
    let fits = false;
    if (current && current.headingPath === headingPath) {
      const currentTokens = countTokens(normalizedText.slice(current.start, current.end));
      const candidateTokens = countTokens(normalizedText.slice(current.start, piece.end));
      fits = currentTokens < targetTokens && candidateTokens <= maxTokens;
    }

    if (fits && current) {
      current.end = piece.end;
      continue;
    }

    if (current) {
      chunks.push({ headingPath: current.headingPath, start: current.start, end: current.end });
    }
    current = { headingPath, start: piece.start, end: piece.end };
  }
  if (current) {
    chunks.push({ headingPath: current.headingPath, start: current.start, end: current.end });
  }
  return chunks;
}

// ---------------------------------------------------------------------------
// Trimming helper: shrink a [start, end) span in normalized coords so its
// sliced text has no leading/trailing whitespace.
// ---------------------------------------------------------------------------

function trimSpan(normalizedText: string, start: number, end: number): { start: number; end: number } {
  let s = start;
  let e = end;
  while (s < e && /\s/.test(normalizedText[s] ?? "")) s += 1;
  while (e > s && /\s/.test(normalizedText[e - 1] ?? "")) e -= 1;
  return { start: s, end: e };
}

// ---------------------------------------------------------------------------
// Public entry point.
// ---------------------------------------------------------------------------

/**
 * Splits a document's markdown content into token-budgeted, offset-tracked
 * chunks for embedding and retrieval. Pure and framework-free — no I/O,
 * no network calls.
 *
 * - Headings (H1-H6) build a section tree; every chunk's `headingPath` is
 *   "Document Title > H1 text > H2 text > ...".
 * - Fenced code blocks and GFM tables are treated atomically and are never
 *   split, unless a single one exceeds `maxTokens`, in which case it's
 *   split by line as a last resort.
 * - Everything else is recursively split (blank line -> newline ->
 *   sentence end -> whitespace) and greedily packed up to `targetTokens`
 *   (never exceeding `maxTokens`), never mixing content from two
 *   different heading paths into the same chunk.
 * - Consecutive chunks under the same heading get `overlapTokens` of
 *   trailing context carried over from the previous chunk, cut at a
 *   sentence boundary where possible; overlap never crosses a heading
 *   boundary and is trimmed as needed so the combined chunk still never
 *   exceeds `maxTokens`.
 * - A trailing chunk under `minTrailingTokens` is merged into its
 *   predecessor (only when they share a heading path).
 */
export function chunkDocument(title: string, content: string, options: ChunkOptions = {}): Chunk[] {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const { targetTokens, maxTokens, overlapTokens, minTrailingTokens, countTokens } = opts;

  if (content.trim().length === 0) {
    return [];
  }

  const { text: normalizedText, toOriginal } = normalizeLineEndings(content);
  const blocks = parseBlocks(normalizedText);
  const pathedBlocks = assignHeadingPaths(blocks, title);

  const items: { piece: Piece; headingPath: string | null }[] = [];
  for (const pathed of pathedBlocks) {
    const { pieces, headingPath } = blockToPieces(pathed, normalizedText, countTokens, maxTokens);
    for (const piece of pieces) {
      items.push({ piece, headingPath });
    }
  }

  if (items.length === 0) {
    return [];
  }

  let packed = packPieces(items, normalizedText, countTokens, targetTokens, maxTokens);

  // Trim each chunk's span so its sliced content has no leading/trailing
  // whitespace, then drop any that trimmed away to nothing (defensive).
  packed = packed
    .map((c) => ({ ...c, ...trimSpan(normalizedText, c.start, c.end) }))
    .filter((c) => c.end > c.start);

  // Merge any too-small "trailing" chunk — one that sits at the end of its
  // heading-path run, either the very end of the document or right before
  // a heading-path change — into its predecessor. Walk backward so merges
  // can cascade (several tiny trailing chunks in a row all fold into one
  // predecessor); never merges across a heading boundary.
  for (let i = packed.length - 1; i >= 1; i -= 1) {
    const chunk = packed[i];
    const prevChunk = packed[i - 1];
    if (!chunk || !prevChunk || prevChunk.headingPath !== chunk.headingPath) continue;
    const nextChunk = packed[i + 1];
    const isTrailingInSection = i === packed.length - 1 || nextChunk?.headingPath !== chunk.headingPath;
    if (!isTrailingInSection) continue;
    const tokens = countTokens(normalizedText.slice(chunk.start, chunk.end));
    if (tokens < minTrailingTokens) {
      prevChunk.end = chunk.end;
      packed.splice(i, 1);
    }
  }

  // Apply overlap: each chunk (after the first) that shares its
  // predecessor's heading path gets up to `overlapTokens` of the
  // predecessor's trailing content prepended, cut at a sentence boundary
  // when one is found, and shrunk as needed so the combined chunk never
  // exceeds `maxTokens`.
  const finalSpans: { headingPath: string | null; contentStart: number; contentEnd: number }[] = packed.map((c) => ({
    headingPath: c.headingPath,
    contentStart: c.start,
    contentEnd: c.end,
  }));

  for (let i = 1; i < packed.length; i += 1) {
    const prev = packed[i - 1];
    const curr = packed[i];
    if (!prev || !curr || prev.headingPath !== curr.headingPath) continue;

    const currText = normalizedText.slice(curr.start, curr.end);
    const currTokens = countTokens(currText);
    const budget = maxTokens - currTokens;
    if (budget <= 0) continue;

    const prevText = normalizedText.slice(prev.start, prev.end);
    const overlapBudgetTokens = Math.min(overlapTokens, budget);
    if (overlapBudgetTokens <= 0) continue;

    const overlapStart = findOverlapStart(prevText, overlapBudgetTokens, countTokens);
    if (overlapStart >= prevText.length) continue;

    const overlapAbsoluteStart = prev.start + overlapStart;
    const span = finalSpans[i];
    if (span) {
      span.contentStart = overlapAbsoluteStart;
    }
  }

  // Safety net: the gap between the overlap's cut point and the chunk's
  // own content (blank lines, etc.) isn't counted by the per-piece budget
  // above, and BPE merges can occur across that boundary too, so verify
  // the real, final slice for each chunk and shrink the overlap (never
  // past the chunk's own un-overlapped start) if it still runs over.
  for (let i = 0; i < finalSpans.length; i += 1) {
    const span = finalSpans[i];
    const ownStart = packed[i]?.start;
    if (!span || ownStart === undefined || span.contentStart >= ownStart) continue;

    const tokens = countTokens(normalizedText.slice(span.contentStart, span.contentEnd));
    if (tokens <= maxTokens) continue;

    let lo = span.contentStart;
    let hi = ownStart;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      const midTokens = countTokens(normalizedText.slice(mid, span.contentEnd));
      if (midTokens <= maxTokens) {
        hi = mid;
      } else {
        lo = mid + 1;
      }
    }
    span.contentStart = lo;
  }

  // Materialize chunks with original-coordinate offsets.
  const chunks: Chunk[] = finalSpans.map((span, index) => {
    const content = normalizedText.slice(span.contentStart, span.contentEnd);
    const origStart = toOriginal[span.contentStart] ?? span.contentStart;
    const origEndExclusive = toOriginal[span.contentEnd] ?? span.contentEnd;
    return {
      chunkIndex: index,
      content,
      headingPath: span.headingPath,
      tokenCount: countTokens(content),
      charStart: origStart,
      charEnd: origEndExclusive,
    };
  });

  return chunks;
}

/**
 * Given the previous chunk's full text and a token budget for the
 * overlap, finds the start offset (within `prevText`) of a trailing slice
 * that fits the budget, preferring to start right after a sentence
 * boundary rather than mid-sentence.
 */
function findOverlapStart(prevText: string, overlapBudgetTokens: number, countTokens: (text: string) => number): number {
  if (countTokens(prevText) <= overlapBudgetTokens) {
    return 0;
  }

  // Binary search for the largest suffix whose token count fits the budget.
  let lo = 0;
  let hi = prevText.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const suffix = prevText.slice(mid);
    if (countTokens(suffix) <= overlapBudgetTokens) {
      hi = mid;
    } else {
      lo = mid + 1;
    }
  }
  const rawStart = lo;

  // Prefer snapping forward to the nearest sentence boundary within the
  // slice, so the overlap reads naturally rather than starting mid-word.
  const suffix = prevText.slice(rawStart);
  const boundaryMatch = /[.!?]\s+/.exec(suffix);
  if (boundaryMatch && boundaryMatch.index !== undefined) {
    const candidateStart = rawStart + boundaryMatch.index + boundaryMatch[0].length;
    if (candidateStart < prevText.length && countTokens(prevText.slice(candidateStart)) <= overlapBudgetTokens) {
      return candidateStart;
    }
  }
  return rawStart;
}
