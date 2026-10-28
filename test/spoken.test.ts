import { describe, expect, it } from "vitest";
import type { Term } from "#memory/vocabulary.ts";
import { correct } from "#voice/corrector.ts";
import { createSentenceFeed, spokenPart } from "#voice/spoken.ts";

const term = (text: string, kind: Term["kind"], heard: readonly string[] = []): Term => ({
  text,
  kind,
  weight: 1,
  phrases: [],
  heard: [...heard],
});

const vocabulary: readonly Term[] = [
  term("Bora", "person", ["Bara"]),
  term("QRT panel", "project", ["cutie panel"]),
  term("QRT", "term", ["cutie"]),
  term("Ljubljana", "place"),
];

describe("what Ari says on a call", () => {
  it("corrects a learnt mishearing, longest first, and says where", () => {
    const { text, corrections } = correct("What did Bara say about the cutie panel?", vocabulary);

    expect(text).toBe("What did Bora say about the QRT panel?");
    expect(corrections).toEqual([
      { offset: 9, length: 4, heard: "Bara" },
      { offset: 28, length: 9, heard: "cutie panel" },
    ]);
    expect(correct("Cutie, I said.", vocabulary).text).toBe("QRT, I said.");
  });

  it("leaves words alone that aren't learnt mishearings, and counts offsets in UTF-16", () => {
    expect(correct("Back from Lubljana today", vocabulary).corrections).toEqual([]);
    const { text, corrections } = correct("🏃 Café with Bara", vocabulary);
    const [first] = corrections;

    expect(first && text.slice(first.offset, first.offset + first.length)).toBe("Bora");
  });

  it("speaks what comes before a line holding only ---, without Markdown", () => {
    const reply = [
      "She wants **one more round** on your design. I've put the list in the chat.",
      "---",
      "1. Tighten the intro",
      "2. Add the latency numbers",
    ].join("\n");

    expect(spokenPart(reply)).toBe("She wants one more round on your design. I've put the list in the chat.");
    expect(spokenPart("- Eggs\n- [Milk](https://shop.example)")).toBe("Eggs. Milk.");
    expect(spokenPart("A rule --- inside a line stays")).toBe("A rule --- inside a line stays.");
  });

  it("feeds a streaming reply to the voice a sentence at a time, and stops at the divider", () => {
    const feed = createSentenceFeed();

    expect(feed("She wants one more", false)).toEqual([]);
    expect(feed("She wants one more round. The panel", false)).toEqual(["She wants one more round."]);
    expect(feed("She wants one more round. The panel sits in Nov", false)).toEqual([]);
    expect(feed("She wants one more round. The panel sits in 3.5 weeks.\n---\nDetail.", false)).toEqual([
      "The panel sits in 3.5 weeks.",
    ]);
    expect(feed("She wants one more round. The panel sits in 3.5 weeks.\n---\nDetail. More.", true)).toEqual([]);
  });
});
