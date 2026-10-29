import { describe, expect, it } from "vitest";
import type { Term } from "#memory/vocabulary.ts";
import { correct, soundsAlike } from "#voice/corrector.ts";
import { askAloud, createSentenceFeed, longestSpoken, secretAloud, spokenPart, toClauses } from "#voice/spoken.ts";

const term = (text: string, kind: Term["kind"], heard: readonly string[] = []): Term => ({
  text,
  kind,
  weight: 1,
  phrases: [],
  heard: [...heard],
});

const words = (text: string): number => text.split(" ").length;

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

  it("only trusts a learnt mishearing that sounds like the word it stands for", () => {
    expect(soundsAlike("Bara", "Bora")).toBe(true);
    expect(soundsAlike("cutie", "QRT")).toBe(true);
    expect(soundsAlike("cutie panel", "QRT panel")).toBe(true);
    expect(soundsAlike("wallets", "Ivona")).toBe(false);
    expect(correct("I lost my wallets", [term("Ivona", "person", ["wallets"])]).text).toBe("I lost my wallets");
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

  it("says an ask with its choices, an approval's preview first, and never a secret", () => {
    const options = [{ label: "Add it" }, { label: "Leave it" }];

    expect(askAloud({ kind: "question", question: "Shall I add a reminder?", options, secret: false })).toEqual([
      "Shall I add a reminder?",
      "Add it, or Leave it?",
    ]);
    expect(askAloud({ kind: "question", question: "Add it or leave it?", options, secret: false })).toEqual([
      "Add it or leave it?",
    ]);
    expect(
      askAloud({
        kind: "approval",
        question: "Shall I add it?",
        options: [{ label: "Add reminder", acts: true }, { label: "Don't" }],
        preview: "**Calendar:** Call Mum, Sunday 1 November, 2pm London",
        secret: false,
      }),
    ).toEqual(["Calendar: Call Mum, Sunday 1 November, 2pm London.", "Shall I add it?", "Add reminder, or Don't?"]);
    expect(askAloud({ kind: "question", question: "What's the code?", options: [], secret: true })).toEqual([
      secretAloud,
    ]);
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
