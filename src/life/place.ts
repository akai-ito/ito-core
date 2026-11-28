import type { Calendar } from "#calendar/calendar.ts";
import type { DayNotes } from "#dream/notes.ts";
import type { JsonSchema } from "#engine/engine.ts";
import type { Lines } from "#life/lines.ts";
import type { Location } from "#location/location.ts";
import type { Memory } from "#memory/memory.ts";
import { dayTitle, toDay } from "#memory/pages.ts";
import { mentionOf, sentenceWith } from "#people/evidence.ts";
import type { KnownPerson, PeopleKeeper } from "#people/people.ts";
import type { CalendarItem, PlaceCompanion, PlaceMoment, PlacePage } from "#protocol/types.ts";
import { textOf } from "#tools/input.ts";

// A place's page: the place and every visit, then who he went with, a moment from the journal there, and Kumo's
// line about it, as in "You come back for the fig thing. Tonight's table is at 19:30, by the window." Who he went
// with comes only from what's written and the calendar on the days he was there: a line in the journal or a day
// note that names the place and them, an event with them during a visit, or the place being named after them, such
// as Leo's. Someone on the calendar there with him, still to come, comes too. Location never knows where anyone else
// is. Kumo's line is written on the quick model and kept until what it reads changes; it's absent when there's
// nothing to go on or it can't be written now.
export type PlacePages = { readonly read: (id: string) => Promise<PlacePage | undefined> };

export type PlacePagesOptions = {
  readonly location: Pick<Location, "place">;
  readonly memory: Pick<Memory, "sync" | "pages" | "page">;
  readonly dayNotes: Pick<DayNotes, "since">;
  readonly calendar: Pick<Calendar, "listItems" | "attendeesOf">;
  readonly people: Pick<PeopleKeeper, "known">;
  readonly lines: Lines;
  readonly now: () => number;
  readonly timeZone: () => string;
};

const dayMs = 24 * 60 * 60 * 1000;
// The newest days he was there that are read for who was with him and what he wrote.
const daysRead = 60;
// A stay over this many days counts only its first and last.
const longestStay = 14;
// Events there this far ahead bring who'll be with him.
const aheadMs = 14 * dayMs;
const mostCompanions = 6;
const visitsTold = 12;
const linesTold = 6;
const longestMoment = 200;

type Stay = { readonly from: number; readonly to: number; readonly days: readonly string[] };

type Together = {
  readonly person: KnownPerson;
  readonly days: ReadonlySet<string>;
  readonly last: string | undefined;
  readonly next?: { readonly day: string; readonly at?: string };
};

const plain = (line: string): string =>
  line
    .replace(/^\s*(?:[-*+]|\d+\.|#+)\s*/u, "")
    .replaceAll(/!\[[^\]]*\]\([^)]*\)/gu, "")
    .replaceAll(/\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replaceAll(/[*_`]/gu, "")
    .replaceAll(/\s+/gu, " ")
    .trim();

// The lines of a text, as plain words: a journal entry's paragraph is one line.
const linesOf = (text: string): readonly string[] =>
  text
    .split("\n")
    .map((line) => plain(line))
    .filter((line) => line !== "" && !/^\d{1,2}:\d{2}$/u.test(line));

// The line that names it, or its sentence when the line is long.
const lineWith = (text: string, mentions: (text: string) => boolean): string | undefined => {
  const line = linesOf(text).find((candidate) => mentions(candidate));
  return line === undefined || line.length <= longestMoment ? line : sentenceWith(line, mentions);
};

const lineSchema: JsonSchema = {
  type: "object",
  properties: { line: { type: "string" } },
  required: ["line"],
  additionalProperties: false,
};

const toLine = (answer: unknown): { readonly text?: string } => {
  const text = textOf(answer, "line").replaceAll(/\s+/gu, " ").trim();
  return text === "" ? {} : { text };
};

const clock = (at: number, timeZone: string): string =>
  new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone }).format(at);

const longDay = (at: number, timeZone: string): string =>
  new Intl.DateTimeFormat("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone,
  }).format(at);

const weekday = (at: number, timeZone: string): string =>
  new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone }).format(at);

export const toPlacePrompt = (facts: {
  readonly name: string;
  readonly today?: string;
  readonly visits: readonly string[];
  readonly companions: readonly string[];
  readonly coming: readonly string[];
  readonly written: readonly string[];
}): string =>
  [
    `You are Kumo, their assistant. Write your line on the page for ${facts.name} in Ito's Life view: one or two`,
    'short sentences, at most 20 words, to them as "you", about what the place is to them, such as "You come back',
    "for the fig thing. Tonight's table is at 19:30, by the window.\"",
    "- Only what the notes below say. No counts of visits or hours, no guesses at feelings.",
    "- When the notes say nothing worth a line, answer with nothing.",
    "",
    ...(facts.today === undefined ? [] : [`Today is ${facts.today}.`, ""]),
    "Their visits, newest first:",
    ...facts.visits,
    "",
    ...(facts.companions.length > 0 ? ["Who was with them there:", ...facts.companions, ""] : []),
    ...(facts.coming.length > 0 ? ["On their calendar there, still to come:", ...facts.coming, ""] : []),
    ...(facts.written.length > 0 ? ["What they wrote on days they were there:", ...facts.written, ""] : []),
    "Answer with the line.",
  ].join("\n");

// The latest of some days, or the earliest.
const latestOf = (days: ReadonlySet<string>, earliest = false): string | undefined => {
  const sorted = [...days].toSorted((left, right) => left.localeCompare(right));
  return earliest ? sorted[0] : sorted.at(-1);
};

const times = (count: number): string => (count === 1 ? "once" : count === 2 ? "twice" : `${String(count)} times`);

export const createPlacePages = ({
  location,
  memory,
  dayNotes,
  calendar,
  people,
  lines,
  now,
  timeZone,
}: PlacePagesOptions): PlacePages => ({
  read: async (id) => {
    const page = location.place(id);
    if (!page) return;
    const { place, visits } = page;
    const zone = timeZone();
    const at = now();
    const names = [place.name, place.apple_name].filter((name): name is string => name !== undefined);
    const namesIt = mentionOf(names);
    const stays = visits
      .flatMap((visit): readonly Stay[] => {
        const from = Date.parse(visit.arrived_at ?? visit.departed_at ?? "");
        if (Number.isNaN(from)) return [];
        const to = visit.departed_at === undefined ? at : Date.parse(visit.departed_at);
        const first = toDay(from, zone);
        const last = toDay(to, zone);
        const span = Math.round((Date.parse(last) - Date.parse(first)) / dayMs);
        const days =
          span > longestStay
            ? [first, last]
            : Array.from({ length: span + 1 }, (_, offset) => toDay(from + offset * dayMs, zone));
        return [{ from, to, days: [...new Set([...days, last])] }];
      })
      .slice(0, daysRead);
    const visitDays = new Set(stays.flatMap(({ days }) => days));
    await memory.sync();
    const journalDays = memory
      .pages("journal")
      .map((summary) => summary.address.slice("memory:journal/".length))
      .filter((day) => visitDays.has(day))
      .toSorted((left, right) => right.localeCompare(left));
    const journal = journalDays.flatMap((day) => {
      const read = memory.page(`memory:journal/${day}`);
      return read.ok ? { day, address: read.value.address, markdown: read.value.markdown } : [];
    });
    const oldest = latestOf(visitDays, true);
    const notes = oldest === undefined ? [] : dayNotes.since(oldest).filter((note) => visitDays.has(note.day));
    const items = calendar.listItems().filter((item) => !item.calendar.kumo && !item.all_day);
    const known = await people.known();

    const isThere = (item: CalendarItem): boolean =>
      names.length > 0 && (namesIt(item.title) || (item.location !== undefined && namesIt(item.location)));
    const during = (item: CalendarItem): readonly string[] => {
      const start = Date.parse(item.start);
      const end = Date.parse(item.end);
      return stays.filter((stay) => start < stay.to && end > stay.from).map((stay) => toDay(stay.from, zone));
    };
    const ahead = items
      .filter((item) => {
        const start = Date.parse(item.start);
        return start > at && start <= at + aheadMs && isThere(item);
      })
      .toSorted((left, right) => left.start.localeCompare(right.start));
    const overlapping = items.map((item) => ({ item, days: during(item) })).filter(({ days }) => days.length > 0);
    // Who's invited, read once for each event that matters here.
    const invited = new Map(
      [...overlapping.map(({ item }) => item), ...ahead].map(
        (item) => [item.uid, calendar.attendeesOf(item.uid).map((who) => who.toLowerCase())] as const,
      ),
    );
    const isWith = (item: CalendarItem, person: KnownPerson, mentions: (text: string) => boolean): boolean =>
      mentions(item.title) ||
      (item.location !== undefined && mentions(item.location)) ||
      (invited.get(item.uid) ?? []).some((who) => person.emails.includes(who) || mentions(who));
    const writtenLines = [
      ...journal.flatMap(({ day, markdown }) => linesOf(markdown).map((text) => ({ day, text }))),
      ...notes.map(({ day, text }) => ({ day, text: plain(text) })),
    ].filter(({ text }) => names.length > 0 && namesIt(text));

    const together = known.flatMap((person): readonly Together[] => {
      const mentions = mentionOf(person.names);
      const namedAfter = names.some((name) => mentions(name));
      const days = new Set([
        ...(namedAfter ? stays.map((stay) => toDay(stay.from, zone)) : []),
        ...writtenLines.filter(({ text }) => mentions(text)).map(({ day }) => day),
        ...overlapping.filter(({ item }) => isWith(item, person, mentions)).flatMap(({ days: on }) => on),
      ]);
      const next = ahead.find((item) => isWith(item, person, mentions));
      if (next === undefined && days.size === 0) return [];
      return [
        {
          person,
          days,
          last: latestOf(days),
          ...(next !== undefined && {
            next: { day: toDay(Date.parse(next.start), zone), at: new Date(next.start).toISOString() },
          }),
        },
      ];
    });
    const companions: readonly PlaceCompanion[] = together
      .toSorted(
        (left, right) =>
          right.days.size - left.days.size ||
          (right.last ?? "").localeCompare(left.last ?? "") ||
          (left.next?.at ?? "").localeCompare(right.next?.at ?? "") ||
          left.person.name.localeCompare(right.person.name),
      )
      .slice(0, mostCompanions)
      .map(({ person, days, last, next }) => ({
        person: person.id,
        name: person.name,
        ...(person.photo !== undefined && { photo: person.photo }),
        visits: days.size,
        ...(last !== undefined && { last }),
        ...(next !== undefined && { next }),
      }));

    const found = journal
      .map(({ day, address, markdown }) => ({
        day,
        address,
        text: names.length > 0 ? lineWith(markdown, namesIt) : undefined,
      }))
      .find(({ text }) => text !== undefined);
    const moment: PlaceMoment | undefined =
      found?.text === undefined ? undefined : { day: found.day, text: found.text, journal: found.address };

    const title = place.name ?? place.apple_name;
    const coming = ahead.map(
      (item) =>
        `- ${weekday(Date.parse(item.start), zone)} at ${clock(Date.parse(item.start), zone)}: ${item.title}${item.location === undefined ? "" : ` (${item.location})`}`,
    );
    const hasFacts = writtenLines.length > 0 || companions.length > 0 || coming.length > 0;
    const prompt =
      title === undefined || !hasFacts
        ? undefined
        : toPlacePrompt({
            name:
              place.apple_name === undefined || place.apple_name === title
                ? title
                : `${title} (Apple calls it ${place.apple_name})`,
            ...(coming.length > 0 && { today: longDay(at, zone) }),
            visits: stays
              .slice(0, visitsTold)
              .map(
                (stay) =>
                  `- ${weekday(stay.from, zone)}, from ${clock(stay.from, zone)}${stay.to < at ? ` to ${clock(stay.to, zone)}` : ""}`,
              ),
            companions: companions
              .filter(({ visits: count }) => count > 0)
              .map(({ name, visits: count }) => `- ${name}, ${times(count)}`),
            coming,
            written: writtenLines
              .slice(0, linesTold)
              .map(({ day, text }) => `- ${dayTitle(day)}: ${text.slice(0, longestMoment)}`),
          });
    const line =
      prompt === undefined
        ? undefined
        : await lines.write({ key: `place:${id}`, basis: prompt, prompt, schema: lineSchema, toValue: toLine });
    return {
      place,
      visits,
      companions: [...companions],
      ...(moment !== undefined && { moment }),
      ...(line?.text !== undefined && { line: line.text }),
    };
  },
});
