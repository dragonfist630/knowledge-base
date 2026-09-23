// The real UI lives in ./layout.tsx, shared with /chat/[conversationId] —
// see its own doc comment (and docs/DECISIONS.md D9.10) for why. This
// page renders nothing of its own; it exists only because Next.js
// requires a page.tsx for a segment to be a navigable route at all.
export default function ChatPage() {
  return null;
}
