import type { DayNote } from "#dream/notes.ts";
import { dayTitle } from "#memory/pages.ts";
import type { CalendarItem, DoneEntry, Message, Thread, Track } from "#protocol/types.ts";
import { withoutBlocks } from "#replies/blocks.ts";

// What the dream reads, digested: each source in a few lines, the newest kept when there's more than fits, so a
// night's dream takes in a whole day without being handed it raw. Kumo reads more with its tools where it matters.

export type SharedPhoto = {
  // Where the dream finds it in its workspace, such as uploads/f_123.jpg.
  readonly path: string;
  readonly at: string;
  readonly thread?: string;
  // The local day the photo itself says it was taken, when it says.
  readonly takenDay?: string;
  // What they wrote with it.
  readonly caption?: string;
};

export const mostMessages = 400;
const messageLength = 300;
const conversationBudget = 40_000;
const mostDone = 60;
const mostMail = 40;
const noteLength = 1200;

const squeeze = (text: string, most: number): string => {
  const plain = withoutBlocks(text).replaceAll(/\s+/gu, " ").trim();
  return plain.length > most ? `${plain.slice(0, most)}…` : plain;
};

// "Wed 26 Nov 21:10", where they are.
export const whenOf = (at: string | number, zone: string): string =>
  new Intl.DateTimeFormat("en-GB", {
    timeZone: zone,
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  })
    .format(typeof at === "number" ? at : Date.parse(at))
    .replace(",", "");

const section = (tag: string, intro: string, lines: readonly string[], none: string): string =>
  [`<${tag}>`, ...(lines.length === 0 ? [none] : [intro, ...lines]), `</${tag}>`].join("\n");

export const notesText = (notes: readonly DayNote[], zone: string): string =>
  section(
    "day_notes",
    "The notes you kept during the day for tonight, oldest first, each with the day it's about:",
    notes.map(
      ({ at, day, text, yours }) =>
        `- ${whenOf(at, zone)}, about ${dayTitle(day)}: ${yours ? `their words: “${squeeze(text, noteLength)}”` : squeeze(text, noteLength)}`,
    ),
    "You kept no notes for tonight.",
  );

// The conversation since the last dream, the main chat first, then each thread, the newest kept within budget.
export const conversationsText = (
  messages: readonly Message[],
  threadOf: (id: string) => Thread | undefined,
  zone: string,
): string => {
  const lineOf = (message: Message): string => {
    const photos = (message.attachments ?? []).filter(({ kind }) => kind === "image").length;
    const words = squeeze(message.text, messageLength);
    const attached = photos === 0 ? "" : ` [${String(photos)} photo${photos === 1 ? "" : "s"}]`;
    return `- ${whenOf(message.at, zone)}, ${message.role === "user" ? "they" : "you"}: ${words}${attached}`;
  };
  const kept = messages.reduceRight<{
    readonly lines: readonly Message[];
    readonly size: number;
    readonly isFull: boolean;
  }>(
    (taken, message) => {
      const size = taken.size + lineOf(message).length;
      return taken.isFull || size > conversationBudget
        ? { ...taken, isFull: true }
        : { lines: [message, ...taken.lines], size, isFull: false };
    },
    { lines: [], size: 0, isFull: false },
  ).lines;
  const left = messages.length - kept.length;
  const placeOf = (message: Message): string => message.thread ?? "";
  const places = [...new Set(kept.map((message) => placeOf(message)))].toSorted((left, right) =>
    left === "" ? -1 : right === "" ? 1 : 0,
  );
  const blocks = places.flatMap((place) => {
    const thread = place === "" ? undefined : threadOf(place);
    const heading =
      place === ""
        ? "## The main chat"
        : `## Thread ${thread?.title === undefined ? "not yet named" : `“${thread.title}”`} (${place})`;
    return [heading, ...kept.filter((message) => placeOf(message) === place).map(lineOf)];
  });
  return section(
    "conversations",
    [
      "What you and they said since your last dream, shortened:",
      ...(left > 0 ? [`(${String(left)} earlier messages left out: read_thread and recall find them.)`] : []),
    ].join("\n"),
    blocks,
    "Nothing was said since your last dream.",
  );
};

export const photosText = (photos: readonly SharedPhoto[], zone: string, threadTitle: (id: string) => string): string =>
  section(
    "photos",
    "Photos they shared since your last dream, in your workspace to put where they belong:",
    photos.map(
      ({ path, at, thread, takenDay, caption }) =>
        `- ${path}: shared ${whenOf(at, zone)} in ${thread === undefined ? "the main chat" : threadTitle(thread)}; ` +
        (takenDay === undefined ? "the photo doesn't say when it was taken" : `taken ${dayTitle(takenDay)}`) +
        (caption === undefined || caption === "" ? "" : `; they wrote: “${squeeze(caption, 200)}”`),
    ),
    "They shared no photos.",
  );

// What Kumo did in the background since the last dream, such as wake-ups that ran; mail it only read is counted.
export const workText = (entries: readonly DoneEntry[], zone: string): string => {
  const own = entries.filter(({ dream }) => dream === undefined);
  const quiet = own.filter(({ quiet }) => quiet).length;
  const lines = own
    .filter(({ quiet }) => !quiet)
    .toReversed()
    .slice(-mostDone)
    .map(({ at, text, reason }) => `- ${whenOf(at, zone)}: ${text}${reason === undefined ? "" : ` (${reason})`}`);
  return section(
    "your_work",
    "What you did since your last dream, from their Done list, oldest first (wake-ups that ran among it):",
    [...lines, ...(quiet === 0 ? [] : [`- And ${String(quiet)} mails read and left alone.`])],
    "You did nothing in the background since your last dream.",
  );
};

export const mailText = (lines: readonly string[]): string =>
  section(
    "mail_they_handled",
    "Mail they read, answered or flagged, and mail they sent, since your last dream, oldest first:",
    lines.slice(-mostMail),
    "No mail they read or sent since your last dream, or none is connected.",
  );

export const calendarText = (items: readonly CalendarItem[], zone: string): string => {
  const sorted = items.toSorted((left, right) => left.start.localeCompare(right.start));
  return section(
    "calendar",
    "Their calendars from your last dream to two days ahead, with your own blocks and guesses (by uid):",
    sorted.map((item) => {
      const span = item.all_day
        ? item.start.slice(0, 10)
        : `${whenOf(item.start, zone)}–${whenOf(item.end, zone).slice(-5)}`;
      const whose = item.calendar.kumo
        ? `your ${item.guess === undefined ? "block" : "guess"} ${item.uid}`
        : `${item.calendar.name}${item.status === undefined ? "" : `, ${item.status}`}`;
      return `- ${span}: ${item.title} (${whose})`;
    }),
    "Nothing on their calendars, or none is connected.",
  );
};

export const tracksText = (tracks: readonly Track[], since: string, zone: string): string => {
  const lines = tracks.flatMap((track) =>
    track.evidence
      .filter(({ at }) => at >= since)
      .toReversed()
      .map(
        ({ at, kind, text }) => `- ${track.name} (${track.id}), ${whenOf(at, zone)}, ${kind}: ${squeeze(text, 300)}`,
      ),
  );
  return section(
    "learning",
    "What the areas you're learning stand on since your last dream, oldest first in each:",
    lines,
    "No corrections or confirmations since your last dream.",
  );
};
