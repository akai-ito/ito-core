import { describe, expect, it } from "vitest";
import { askAloud, createSentenceFeed, longestSpoken, spokenPart, toClauses } from "#voice/spoken.ts";

const words = (text: string): number => text.split(" ").length;

describe("what Ari says on a call", () => {
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

  it("says a long sentence in clauses, cutting at the punctuation nearest its middle", () => {
    const long =
      "I looked through every note from the trip last spring, including the ones from the train, and the main " +
      "thing is that the budget review moved to Friday afternoon so the draft has to reach Maya by Thursday.";
    expect(toClauses(long)).toEqual([
      "I looked through every note from the trip last spring, including the ones from the train,",
      "and the main thing is that the budget review moved to Friday afternoon so the draft has to reach Maya by Thursday.",
    ]);
    expect(toClauses(Array.from({ length: 60 }, () => "word").join(" ")).map(words)).toEqual([15, 15, 15, 15]);
    expect(toClauses("Short and sweet.")).toEqual(["Short and sweet."]);
    expect(toClauses(long).every((clause) => words(clause) <= longestSpoken)).toBe(true);
  });

  it("says an ask with its choices, and an approval's preview first", () => {
    const options = [{ label: "Add it" }, { label: "Leave it" }];

    expect(askAloud({ kind: "question", question: "Shall I add a reminder?", options })).toEqual([
      "Shall I add a reminder?",
      "Add it, or Leave it?",
    ]);
    expect(askAloud({ kind: "question", question: "Add it or leave it?", options })).toEqual(["Add it or leave it?"]);
    expect(
      askAloud({
        kind: "approval",
        question: "Shall I add it?",
        options: [{ label: "Add reminder", acts: true }, { label: "Don't" }],
        preview: "**Calendar:** Call Mum, Sunday 1 November, 2pm London",
      }),
    ).toEqual(["Calendar: Call Mum, Sunday 1 November, 2pm London.", "Shall I add it?", "Add reminder, or Don't?"]);
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
