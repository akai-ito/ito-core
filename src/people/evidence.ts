// Evidence of time with someone, never tracking them: calendar events with them, journal days and day notes that
// mention them, his chat, and visits to places named after them. Location only knows where he is.

export type EvidenceKind = "calendar" | "place" | "journal" | "day_note" | "chat";

export type Evidence = {
  // The local day it was, such as 2026-11-20.
  readonly day: string;
  readonly kind: EvidenceKind;
  // When it began, when that's known, such as an event's start.
  readonly at?: string;
  // What it was, in a few words, such as an event's title or a place's name.
  readonly what?: string;
  // How long it lasted, for time together: an event's length or a visit's.
  readonly hours?: number;
};

// A line that mentions them, for moments together.
export type Moment = {
  readonly day: string;
  readonly text: string;
  readonly from: "journal" | "day_note";
  readonly page?: string;
};

// What counts most when two things happened on the same day.
const weight: Readonly<Record<EvidenceKind, number>> = { calendar: 4, place: 3, journal: 2, day_note: 1, chat: 0 };

const escapeRegExp = (text: string): string => text.replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`);

// Whether a text names them, by any of their names, as whole words: "Leo's" names Leo, "Leonie" doesn't.
export const mentionOf = (names: readonly string[]): ((text: string) => boolean) => {
  const usable = [...new Set(names.map((name) => name.trim()).filter((name) => name.length >= 2))];
  if (usable.length === 0) return () => false;
  const pattern = new RegExp(
    String.raw`(?<![\p{L}\p{N}])(?:${usable
      .toSorted((left, right) => right.length - left.length)
      .map((name) => escapeRegExp(name).replaceAll(/\s+/gu, String.raw`\s+`))
      .join("|")})(?![\p{L}\p{N}])`,
    "iu",
  );
  return (text) => pattern.test(text);
};

const longestMoment = 200;

// The sentence in a text that names them, as plain words.
export const sentenceWith = (text: string, mentions: (text: string) => boolean): string | undefined => {
  const sentences = text
    .split("\n")
    .map((line) =>
      line
        .replace(/^\s*(?:[-*+]|\d+\.|#+)\s*/u, "")
        .replaceAll(/!\[[^\]]*\]\([^)]*\)/gu, "")
        .replaceAll(/\[([^\]]*)\]\([^)]*\)/gu, "$1")
        .replaceAll(/[*_`]/gu, "")
        .trim(),
    )
    .filter((line) => line !== "")
    .flatMap((line) => line.split(/(?<=[.!?])\s+(?=\p{Lu})/u));
  const found = sentences.find((sentence) => mentions(sentence));
  if (found === undefined) return undefined;
  return found.length > longestMoment ? `${found.slice(0, longestMoment - 1).trimEnd()}…` : found;
};

// The newest evidence: the latest day, and on one day what says most, such as an event over a chat.
export const latestOf = (evidence: readonly Evidence[]): Evidence | undefined =>
  evidence.reduce<Evidence | undefined>((best, next) => {
    if (best === undefined) return next;
    if (next.day !== best.day) return next.day > best.day ? next : best;
    if (weight[next.kind] !== weight[best.kind]) return weight[next.kind] > weight[best.kind] ? next : best;
    return (next.at ?? "") > (best.at ?? "") ? next : best;
  }, undefined);

// Time together since a day: the days with something real (a chat about them doesn't count) and the hours known.
export const togetherOf = (
  evidence: readonly Evidence[],
  since: string,
): { readonly days: number; readonly hours: number } => {
  const real = evidence.filter(({ day, kind }) => day >= since && kind !== "chat");
  const hours = real.reduce((sum, { hours: more = 0 }) => sum + more, 0);
  return { days: new Set(real.map(({ day }) => day)).size, hours: Math.round(hours * 2) / 2 };
};
