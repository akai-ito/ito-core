import { toTimestamp, type Clock } from "#clock.ts";
import { toThreadId, type ThreadId } from "#conversation/ids.ts";
import { atLocal, nextDay, toLocal } from "#desk/day.ts";
import { clockOf, hourMs, weekdayOf } from "#day/time.ts";
import { lineOf } from "#notifications/text.ts";
import type { CalendarItem, DoneEntry, Message, Thread, WakeUp } from "#protocol/types.ts";
import type { Store } from "#store/store.ts";
import { squeeze } from "#threads/threads.ts";

// Today so far: one short account of the day across the main chat and every side thread, with what Kumo did and
// what's next, in every turn and every piece of background work. Each conversation otherwise sees only its own
// slice, so nothing joins the day up: a check-in twice, a question already answered in another thread, a plan that
// stalls. It's written here from the store as it is, so it never goes stale and costs no model call, and it's
// bounded: the newest first, with Kumo's replies cut shorter than their words and its messages, until each part's
// room runs out.

// Where a turn is: the main chat (no thread) or a side thread. Background work is nowhere, so it sees everything.
export type Here = { readonly thread: ThreadId | undefined };

export type Today = {
  // For a turn, which has its own conversation already and so leaves it out, or for background work.
  readonly text: (here?: Here) => string;
};

export type TodayOptions = {
  readonly store: Pick<Store, "messagesSince" | "findThread" | "doneSince" | "latestMessages">;
  readonly clock: Clock;
  readonly timeZone: () => string;
  // Kumo's wake-ups, soonest first.
  readonly wakeUps: () => readonly WakeUp[];
  // Their calendars and Kumo's, as last read.
  readonly calendar: () => readonly CalendarItem[];
};

// The day starts at 04:00 where they are, so a late night still belongs to the day it began in.
export const dayStartMinutes = 4 * 60;

// How much of each part fits, in characters: about a thousand tokens in all, at four characters a token.
export const room = { said: 2400, done: 900, next: 500 } as const;

const scanned = 400;
const theirLength = 220;
const yourLength = 150;
const doneLength = 170;
const mostNext = 8;

// When their day began: today's 04:00, or yesterday's in the small hours.
export const dayStartOf = (now: number, timeZone: string): number => {
  const { day, minutes } = toLocal(now, timeZone);
  if (minutes >= dayStartMinutes) return atLocal(day, dayStartMinutes, timeZone);
  const yesterday = toLocal(atLocal(day, 0, timeZone) - 12 * hourMs, timeZone).day;
  return atLocal(yesterday, dayStartMinutes, timeZone);
};

type Said = { readonly message: Message; readonly line: string };

type Conversation = { readonly thread: ThreadId | undefined; readonly shown: readonly Said[]; readonly count: number };

// Lines, newest first, while they fit in the room; the rest are counted.
const fitting = <Item>(items: readonly Item[], length: (item: Item) => number, most: number): readonly Item[] =>
  items.reduce<{ readonly kept: readonly Item[]; readonly used: number; readonly isFull: boolean }>(
    (fit, item) => {
      if (fit.isFull) return fit;
      const used = fit.used + length(item) + 1;
      return used > most ? { ...fit, isFull: true } : { kept: [...fit.kept, item], used, isFull: false };
    },
    { kept: [], used: 0, isFull: false },
  ).kept;

const plural = (count: number, one: string): string => `${String(count)} ${count === 1 ? one : `${one}s`}`;

// `14:20` today, `Wed 00:30` on another day.
const when = (at: number, now: number, zone: string): string =>
  toLocal(at, zone).day === toLocal(now, zone).day ? clockOf(at, zone) : `${weekdayOf(at, zone)} ${clockOf(at, zone)}`;

const whoSaid = (message: Message): string =>
  message.role === "user" ? "they" : message.kind === "post" ? "you messaged them" : "you";

const itemMark = (item: CalendarItem): string => {
  if (item.calendar.kumo) return item.guess === undefined ? " · your block" : " · your guess";
  return item.status === "hold" ? " · held" : item.status === "tentative" ? " · tentative" : "";
};

const toSaid = (message: Message, now: number, zone: string): Said => {
  const most = message.role === "user" || message.kind === "post" ? theirLength : yourLength;
  const words = squeeze(message.text, most) || lineOf("", message.attachments);
  return { message, line: `- ${when(Date.parse(message.at), now, zone)} ${whoSaid(message)}: ${words}` };
};

const doneLines = (entries: readonly DoneEntry[], now: number, zone: string): readonly string[] => {
  const loud = entries.filter(({ quiet }) => !quiet);
  const quiet = entries.length - loud.length;
  const lines = loud.map(
    ({ at, text, reason, corrected_at: corrected }) =>
      `- ${when(Date.parse(at), now, zone)} ${squeeze(`${text}${reason === undefined ? "" : `: ${reason}`}`, doneLength)}` +
      (corrected === undefined ? "" : " (they said this was wrong)"),
  );
  const shown = fitting(lines, (line) => line.length, room.done);
  const more = lines.length - shown.length;
  return entries.length === 0
    ? []
    : [
        "What you did today, from your Done list (written to them), newest first:",
        ...shown,
        ...(more > 0 ? [`  (and ${String(more)} more)`] : []),
        ...(quiet > 0 ? [`  (and ${plural(quiet, "mail")} read with nothing needed)`] : []),
      ];
};

export const createToday = ({ store, clock, timeZone, wakeUps, calendar }: TodayOptions): Today => {
  const titleOf = (thread: ThreadId | undefined): string => {
    if (thread === undefined) return "the main chat";
    const title = store.findThread(thread)?.title;
    return `${title === undefined ? "a thread not yet named" : `“${title}”`} (${thread})`;
  };

  const nameOf = (thread: ThreadId | undefined): string => {
    if (thread === undefined) return "The main chat";
    const found: Thread | undefined = store.findThread(thread);
    const name = found?.title === undefined ? "A thread not yet named" : `“${found.title}”`;
    const state = found?.state === "done" ? ", marked done" : "";
    return `${name} (${thread}), a thread${state}${found?.result === undefined ? "" : ` (${found.result})`}`;
  };

  const conversationLines = ({ thread, shown, count }: Conversation): readonly string[] => [
    `${nameOf(thread)}:`,
    ...(count > shown.length ? [`  (${plural(count - shown.length, "earlier message")} today)`] : []),
    ...shown.toReversed().map(({ line }) => line),
  ];

  const saidLines = (said: readonly Said[], here: Here | undefined): readonly string[] => {
    const elsewhere = said.filter(({ message }) => here === undefined || message.thread !== here.thread);
    const shown = new Set(fitting(elsewhere, ({ line }) => line.length, room.said));
    const keys = [...new Set(elsewhere.map(({ message }) => message.thread ?? ""))];
    const conversations = keys.map((key): Conversation => {
      const inIt = elsewhere.filter(({ message }) => (message.thread ?? "") === key);
      return {
        thread: key === "" ? undefined : toThreadId(key),
        shown: inIt.filter((item) => shown.has(item)),
        count: inIt.length,
      };
    });
    const listed = conversations.filter(({ shown: lines }) => lines.length > 0);
    const unlisted = conversations.filter(({ shown: lines }) => lines.length === 0);
    return [
      ...listed.flatMap((conversation) => conversationLines(conversation)),
      ...(unlisted.length === 0
        ? []
        : [
            `Earlier today, also: ${unlisted
              .map(({ thread, count }) => `${titleOf(thread)}, ${plural(count, "message")}`)
              .join("; ")}.`,
          ]),
    ];
  };

  const nextLines = (now: number, until: number, zone: string): readonly string[] => {
    const plans = wakeUps()
      .filter(({ at }) => Date.parse(at) >= now && Date.parse(at) < until)
      .map(({ at, title }) => ({ at: Date.parse(at), line: `- ${when(Date.parse(at), now, zone)} wake-up: ${title}` }));
    const items = calendar()
      .filter((item) => !item.all_day && Date.parse(item.end) > now && Date.parse(item.start) < until)
      .map((item) => {
        const start = Date.parse(item.start);
        const from = start < now ? "now" : when(start, now, zone);
        return {
          at: Math.max(start, now),
          line: `- ${from}–${clockOf(Date.parse(item.end), zone)} ${squeeze(item.title, 60)}${itemMark(item)}`,
        };
      });
    const lines = [...plans, ...items]
      .toSorted((left, right) => left.at - right.at)
      .slice(0, mostNext)
      .map(({ line }) => line);
    const shown = fitting(lines, (line) => line.length, room.next);
    return shown.length === 0 ? [] : ["Still to come today, soonest first:", ...shown];
  };

  // Background work with nothing said yet today still knows where the conversation left off.
  const lastSaid = (now: number, zone: string): readonly string[] => {
    const latest = store.latestMessages(2);
    return latest.length === 0
      ? []
      : [
          "Nothing said yet today. Where the main chat left off:",
          ...latest.map((message) => toSaid(message, now, zone).line),
        ];
  };

  return {
    text: (here) => {
      const now = clock.now();
      const zone = timeZone();
      const since = dayStartOf(now, zone);
      const until = atLocal(nextDay(toLocal(since, zone).day), dayStartMinutes, zone);
      const said = store.messagesSince(toTimestamp(since), scanned).map((message) => toSaid(message, now, zone));
      const conversations = saidLines(said, here);
      const done = doneLines(store.doneSince(toTimestamp(since)), now, zone);
      const next = nextLines(now, until, zone);
      const opening = here === undefined && said.length === 0 ? lastSaid(now, zone) : [];
      if (conversations.length === 0 && done.length === 0 && next.length === 0 && opening.length === 0) return "";
      return [
        "<today>",
        `Today so far, since ${clockOf(since, zone)}, across the main chat and their threads, the latest first. It's ` +
          "one day and one plan: join up what's said anywhere before you act, keep your blocks and wake-ups to it, " +
          "and don't ask again or check in twice about what's here." +
          (here === undefined || conversations.length === 0
            ? ""
            : " This conversation's own messages are left out: you have them."),
        ...[opening, conversations, done, next].flatMap((part) => (part.length === 0 ? [] : ["", ...part])),
        "</today>",
      ].join("\n");
    },
  };
};
