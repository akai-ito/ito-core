import type { DatabaseSync } from "node:sqlite";
import type { Activity as GuessActivity } from "#protocol/types.ts";

// What a block of time is for. Guesses use the protocol's activities; Kumo's plan also has meals, errands and
// winding down, which it never needs to guess.
export type Activity = GuessActivity | "meals" | "errands" | "rest";

export const guessActivities: readonly GuessActivity[] = [
  "working",
  "building",
  "training",
  "people",
  "studying",
  "chilling",
  "other",
];

export const activities: readonly Activity[] = [...guessActivities, "meals", "errands", "rest"];

export const isGuessActivity = (activity: string): activity is GuessActivity =>
  (guessActivities as readonly string[]).includes(activity);

export const isActivity = (activity: string): activity is Activity =>
  (activities as readonly string[]).includes(activity);

const labels: Readonly<Record<Activity, string>> = {
  working: "Working",
  building: "Building",
  training: "Training",
  people: "Seeing people",
  studying: "Studying",
  chilling: "Chilling",
  other: "Something else",
  meals: "Meals",
  errands: "Errands",
  rest: "Winding down",
};

export const labelOf = (activity: Activity): string => labels[activity];

// Your answer to a guess: it was right, it was something else they do, or something else in their words.
export type BlockAnswer = { readonly right: true } | { readonly activity: GuessActivity } | { readonly text: string };

// One of Kumo's blocks on its own calendar: part of its plan for the day, or a guess at what they'll be doing.
export type Block = {
  readonly uid: string;
  readonly kind: "plan" | "guess";
  readonly title: string;
  readonly start: string;
  readonly end: string;
  readonly activity: Activity;
  readonly why?: string;
  readonly motion?: string;
  // The learning track it's part of, such as planning their days, so removing it is a correction there.
  readonly track?: string;
  readonly answer?: BlockAnswer;
  readonly answeredAt?: string;
  // When Kumo put it down.
  readonly at: string;
  // When they last moved it, or put it back, from Ito.
  readonly changedAt?: string;
};

export type BlockStore = {
  readonly save: (block: Block) => void;
  readonly find: (uid: string) => Block | undefined;
  // The blocks that overlap the time between two instants, in time order.
  readonly between: (from: string, to: string) => readonly Block[];
  readonly remove: (uid: string) => void;
  // Forgets blocks that began before an instant.
  readonly prune: (before: string) => void;
};

type Row = { readonly body: string };

const longestMs = 24 * 60 * 60 * 1000;

const toBlock = (row: Row): Block => JSON.parse(row.body) as Block;

export const createBlockStore = (database: DatabaseSync): BlockStore => ({
  save: (block) => {
    database
      .prepare("INSERT OR REPLACE INTO kumo_blocks (uid, start, body) VALUES (?, ?, ?)")
      .run(block.uid, block.start, JSON.stringify(block));
  },
  find: (uid) => {
    const row = database.prepare("SELECT body FROM kumo_blocks WHERE uid = ?").get(uid) as Row | undefined;
    return row && toBlock(row);
  },
  between: (from, to) =>
    (
      database
        .prepare("SELECT body FROM kumo_blocks WHERE start < ? AND start >= ? ORDER BY start")
        .all(to, new Date(Date.parse(from) - longestMs).toISOString()) as unknown as readonly Row[]
    )
      .map((row) => toBlock(row))
      .filter((block) => Date.parse(block.end) > Date.parse(from)),
  remove: (uid) => {
    database.prepare("DELETE FROM kumo_blocks WHERE uid = ?").run(uid);
  },
  prune: (before) => {
    database.prepare("DELETE FROM kumo_blocks WHERE start < ?").run(before);
  },
});
