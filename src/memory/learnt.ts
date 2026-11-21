import { toOneLine } from "#memory/gists.ts";
import { isReading } from "#memory/pages.ts";
import { fail, ok, type Result } from "#result.ts";
import { fieldOf, textOf } from "#tools/input.ts";
import type { Tool } from "#tools/mcp.ts";

// What Kumo learnt about them lately: a line to them, in its own words, given with the memory write that holds
// it, such as "Half marathons suit you more than 5Ks." The Library shows the newest few as a reflection. A write
// that only tidies, reconciles or fixes records gives none, so housekeeping never shows there. Each line is kept
// with its change, and in the Thread too, in its commit as a Learnt: trailer.

export const learntGuide =
  "Only when this change taught you something new about them: one line to them, as “you”, in your own warm " +
  "words, such as “Half marathons suit you more than 5Ks.” They read these in Ito as what you learnt lately. " +
  "Leave it out when the change only tidies, reconciles, moves or fixes records, and never give a guess at " +
  "their feelings, relationships or motives.";

// How many lines the Library shows: what's lately, not everything.
export const learntShown = 5;

export type LearntBody = {
  readonly text: string;
  readonly at: string;
  readonly address: string;
  readonly change: string;
};

const readingLearnt =
  "That's your reading of them, not something you learnt: keep it in the journal with reading: true, and leave " +
  "learnt out.";

// The line a write gives, as one line; none when it gives none, and a refusal for a reading of them.
export const toLearnt = (input: unknown): Result<string | undefined, string> => {
  const line = toOneLine(textOf(input, "learnt"));
  if (line === "") return ok(undefined);
  return isReading(line) || fieldOf(input, "reading") === true ? fail(readingLearnt) : ok(line);
};

// A commit message with what Kumo learnt as its trailer, so the Thread keeps it too.
export const withLearnt = (message: string, learnt: string | undefined): string =>
  learnt === undefined ? message : `${message}\n\nLearnt: ${learnt}`;

export type LearntOperations = {
  readonly whenReady: <Value>(work: () => Promise<Value>) => Promise<Value>;
  // The lines lately that say any of the words.
  readonly find: (words: readonly string[]) => readonly LearntBody[];
  // Takes back the lines lately that say any of the words, and gives what it took back.
  readonly withdraw: (words: readonly string[]) => readonly LearntBody[];
};

const minimumWord = 3;

const wordsIn = (input: unknown): readonly string[] =>
  (Array.isArray(fieldOf(input, "words")) ? (fieldOf(input, "words") as readonly unknown[]) : [])
    .filter((word): word is string => typeof word === "string")
    .map((word) => word.trim())
    .filter((word) => word.length >= minimumWord);

export const formatLearnt = ({ text, at }: LearntBody): string => `${at.slice(0, 10)}  “${text}”`;

// What find_in_memory adds when lines lately say the words too.
export const learntCopiesText = (lines: readonly LearntBody[]): string =>
  lines.length === 0
    ? ""
    : `\nWhat you learnt lately says it too; if it's wrong, take it back with unlearn:\n${lines.map((line) => `  ${formatLearnt(line)}`).join("\n")}`;

export const createLearntTools = (learnt: LearntOperations): readonly Tool[] => [
  {
    name: "unlearn",
    title: "Take back something you learnt",
    description:
      "Take back lines from what you learnt lately that were wrong, by a few of their words, so they leave " +
      "the Library; their page keeps its history. Use it when they say a line isn't right, and put right any " +
      "page that says the same.",
    inputSchema: {
      type: "object",
      properties: {
        words: {
          type: "array",
          items: { type: "string" },
          description: "A few distinctive words from each line, such as “half marathons suit you”.",
        },
      },
      required: ["words"],
      additionalProperties: false,
    },
    call: (input) =>
      learnt.whenReady(() => {
        const words = wordsIn(input);
        if (words.length === 0) {
          return Promise.resolve({
            text: "Give a word or phrase of three letters or more from the line.",
            isError: true,
          });
        }
        const taken = learnt.withdraw(words);
        return Promise.resolve({
          text:
            taken.length === 0
              ? "Nothing you learnt lately says that."
              : `Took back ${taken.map(({ text }) => `“${text}”`).join(", ")}`,
        });
      }),
  },
];
