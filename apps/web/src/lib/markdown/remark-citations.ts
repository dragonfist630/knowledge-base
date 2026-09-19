import { findAndReplace, type ReplaceFunction } from "mdast-util-find-and-replace";
import type { Root } from "mdast";
import type { Handler } from "mdast-util-to-hast";
import type { Plugin } from "unified";

/**
 * Must stay byte-for-byte the same pattern as packages/rag-core/src/citations.ts's
 * `MARKER_RE` — that's what apps/api validates/streams, this is what
 * renders it. Kept as a hand-duplicated constant (like conversations.ts's
 * own tag-schema duplication note) rather than shared, since one is a
 * server-side streaming parser and this is a markdown-render-time concern.
 */
const MARKER_RE = /\[S(\d+)\]/g;

export interface CitationMarkerNode {
  type: "citationMarker";
  sourceId: string;
  children: [];
}

declare module "mdast" {
  interface RootContentMap {
    citationMarker: CitationMarkerNode;
  }
  interface PhrasingContentMap {
    citationMarker: CitationMarkerNode;
  }
}

const replace: ReplaceFunction = (_match: string, digits: string): CitationMarkerNode => ({
  type: "citationMarker",
  sourceId: `S${digits}`,
  children: [],
});

/**
 * Turns `[S<digits>]` citation markers into a custom `citationMarker` mdast
 * node instead of leaving them as literal bracket text, so
 * features/chat/components/message.tsx can render each one as a
 * CitationBadge via a matching mdast-to-hast handler (see
 * `citationHandlers` in that same lib/markdown module) plus a `components`
 * entry keyed to the hast tag name that handler produces.
 */
export const remarkCitations: Plugin<[], Root> = () => (tree) => {
  findAndReplace(tree, [[MARKER_RE, replace]]);
};

/**
 * The other half of the pipeline: converts a `citationMarker` mdast node
 * into a `<citation-marker sourceid="S1">` hast element (a custom,
 * non-HTML tag name — react-markdown's `rehype-react` step renders any
 * unrecognized tag name through the matching key in its `components` map
 * rather than erroring), which message.tsx maps to a CitationBadge.
 * Passed to <ReactMarkdown remarkRehypeOptions={{ handlers: citationHandlers }}>.
 */
export const citationHandlers: Record<string, Handler> = {
  citationMarker(state, node) {
    const marker = node as CitationMarkerNode;
    return {
      type: "element",
      tagName: "citation-marker",
      properties: { sourceid: marker.sourceId },
      children: [],
    };
  },
};
