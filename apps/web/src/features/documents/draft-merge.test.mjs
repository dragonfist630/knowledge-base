import assert from "node:assert/strict";
import { test } from "node:test";

import { mergeServerSnapshot } from "./draft-merge.mjs";

test("adopts the server's value for a field untouched since it was sent (e.g. server-side trimming)", () => {
  const sent = { title: "  A  ", content: "hello", tags: ["x"] };
  const saved = { title: "A", content: "hello", tags: ["x"] };
  const live = { title: "  A  ", content: "hello", tags: ["x"] };
  assert.deepEqual(mergeServerSnapshot(sent, saved, live), { title: "A", content: "hello", tags: ["x"] });
});

test("D6.16: keeps keystrokes typed while a save was still in flight instead of the server's now-stale echo", () => {
  const sent = { title: "A", content: "hello", tags: [] };
  const saved = { title: "A", content: "hello", tags: [] }; // server echoes back exactly what was sent
  const live = { title: "A", content: "hello world", tags: [] }; // user kept typing during the request
  assert.deepEqual(mergeServerSnapshot(sent, saved, live), { title: "A", content: "hello world", tags: [] });
});

test("D6.16: keeps an edit that started only after the request was already sent (handleRetry's stale-dirty-closure case)", () => {
  const sent = { title: "A", content: "hello", tags: [] };
  const saved = { title: "A", content: "hello", tags: [] }; // reindexing doesn't change content/title/tags
  const live = { title: "A new title", content: "hello", tags: [] }; // typed after clicking Retry
  assert.deepEqual(mergeServerSnapshot(sent, saved, live), { title: "A new title", content: "hello", tags: [] });
});

test("non-vacuity: the old unconditional overwrite (draft = saved) would have discarded the in-flight edit", () => {
  const saved = { title: "A", content: "hello", tags: [] };
  const live = { title: "A", content: "hello world", tags: [] };
  // The pre-fix behavior was simply `setDraft(saved)`, unconditionally.
  const oldBehaviorResult = saved;
  assert.notDeepEqual(
    oldBehaviorResult,
    live,
    "the old behavior would silently replace 'hello world' back with 'hello', losing the in-flight keystrokes",
  );
});

test("multiple fields: only the untouched field adopts the server value, the diverged one is kept live", () => {
  const sent = { title: "A", content: "hello", tags: [] };
  const saved = { title: "A", content: "hello", tags: [] };
  const live = { title: "A", content: "hello world", tags: [] }; // only content diverged
  assert.deepEqual(mergeServerSnapshot(sent, saved, live), { title: "A", content: "hello world", tags: [] });
});
