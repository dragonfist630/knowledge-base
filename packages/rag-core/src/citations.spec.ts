import { describe, expect, it } from "vitest";

import { createCitationStreamParser } from "./citations.js";

const VALID_IDS = ["S1", "S2", "S3"];

function runFullStream(deltas: string[], validSourceIds: string[] = VALID_IDS) {
  const parser = createCitationStreamParser(validSourceIds);
  let text = "";
  const citations: string[] = [];
  const droppedMarkers: string[] = [];
  for (const delta of deltas) {
    const r = parser.push(delta);
    text += r.text;
    citations.push(...r.citations);
    droppedMarkers.push(...r.droppedMarkers);
  }
  const flushed = parser.flush();
  text += flushed.text;
  citations.push(...flushed.citations);
  droppedMarkers.push(...flushed.droppedMarkers);
  return { text, citations, droppedMarkers };
}

describe("createCitationStreamParser", () => {
  it("passes plain text through untouched when there are no markers", () => {
    const result = runFullStream(["Hello, ", "world!"]);
    expect(result.text).toBe("Hello, world!");
    expect(result.citations).toEqual([]);
  });

  it("recognizes a single complete marker delivered in one delta", () => {
    const result = runFullStream(["The answer is 5 [S1]."]);
    expect(result.text).toBe("The answer is 5 [S1].");
    expect(result.citations).toEqual(["S1"]);
  });

  it("recognizes stacked markers", () => {
    const result = runFullStream(["True [S1][S3] indeed."]);
    expect(result.text).toBe("True [S1][S3] indeed.");
    expect(result.citations).toEqual(["S1", "S3"]);
  });

  it("strips an invalid/hallucinated marker id and reports it as dropped", () => {
    const result = runFullStream(["Bogus claim [S99]."]);
    expect(result.text).toBe("Bogus claim .");
    expect(result.citations).toEqual([]);
    expect(result.droppedMarkers).toEqual(["[S99]"]);
  });

  it("a lone trailing '[' with nothing after it (stream ends mid-bracket) is emitted as literal text, not dropped", () => {
    const result = runFullStream(["price is $5 ["]);
    expect(result.text).toBe("price is $5 [");
    expect(result.droppedMarkers).toEqual([]);
  });

  it("a '[' that diverges from the marker shape (not 'S' + digits) is treated as ordinary text immediately", () => {
    const result = runFullStream(["array[0] = 1"]);
    expect(result.text).toBe("array[0] = 1");
    expect(result.citations).toEqual([]);
    expect(result.droppedMarkers).toEqual([]);
  });

  it("holds back an incomplete marker prefix across multiple pushes and never leaks a partial bracket into emitted text", () => {
    const parser = createCitationStreamParser(VALID_IDS);
    const r1 = parser.push("The value is 5 ");
    expect(r1.text).toBe("The value is 5 ");
    const r2 = parser.push("[");
    expect(r2.text).toBe(""); // held back, not leaked
    const r3 = parser.push("S");
    expect(r3.text).toBe("");
    const r4 = parser.push("1");
    expect(r4.text).toBe("");
    const r5 = parser.push("].");
    expect(r5.text).toBe("[S1].");
    expect(r5.citations).toEqual(["S1"]);
  });

  it("multiple markers split across many small deltas, interleaved with plain text", () => {
    const chars = "Fact one [S1]. Fact two [S2], fact three [S3].".split("");
    const result = runFullStream(chars);
    expect(result.text).toBe("Fact one [S1]. Fact two [S2], fact three [S3].");
    expect(result.citations).toEqual(["S1", "S2", "S3"]);
  });

  it("an invalid marker split across deltas is still correctly dropped once it completes", () => {
    const result = runFullStream(["no such source [", "S", "4", "2", "]", " here"]);
    expect(result.text).toBe("no such source  here");
    expect(result.droppedMarkers).toEqual(["[S42]"]);
  });

  // The brief calls this out explicitly: "Unit-test it with markers split
  // at every possible offset." A real streaming ChatModel can deliver text
  // in arbitrarily small pieces (down to one character), so the parser must
  // reconstruct the exact same final text/citations regardless of where a
  // marker happens to be cut, for every possible cut point.
  it("split at every possible offset produces identical final output for a valid marker", () => {
    const full = "The refund window is short [S2] according to policy.";
    const expectedText = full;
    const expectedCitations = ["S2"];

    for (let cut = 0; cut <= full.length; cut += 1) {
      const deltas = cut === 0 ? [full] : cut === full.length ? [full] : [full.slice(0, cut), full.slice(cut)];
      const result = runFullStream(deltas);
      expect(result.text, `cut at offset ${cut}`).toBe(expectedText);
      expect(result.citations, `cut at offset ${cut}`).toEqual(expectedCitations);
      expect(result.droppedMarkers, `cut at offset ${cut}`).toEqual([]);
    }
  });

  it("split at every possible offset produces identical final output for an invalid marker (dropped)", () => {
    const full = "A hallucinated claim [S404] that should vanish.";
    const expectedText = "A hallucinated claim  that should vanish.";

    for (let cut = 0; cut <= full.length; cut += 1) {
      const deltas = [full.slice(0, cut), full.slice(cut)];
      const result = runFullStream(deltas);
      expect(result.text, `cut at offset ${cut}`).toBe(expectedText);
      expect(result.citations, `cut at offset ${cut}`).toEqual([]);
      expect(result.droppedMarkers, `cut at offset ${cut}`).toEqual(["[S404]"]);
    }
  });

  it("split at every possible offset produces identical final output for text with multiple markers", () => {
    const full = "First [S1] then [S2] and finally [S3].";

    for (let cut = 0; cut <= full.length; cut += 1) {
      for (let cut2 = cut; cut2 <= full.length; cut2 += 1) {
        const deltas = [full.slice(0, cut), full.slice(cut, cut2), full.slice(cut2)];
        const result = runFullStream(deltas);
        expect(result.text, `cut at ${cut},${cut2}`).toBe(full);
        expect(result.citations, `cut at ${cut},${cut2}`).toEqual(["S1", "S2", "S3"]);
      }
    }
  });

  it("handles a completely empty stream", () => {
    const result = runFullStream([]);
    expect(result.text).toBe("");
    expect(result.citations).toEqual([]);
  });

  it("handles empty-string deltas interspersed with real content", () => {
    const result = runFullStream(["", "Answer ", "", "[S1]", "", "."]);
    expect(result.text).toBe("Answer [S1].");
    expect(result.citations).toEqual(["S1"]);
  });
});
