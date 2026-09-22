/**
 * Applies a server-confirmed save/reindex result onto the live draft,
 * without discarding edits made while that request was in flight.
 *
 * `sent` is the draft snapshot that was actually submitted to the server
 * (captured before the request started); `saved` is what the server
 * echoed back; `live` is whatever the draft holds right now, at the
 * moment the response arrives. For each field, if `live` still equals
 * `sent`, nothing changed it while the request was in flight, so it's
 * safe (and desirable — picks up server-side normalization) to adopt
 * `saved`'s value. If `live` has since diverged from `sent`, something
 * changed that field after the request was sent, so its live value is
 * kept untouched rather than being silently overwritten by the older
 * `saved` value — and because the field stays different from the new
 * `saved` baseline, it correctly stays flagged "dirty" afterward too.
 *
 * DocumentForm's handleSave used to unconditionally replace the live
 * draft with the server's response the moment the save resolved,
 * silently discarding any keystrokes typed during that request.
 * handleRetry had a similar bug for a different reason: it decided
 * whether to keep the live content using a `dirty` boolean captured in
 * the async closure at call time, which went stale the instant the user
 * made an edit after clicking Retry but before it resolved — the retry
 * proceeded believing dirty was still false, and reindexing's own
 * (otherwise correct, unchanged) content overwrote the user's fresh edit.
 * See docs/DECISIONS.md Phase 6, D6.16.
 */
export function mergeServerSnapshot(sent, saved, live) {
  return {
    title: live.title === sent.title ? saved.title : live.title,
    content: live.content === sent.content ? saved.content : live.content,
    tags: live.tags === sent.tags ? saved.tags : live.tags,
  };
}
