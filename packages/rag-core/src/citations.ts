/**
 * A buffering transformer over an in-flight token stream's text deltas —
 * the chunk boundaries a real streaming ChatModel delivers text in have
 * nothing to do with where a `[S1]`-style citation marker happens to fall,
 * so a marker can arrive split across any number of deltas (`"[", "S", "1",
 * "]"` in the worst case). This holds back only the minimal ambiguous
 * suffix of the buffer — a `[` that could still grow into a complete
 * `[S<digits>]` marker — and emits everything else immediately, so the SSE
 * layer can stream text to the browser with the smallest possible added
 * latency. See docs/DECISIONS.md Phase 5.
 */

const MARKER_RE = /\[S(\d+)\]/g;

/** True when `text` is `[`, or `[S`, or `[S` followed by digits — i.e. still a valid, unclosed prefix of `[S<digits>]` that MORE incoming text could complete. */
function isIncompleteMarkerPrefix(text: string): boolean {
  return /^\[S?\d*$/.test(text);
}

export interface CitationParseResult {
  /** Text with valid `[S<digits>]` markers kept in place (for the UI to render as badges) and invalid ones removed. Safe to emit as-is. */
  text: string;
  /** Source ids cited in this push, in the order their markers appeared (may repeat if the model cites the same source twice). */
  citations: string[];
  /** Complete `[S<digits>]` markers found in this push whose id ISN'T in the valid source map — stripped from `text`; the caller decides how/whether to log them. */
  droppedMarkers: string[];
}

export interface CitationStreamParser {
  /** Feed the next text delta from the model's stream. */
  push(delta: string): CitationParseResult;
  /** Call exactly once after the stream ends: flushes any still-buffered, never-completed tail (e.g. the response ended on a lone trailing "[") as plain text. */
  flush(): CitationParseResult;
}

function emptyResult(): CitationParseResult {
  return { text: "", citations: [], droppedMarkers: [] };
}

/** Scans `segment` (which contains no dangling incomplete marker prefix) for complete markers, validates each against `validSourceIds`, and returns the filtered text plus what was found. */
function processSegment(segment: string, validSourceIds: ReadonlySet<string>): CitationParseResult {
  if (segment.length === 0) return emptyResult();

  const citations: string[] = [];
  const droppedMarkers: string[] = [];
  let text = "";
  let lastIndex = 0;

  MARKER_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = MARKER_RE.exec(segment)) !== null) {
    const marker = match[0];
    const sourceId = `S${match[1]}`;
    text += segment.slice(lastIndex, match.index);
    if (validSourceIds.has(sourceId)) {
      text += marker;
      citations.push(sourceId);
    } else {
      droppedMarkers.push(marker);
      // Dropped silently from the text — a fabricated/hallucinated id must
      // never reach the browser looking like a real, clickable citation.
    }
    lastIndex = match.index + marker.length;
  }
  text += segment.slice(lastIndex);

  return { text, citations, droppedMarkers };
}

export function createCitationStreamParser(validSourceIds: Iterable<string>): CitationStreamParser {
  const sourceIds = new Set(validSourceIds);
  let buffer = "";

  return {
    push(delta: string): CitationParseResult {
      const combined = buffer + delta;
      const lastBracket = combined.lastIndexOf("[");

      if (lastBracket === -1) {
        buffer = "";
        return processSegment(combined, sourceIds);
      }

      const tail = combined.slice(lastBracket);
      if (tail.includes("]")) {
        // The last bracket run is already closed — nothing ambiguous left,
        // even if more text follows it in this same delta.
        buffer = "";
        return processSegment(combined, sourceIds);
      }

      if (isIncompleteMarkerPrefix(tail)) {
        // Still could become a real marker with more incoming text — hold
        // it back and only process what comes before it.
        buffer = tail;
        return processSegment(combined.slice(0, lastBracket), sourceIds);
      }

      // The tail starts with "[" but has already diverged from a valid
      // marker shape (e.g. "[abc", "[S1x") — no amount of additional text
      // can ever complete it into "[S<digits>]", so it's safe to treat as
      // ordinary text right now rather than buffering it forever.
      buffer = "";
      return processSegment(combined, sourceIds);
    },

    flush(): CitationParseResult {
      const leftover = buffer;
      buffer = "";
      // Never completed into a marker before the stream ended — just
      // literal trailing text (e.g. the model's answer happened to end on
      // a "["), not a dropped/invalid citation, so it's emitted as-is
      // rather than logged as a drop.
      return { text: leftover, citations: [], droppedMarkers: [] };
    },
  };
}
