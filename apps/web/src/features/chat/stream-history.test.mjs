import assert from "node:assert/strict";
import { test } from "node:test";

import { isAssistantMessageSettled } from "./stream-history.mjs";

test("false when there is no assistant message id yet (before the start SSE event arrives)", () => {
  assert.equal(isAssistantMessageSettled([], undefined), false);
});

test("false when the id isn't in history at all", () => {
  const messages = [{ id: "other-id", status: "complete" }];
  assert.equal(isAssistantMessageSettled(messages, "assistant-1"), false);
});

test("D6.16: false for the empty placeholder row a turn starts with (status streaming), even though the id matches", () => {
  const messages = [{ id: "assistant-1", status: "streaming" }];
  assert.equal(isAssistantMessageSettled(messages, "assistant-1"), false);
});

test("true once the row is finalized as complete", () => {
  const messages = [{ id: "assistant-1", status: "complete" }];
  assert.equal(isAssistantMessageSettled(messages, "assistant-1"), true);
});

test("true once the row is finalized as error (so the error+retry UI can correctly hide the retired turn)", () => {
  const messages = [{ id: "assistant-1", status: "error" }];
  assert.equal(isAssistantMessageSettled(messages, "assistant-1"), true);
});

test("true once the row is finalized as aborted", () => {
  const messages = [{ id: "assistant-1", status: "aborted" }];
  assert.equal(isAssistantMessageSettled(messages, "assistant-1"), true);
});

test("non-vacuity: an id-only match (the pre-fix behavior) would have wrongly reported true for the streaming placeholder", () => {
  const messages = [{ id: "assistant-1", status: "streaming" }];
  const idOnlyMatch = messages.some((m) => m.id === "assistant-1");
  assert.equal(idOnlyMatch, true, "the old id-only check would have hidden the live stream while it was still in progress");
});
