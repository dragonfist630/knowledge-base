import { describe, expect, it } from "vitest";

import { runChatModelContract } from "../contract.js";
import { MockChatModel } from "./mock-chat-model.js";

describe("MockChatModel", () => {
  describe("contract", () => runChatModelContract(() => new MockChatModel()));

  it("is deterministic for the same input", async () => {
    const messages = [{ role: "user" as const, content: "First fact. Second fact. Third fact. Fourth fact." }];
    const a = await new MockChatModel().complete(messages);
    const b = await new MockChatModel().complete(messages);
    expect(a.text).toBe(b.text);
  });

  it("cites up to the first three sentences of the latest user message with [S#] markers", async () => {
    const model = new MockChatModel();
    const result = await model.complete([
      { role: "system", content: "System preamble should be ignored for citation purposes." },
      { role: "user", content: "Alpha fact. Beta fact. Gamma fact. Delta fact should not appear." },
    ]);
    expect(result.text).toContain("Alpha fact. [S1]");
    expect(result.text).toContain("Beta fact. [S2]");
    expect(result.text).toContain("Gamma fact. [S3]");
    expect(result.text).not.toContain("Delta fact");
  });

  it("falls back gracefully when there is no content to cite", async () => {
    const model = new MockChatModel();
    const result = await model.complete([{ role: "user", content: "" }]);
    expect(result.text.length).toBeGreaterThan(0);
    expect(result.finishReason).toBe("stop");
  });

  it("marks usage as estimated", async () => {
    const model = new MockChatModel();
    const result = await model.complete([{ role: "user", content: "Hello there." }]);
    expect(result.usage.estimated).toBe(true);
  });

  it("streams the same text that complete() returns, reassembled from deltas", async () => {
    const messages = [{ role: "user" as const, content: "One sentence here. Another one here too." }];
    const model = new MockChatModel();
    const { text: completeText } = await model.complete(messages);

    let streamed = "";
    for await (const part of model.stream(messages)) {
      if (part.type === "text-delta") {
        streamed += part.text;
      }
    }
    expect(streamed).toBe(completeText);
  });
});
