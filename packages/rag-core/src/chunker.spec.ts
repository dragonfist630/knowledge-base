import { countTokens } from "gpt-tokenizer";
import { describe, expect, it } from "vitest";

import { chunkDocument } from "./chunker.js";

describe("chunkDocument", () => {
  it("returns 0 chunks for an empty document", () => {
    expect(chunkDocument("Title", "")).toEqual([]);
    expect(chunkDocument("Title", "   \n\n  \t\n")).toEqual([]);
  });

  it("returns exactly 1 chunk for a short document", () => {
    const chunks = chunkDocument("My Doc", "Just a short sentence or two, nothing fancy here.");
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.chunkIndex).toBe(0);
    expect(chunks[0]?.content).toBe("Just a short sentence or two, nothing fancy here.");
  });

  it("never leaves a dangling empty segment in headingPath for a heading with no title text", () => {
    // "## " and "## ##" are both valid ATX headings with empty text after
    // the hashes are stripped — malformed content a real document could
    // still contain (a stray "##", a heading someone deleted the text
    // from). Regression test for a bug found during Phase 4 re-validation:
    // the empty segment used to survive into the joined path as
    // "Handbook > Doc Title > " (trailing separator, nothing after it).
    const content = ["# Doc Title", "## ", "", "Some content under the empty heading.", "", "## ##", "", "More content."].join(
      "\n",
    );
    const chunks = chunkDocument("Handbook", content);
    for (const chunk of chunks) {
      expect(chunk.headingPath).not.toMatch(/>\s*$/);
      expect(chunk.headingPath).not.toContain(">  >");
    }
    expect(chunks.some((c) => c.headingPath === "Handbook > Doc Title")).toBe(true);
  });

  it("propagates headings into headingPath", () => {
    const content = [
      "# Getting Started",
      "",
      "Intro paragraph under the first H1.",
      "",
      "## Installation",
      "",
      "Installation instructions go here, in a fair amount of detail so this section is its own chunk.",
      "",
      "## Configuration",
      "",
      "Configuration details go here too, also with enough words to stand alone as a section.",
    ].join("\n");

    const chunks = chunkDocument("Handbook", content);

    expect(chunks.length).toBeGreaterThanOrEqual(3);
    expect(chunks[0]?.headingPath).toBe("Handbook > Getting Started");
    const installChunk = chunks.find((c) => c.content.includes("Installation instructions"));
    const configChunk = chunks.find((c) => c.content.includes("Configuration details"));
    expect(installChunk?.headingPath).toBe("Handbook > Getting Started > Installation");
    expect(configChunk?.headingPath).toBe("Handbook > Getting Started > Configuration");
  });

  it("never splits a fenced code block that fits under the hard max", () => {
    const code = ["```ts", "function add(a: number, b: number): number {", "  return a + b;", "}", "```"].join("\n");
    const content = ["# Snippet", "", "Here is a small example:", "", code, "", "That's the whole function."].join(
      "\n",
    );

    const chunks = chunkDocument("Code Doc", content);
    const codeChunk = chunks.find((c) => c.content.includes("function add"));
    expect(codeChunk).toBeDefined();
    expect(codeChunk?.content).toContain("```ts");
    expect(codeChunk?.content).toContain("```\n");
    // The fence markers and body must appear exactly once each, unsplit.
    expect(codeChunk?.content.match(/```/g)).toHaveLength(2);
  });

  it("splits a single oversized code block by line rather than exceeding the hard max", () => {
    const hugeLine = "const x = 1; // ".repeat(80);
    const bigCode = ["```ts", ...Array.from({ length: 60 }, () => hugeLine), "```"].join("\n");
    const content = ["# Huge Snippet", "", bigCode].join("\n");

    const chunks = chunkDocument("Big Code Doc", content, { targetTokens: 450, maxTokens: 600 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(countTokens(chunk.content)).toBeLessThanOrEqual(600);
    }
  });

  it("round-trips char offsets against the original content", () => {
    const content = [
      "# Title",
      "",
      "First paragraph with some words in it to give it a bit of length.",
      "",
      "Second paragraph, also reasonably long, sitting right after the first one.",
    ].join("\n");

    const chunks = chunkDocument("Offsets Doc", content);
    for (const chunk of chunks) {
      expect(content.slice(chunk.charStart, chunk.charEnd)).toBe(chunk.content);
    }
  });

  it("round-trips char offsets when the source uses CRLF line endings", () => {
    const content = ["# Title", "", "Paragraph one.", "", "Paragraph two, here."].join("\r\n");
    const chunks = chunkDocument("CRLF Doc", content);
    for (const chunk of chunks) {
      expect(content.slice(chunk.charStart, chunk.charEnd)).toBe(chunk.content.replace(/\n/g, "\r\n"));
    }
  });

  it("carries overlap between consecutive chunks under the same heading", () => {
    const sentence = "This is one sentence about the widget and how it works in practice. ";
    const paragraph = sentence.repeat(40); // long enough to force multiple chunks
    const content = ["# Widgets", "", paragraph].join("\n");

    const chunks = chunkDocument("Widget Doc", content, { targetTokens: 100, maxTokens: 150, overlapTokens: 20 });
    expect(chunks.length).toBeGreaterThan(1);

    for (let i = 1; i < chunks.length; i += 1) {
      const prev = chunks[i - 1];
      const curr = chunks[i];
      if (!prev || !curr) continue;
      if (prev.headingPath !== curr.headingPath) continue;
      // The tail of the previous chunk's content should reappear at the
      // start of the current chunk (accounting for the trimmed overlap).
      const prevTail = prev.content.slice(-15);
      expect(curr.content.includes(prevTail.trim().split(" ").slice(-2).join(" "))).toBe(true);
    }
  });

  it("never exceeds the hard max token count, even with overlap applied", () => {
    const sentence = "The quick brown fox jumps over the lazy dog near the riverbank at dawn. ";
    const paragraph = sentence.repeat(30);
    const content = ["# Section", "", paragraph].join("\n");

    const chunks = chunkDocument("Max Test Doc", content, { targetTokens: 80, maxTokens: 100, overlapTokens: 30 });
    for (const chunk of chunks) {
      expect(chunk.tokenCount).toBeLessThanOrEqual(100);
      expect(countTokens(chunk.content)).toBeLessThanOrEqual(100);
    }
  });

  it("merges a small trailing chunk into its predecessor", () => {
    const sentence = "This paragraph exists purely to pad out the section to a reasonable size. ";
    const content = ["# Section", "", sentence.repeat(20), "", "Tiny tail."].join("\n");

    const chunks = chunkDocument("Merge Doc", content, { targetTokens: 100, maxTokens: 150, minTrailingTokens: 20 });
    const last = chunks[chunks.length - 1];
    expect(last?.content).toContain("Tiny tail.");
    expect(countTokens(last?.content ?? "")).toBeGreaterThanOrEqual(20);
  });

  it("does not mix content from two different heading paths into one chunk", () => {
    const content = ["# One", "", "Short bit under heading one.", "", "# Two", "", "Short bit under heading two."].join(
      "\n",
    );
    const chunks = chunkDocument("Two Sections", content, { minTrailingTokens: 0 });
    for (const chunk of chunks) {
      // Each chunk's content should only ever belong to a single section.
      const touchesOne = chunk.content.includes("heading one");
      const touchesTwo = chunk.content.includes("heading two");
      expect(touchesOne && touchesTwo).toBe(false);
    }
  });

  it("assigns sequential chunkIndex starting at 0", () => {
    const content = ["# A", "", "one", "", "# B", "", "two"].join("\n");
    const chunks = chunkDocument("Index Doc", content, { minTrailingTokens: 0 });
    chunks.forEach((chunk, i) => expect(chunk.chunkIndex).toBe(i));
  });
});
