import type { DatabaseSync } from "node:sqlite";
import { toTimestamp, type Clock } from "#clock.ts";
import { toDay } from "#memory/pages.ts";
import { fieldOf, textOf } from "#tools/input.ts";
import type { Tool, ToolResult } from "#tools/mcp.ts";

// Day notes: during the day Kumo keeps notes for the dream rather than writing finished journal entries. A note is
// what happened, or their own words, with the day it's about (today unless it happened earlier, such as something
// they mention days later). The dream reads the notes it hasn't taken in yet and writes each day's journal entry
// whole, in the first person, from them and everything else it reads.
export type DayNote = {
  readonly id: number;
  readonly at: string;
  // The local day it's about, such as 2026-11-26.
  readonly day: string;
  readonly text: string;
  // Their own words, kept as they said them.
  readonly yours: boolean;
};

export type DayNotes = {
  readonly tool: Tool;
  // The notes no dream has taken in yet, oldest first.
  readonly waiting: () => readonly DayNote[];
  // Every note still kept about a day since this one (YYYY-MM-DD), taken in or not, oldest first.
  readonly since: (day: string) => readonly DayNote[];
  // A dream took these in.
  readonly taken: (notes: readonly DayNote[], dream: string) => void;
};

export type DayNotesOptions = {
  readonly database: DatabaseSync;
  readonly clock: Clock;
  readonly timeZone: () => string;
};

type Row = { readonly id: number; readonly at: string; readonly day: string; readonly body: string };

type Body = { readonly text: string; readonly yours?: true };

// Notes a dream took in stay this long, then go: the journal holds what they became.
const keptMs = 30 * 24 * 60 * 60 * 1000;

// A dream digests at most this many, newest kept; more than this in a day is a log, not notes.
const mostWaiting = 200;

const dayPattern = /^\d{4}-\d{2}-\d{2}$/u;

const failed = (text: string): ToolResult => ({ text, isError: true });

const isDay = (text: string): boolean => {
  const at = Date.parse(`${text}T00:00:00.000Z`);
  return dayPattern.test(text) && !Number.isNaN(at) && new Date(at).toISOString().startsWith(text);
};

const toNote = ({ id, at, day, body }: Row): DayNote => {
  const { text, yours } = JSON.parse(body) as Body;
  return { id, at, day, text, yours: yours === true };
};

export const createDayNotes = ({ database, clock, timeZone }: DayNotesOptions): DayNotes => {
  const tool: Tool = {
    name: "note_day",
    title: "Keep a note for tonight",
    description:
      "Keep a note for tonight's dream, when you'll write the day's journal entry in their own voice. Note what " +
      "happens in their life as it comes up, from anywhere: a moment, someone they saw, how a thing went, big news " +
      "they read in their mail, a photo of a moment (![what it shows](uploads/photo.jpg)). Their own words go in " +
      "with yours: true, exactly as they said them. Something they mention that happened on an earlier day gets " +
      "that day. Notes are for you, short and plain; never admin, and never your guess at their feelings.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "What happened, or their words, in a line or a few." },
        yours: { type: "boolean", description: "True when these are their own words, as they said them." },
        day: {
          type: "string",
          description: "The day it happened, as YYYY-MM-DD, when it wasn't today, such as last Saturday's race.",
        },
      },
      required: ["text"],
      additionalProperties: false,
    },
    call: (input) => {
      const text = textOf(input, "text").trim();
      if (text === "") return Promise.resolve(failed("Give the note's text."));
      const today = toDay(clock.now(), timeZone());
      const given = textOf(input, "day").trim();
      if (given !== "" && !isDay(given)) return Promise.resolve(failed(`${given} isn't a day: give it as YYYY-MM-DD.`));
      if (given > today) return Promise.resolve(failed("A note is about something that's happened: not a later day."));
      const day = given || today;
      const body: Body = { text, ...(fieldOf(input, "yours") === true && { yours: true }) };
      database
        .prepare("INSERT INTO day_notes (at, day, body) VALUES (?, ?, ?)")
        .run(toTimestamp(clock.now()), day, JSON.stringify(body));
      database
        .prepare("DELETE FROM day_notes WHERE dream IS NOT NULL AND at < ?")
        .run(toTimestamp(clock.now() - keptMs));
      return Promise.resolve({ text: day === today ? "Noted for tonight." : `Noted for tonight, for ${day}.` });
    },
  };

  return {
    tool,
    since: (day) =>
      (
        database
          .prepare("SELECT id, at, day, body FROM day_notes WHERE day >= ? ORDER BY day, id")
          .all(day) as unknown as readonly Row[]
      ).map((row) => toNote(row)),
    waiting: () =>
      (
        database
          .prepare("SELECT id, at, day, body FROM day_notes WHERE dream IS NULL ORDER BY id DESC LIMIT ?")
          .all(mostWaiting) as unknown as readonly Row[]
      )
        .toReversed()
        .map((row) => toNote(row)),
    taken: (notes, dream) => {
      const last = notes.at(-1)?.id;
      if (last === undefined) return;
      database.prepare("UPDATE day_notes SET dream = ? WHERE dream IS NULL AND id <= ?").run(dream, last);
    },
  };
};
