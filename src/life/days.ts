import type { DayNotes } from "#dream/notes.ts";
import type { Lines } from "#life/lines.ts";
import type { LifePlaces } from "#life/places.ts";
import type { Memory } from "#memory/memory.ts";
import { toDay } from "#memory/pages.ts";
import type { JsonSchema } from "#engine/engine.ts";
import type { LifeDay, LifeDays, LifeWeek } from "#protocol/types.ts";
import { fail, ok, type Result } from "#result.ts";
import { fieldOf, textOf } from "#tools/input.ts";

// Days, for the Week, Month and Year sheets: each day of a range with its journal line and its thread of places,
// the chapters it overlaps as spans, its trips, and Kumo's line for the range, such as "Home and the office, mostly.
// The gym four times, Leo's on Thursday." A month also has a line for each of its weeks. Kumo's lines are written
// on the quick model and kept until what they're written from changes.
export type Days = { readonly range: (from: string, to: string) => Promise<Result<LifeDays, string>> };

export type DaysOptions = {
  readonly memory: Pick<Memory, "sync" | "pages" | "chapters">;
  readonly dayNotes: Pick<DayNotes, "since">;
  readonly places: LifePlaces;
  readonly lines: Lines;
  readonly now: () => number;
  readonly timeZone: () => string;
};

const dayMs = 24 * 60 * 60 * 1000;
const dayPattern = /^\d{4}-\d{2}-\d{2}$/u;

// The longest range: a year, with a leap day.
export const longestRange = 366;
// Ranges up to a month have each day's thread of places, and lines for their weeks past a week.
const threadsUpTo = 31;
const weeksUpTo = 62;

const indexOf = (day: string): number => Math.round(Date.parse(`${day}T00:00:00.000Z`) / dayMs);
const dayAt = (index: number): string => new Date(index * dayMs).toISOString().slice(0, 10);
const isDay = (text: string): boolean => dayPattern.test(text) && dayAt(indexOf(text)) === text;
const earlier = (left: string, right: string): string => (left.localeCompare(right) <= 0 ? left : right);
const later = (left: string, right: string): string => (left.localeCompare(right) >= 0 ? left : right);

const weekday = (day: string): string =>
  new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }).format(
    new Date(`${day}T00:00:00.000Z`),
  );

// Monday is 0.
const weekdayIndex = (day: string): number => (new Date(`${day}T00:00:00.000Z`).getUTCDay() + 6) % 7;

const linesSchema: JsonSchema = {
  type: "object",
  properties: {
    line: { type: "string" },
    weeks: {
      type: "array",
      items: {
        type: "object",
        properties: { from: { type: "string" }, line: { type: "string" } },
        required: ["from", "line"],
        additionalProperties: false,
      },
    },
  },
  required: ["line", "weeks"],
  additionalProperties: false,
};

type Written = { readonly line?: string; readonly weeks: Readonly<Record<string, string>> };

const oneLine = (text: string): string => text.replaceAll(/\s+/gu, " ").trim();

const toWritten = (answer: unknown): Written | undefined => {
  const line = oneLine(textOf(answer, "line"));
  const listed = fieldOf(answer, "weeks");
  const weeks = Array.isArray(listed)
    ? Object.fromEntries(
        listed.flatMap((week: unknown) => {
          const text = oneLine(textOf(week, "line"));
          return text === "" ? [] : [[textOf(week, "from"), text]];
        }),
      )
    : {};
  return line === "" && Object.keys(weeks).length === 0 ? undefined : { ...(line !== "" && { line }), weeks };
};

const scale = (days: number): string => (days <= 7 ? "week" : days <= weeksUpTo ? "month" : "year");

export const toLinesPrompt = (
  from: string,
  to: string,
  facts: {
    readonly days: readonly LifeDay[];
    readonly weeks: readonly LifeWeek[];
    readonly chapters: readonly string[];
    readonly places: readonly string[];
  },
): string => {
  const span = indexOf(to) - indexOf(from) + 1;
  const gists = facts.days.filter((day) => day.gist !== undefined).toReversed();
  return [
    `You are Kumo, their assistant. Write the line at the top of their ${scale(span)} in Ito's Life view, from ${from}`,
    `to ${to}: one or two short sentences, at most 20 words, to them as "you", saying what the ${scale(span)} was`,
    'mostly, such as "Home and the office, mostly. The gym four times, Leo\'s on Thursday." or "Three continents.',
    'India was the longest: two weeks, for a wedding."',
    "- Only what the notes below say. No dates, no numbers of hours, no guesses at feelings, no lists of everything.",
    ...(facts.weeks.length > 0
      ? [
          '- For each week listed, also its own line, at most 10 words, such as "The final, and a lot of the office.",',
          "  under the day it begins (`from`). Leave out a week its notes say nothing about.",
        ]
      : ["- There are no weeks to write lines for: give none."]),
    "",
    ...(gists.length > 0
      ? ["Their journal, a line a day:", ...gists.map((day) => `${weekday(day.day)}: ${day.gist ?? ""}`), ""]
      : []),
    ...(facts.weeks.length > 0 ? ["Weeks:", ...facts.weeks.map((week) => `${week.from} to ${week.to}`), ""] : []),
    ...(facts.chapters.length > 0 ? ["Chapters of their life it overlaps:", ...facts.chapters, ""] : []),
    ...(facts.places.length > 0 ? ["Where the time went:", ...facts.places, ""] : []),
    "Answer with the line, and the weeks' lines.",
  ].join("\n");
};

export const createDays = ({ memory, dayNotes, places, lines, now, timeZone }: DaysOptions): Days => ({
  range: async (from, to) => {
    if (!isDay(from) || !isDay(to)) return fail("Give from and to as YYYY-MM-DD.");
    if (to < from) return fail("from comes before to.");
    const span = indexOf(to) - indexOf(from) + 1;
    if (span > longestRange) return fail(`A range is at most ${String(longestRange)} days.`);
    await memory.sync();
    const today = toDay(now(), timeZone());
    const last = earlier(to, today);
    const journal = new Map(
      memory
        .pages("journal")
        .map((page) => [page.address.slice("memory:journal/".length), page] as const)
        .filter(([day]) => day >= from && day <= last),
    );
    const notes = dayNotes
      .since(from)
      .filter((note) => note.day <= last)
      .reduce(
        (counts, note) => new Map([...counts, [note.day, (counts.get(note.day) ?? 0) + 1]]),
        new Map<string, number>(),
      );
    const withThreads = span <= threadsUpTo;
    const days: readonly LifeDay[] =
      last < from
        ? []
        : Array.from({ length: indexOf(last) - indexOf(from) + 1 }, (_, offset) => dayAt(indexOf(last) - offset)).map(
            (day) => {
              const page = journal.get(day);
              const thread = withThreads ? places.threadOf(day) : undefined;
              const noted = notes.get(day) ?? 0;
              return {
                day,
                ...(page?.gist !== undefined && { gist: page.gist }),
                ...(page && { journal: page.address }),
                ...(noted > 0 && { notes: noted }),
                ...(thread && { thread }),
              };
            },
          );
    const weekStarts =
      span > 7 && span <= weeksUpTo && last >= from
        ? Array.from({ length: Math.ceil((indexOf(last) - indexOf(from) + 1 + weekdayIndex(from)) / 7) }, (_, week) =>
            dayAt(indexOf(from) - weekdayIndex(from) + week * 7),
          )
        : [];
    const weeks: readonly LifeWeek[] = weekStarts
      .map((start) => {
        const end = dayAt(indexOf(start) + 6);
        return { from: later(start, from), to: earlier(end, last) };
      })
      .toReversed();
    const chapters = memory
      .chapters()
      .filter((chapter) => chapter.began <= to && (chapter.ended === undefined || chapter.ended >= from))
      .toSorted((left, right) => left.began.localeCompare(right.began));
    const trips = places.trips(from, to);
    const facts = {
      days: span <= weeksUpTo ? days : [],
      weeks,
      chapters: chapters.map(
        (chapter) =>
          `${chapter.title}, ${chapter.began} to ${chapter.ended ?? "now"}${chapter.gist === undefined ? "" : `: ${chapter.gist}`}`,
      ),
      places: places.summary(from, to),
    };
    const hasFacts =
      facts.days.some((day) => day.gist !== undefined) || facts.chapters.length > 0 || facts.places.length > 0;
    const prompt = toLinesPrompt(from, to, facts);
    const written = hasFacts
      ? await lines.write({ key: `days:${from}:${to}`, basis: prompt, prompt, schema: linesSchema, toValue: toWritten })
      : undefined;
    return ok({
      from,
      to,
      ...(written?.line !== undefined && { line: written.line }),
      days: [...days],
      ...(weeks.length > 0 && {
        weeks: weeks.map((week) => {
          const line = written?.weeks[week.from] ?? written?.weeks[dayAt(indexOf(week.from) - weekdayIndex(week.from))];
          return { ...week, ...(line !== undefined && { line }) };
        }),
      }),
      chapters,
      trips: [...trips],
    });
  },
});
