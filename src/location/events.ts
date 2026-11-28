import { createCell } from "#cell.ts";
import type { Cancel, Clock } from "#clock.ts";
import { clockOf } from "#day/time.ts";
import { toSpoken } from "#desk/day.ts";
import { metresBetween } from "#location/geo.ts";
import { jitterMs, type Location, type Moment } from "#location/location.ts";
import type { KeptPlace } from "#location/records.ts";
import type { Result } from "#result.ts";
import type { Info } from "#turns/turns.ts";

// Comings and goings: arriving at a place and leaving it are events, as a mail is. Kumo wakes, looks, mostly stays
// silent and keeps a note for the dream, and messages them only when it's worth it. Only fresh visits count, never a
// point or a significant change, never photos. GPS jitter doesn't make a flurry: leaving a place and coming back
// within 15 minutes is no event, a stop under 10 minutes is passing through, and moments that come close together
// wait for each other, so Kumo looks at most once every 15 minutes.
export type ComingsAndGoings = {
  readonly close: () => void;
};

export type CalendarMoment = { readonly title: string; readonly location?: string };

export type ComingsAndGoingsOptions = {
  readonly location: Pick<Location, "onMoments" | "find" | "visit" | "displayName" | "isUnknown" | "all">;
  readonly clock: Clock;
  readonly timeZone: () => string;
  readonly work: (prompt: string) => Promise<Result<string, string>>;
  // What was on their calendar during a stay, for Kumo's guesses at a place's name.
  readonly eventsDuring: (from: number, to: number) => readonly CalendarMoment[];
  // Whether Kumo has already asked about a place.
  readonly isAsked: (place: string) => boolean;
  readonly info: Info;
};

const minuteMs = 60 * 1000;
// Moments wait this long for others that belong with them.
export const settleMs = 3 * minuteMs;
// Kumo looks at most this often.
export const lookGapMs = 15 * minuteMs;
// A stop shorter than this is passing through.
const shortStopMs = 10 * minuteMs;
// Kumo asks about a place only once they've spent this long there.
const askHours = 0.5;
const nearbyMetres = 400;

const lengthOf = (ms: number): string => {
  const minutes = Math.round(ms / minuteMs);
  const hours = Math.floor(minutes / 60);
  if (hours === 0) return `${String(minutes)} min`;
  return minutes % 60 === 0 ? `${String(hours)} h` : `${String(hours)} h ${String(minutes % 60)} min`;
};

const kindWords: Readonly<Partial<Record<KeptPlace["kind"], string>>> = {
  work: "work",
  gym: "the gym",
  friend: "a friend's",
  family: "family",
  cafe: "a café",
  restaurant: "a restaurant",
  bar: "a bar",
  shop: "a shop",
  school: "school",
  health: "health",
  outdoors: "outdoors",
  travel: "travel",
};

export const createComingsAndGoings = ({
  location,
  clock,
  timeZone,
  work,
  eventsDuring,
  isAsked,
  info,
}: ComingsAndGoingsOptions): ComingsAndGoings => {
  const queue = createCell<readonly Moment[]>([]);
  const lastLeft = createCell<{ readonly place: string; readonly at: number } | undefined>(undefined);
  const lastLook = createCell<number | undefined>(undefined);
  const timer = createCell<Cancel | undefined>(undefined);
  const isLooking = createCell(false);
  const isClosed = createCell(false);

  // A moment joins the queue unless it's jitter: back at the place they just left, or the end of a short stop.
  const take = (moment: Moment): void => {
    if (moment.kind === "arrived") {
      const left = lastLeft.get();
      if (left?.place === moment.place && moment.at - left.at <= jitterMs) {
        queue.update((current) =>
          current.filter((other) => !(other.kind === "left" && other.place === moment.place && other.at === left.at)),
        );
        return;
      }
      queue.update((current) => [...current, moment]);
      return;
    }
    lastLeft.set({ place: moment.place, at: moment.at });
    const isShort = moment.since !== undefined && moment.at - moment.since < shortStopMs;
    queue.update((current) => [
      ...current.filter((other) => !(other.kind === "arrived" && other.visit === moment.visit)),
      ...(isShort ? [] : [moment]),
    ]);
  };

  const name = (place: KeptPlace): string => {
    const kind = place.name === undefined ? undefined : kindWords[place.kind];
    return `${location.displayName(place)}${kind === undefined ? "" : ` (${kind})`}`;
  };

  const lineOf = (moment: Moment): string => {
    const place = location.find(moment.place);
    if (!place) return "";
    const zone = timeZone();
    const id = location.isUnknown(place) ? ` [${place.id}]` : "";
    if (moment.kind === "arrived") return `- Arrived at ${name(place)}${id} at ${clockOf(moment.at, zone)}.`;
    const stay =
      moment.since === undefined
        ? ""
        : `, after ${lengthOf(moment.at - moment.since)} there (since ${clockOf(moment.since, zone)})`;
    return `- Left ${name(place)}${id} at ${clockOf(moment.at, zone)}${stay}.`;
  };

  // What Kumo knows of a place it can't name: where, when, how long, the calendar then, and named places nearby.
  const unknownLine = (place: KeptPlace, moments: readonly Moment[]): string => {
    const zone = timeZone();
    const mine = moments.filter((moment) => moment.place === place.id);
    const from = Math.min(...mine.map((moment) => moment.since ?? moment.at));
    const to = Math.max(...mine.map((moment) => (moment.kind === "left" ? moment.at : clock.now())));
    const where = [place.street, place.locality].filter((part) => part !== undefined).join(", ");
    const calendar = eventsDuring(from, to).map(
      ({ title, location: at }) => `“${title}”${at === undefined ? "" : ` at ${at}`}`,
    );
    const nearby = location
      .all()
      .filter((other) => other.id !== place.id && other.name !== undefined)
      .map((other) => ({ other, metres: metresBetween(other, place) }))
      .filter(({ metres }) => metres <= nearbyMetres)
      .toSorted((left, right) => left.metres - right.metres)
      .slice(0, 2)
      .map(({ other, metres }) => `${other.name ?? ""} (${String(Math.round(metres))} m)`);
    return [
      `- ${place.id}:`,
      where === "" ? `${String(place.latitude)}, ${String(place.longitude)}.` : `${where}.`,
      ...(place.apple_name === undefined ? [] : [`Apple calls it ${place.apple_name}.`]),
      `This time ${clockOf(from, zone)}–${clockOf(to, zone)};`,
      `${String(place.visits)} ${place.visits === 1 ? "visit" : "visits"}, ${String(place.hours)} h in all.`,
      ...(calendar.length === 0 ? [] : [`Their calendar then: ${calendar.join(", ")}.`]),
      ...(nearby.length === 0 ? [] : [`Near ${nearby.join(", ")}.`]),
    ].join(" ");
  };

  const promptOf = (moments: readonly Moment[]): string => {
    const lines = moments.map(lineOf).filter((line) => line !== "");
    const unknown = [...new Set(moments.map(({ place }) => place))]
      .flatMap((id) => location.find(id) ?? [])
      .filter((place) => location.isUnknown(place) && !isAsked(place.id) && place.hours >= askHours);
    return [
      `It's ${toSpoken(clock.now(), timeZone())}. Their phone says they came and went:`,
      ...lines,
      ...(unknown.length === 0
        ? []
        : [
            "",
            "You can't name these places yet:",
            ...unknown.map((place) => unknownLine(place, moments)),
            "If one is somewhere they'll likely come back to, ask what it is with add_question, giving place and your",
            "best guesses at its name as options: Apple's name, a calendar event there, a booking in their mail (look",
            "if one could help). One question per place; let places they only passed through be.",
          ]),
      "",
      "Most comings and goings need nothing, and they know where they are: don't tell them. Keep a note for tonight",
      "with note_day only for a moment worth the journal, such as somewhere new or someone they met, never the",
      "routine of home, work or the gym. Message them with post only when something truly matters now, where",
      "they've just arrived or are going next.",
      "End with one line saying what you did.",
    ].join("\n");
  };

  const look = async (): Promise<void> => {
    timer.set(undefined);
    if (isClosed.get()) return;
    if (isLooking.get()) {
      schedule();
      return;
    }
    const last = lastLook.get();
    const now = clock.now();
    if (last !== undefined && now - last < lookGapMs) {
      schedule(last + lookGapMs - now);
      return;
    }
    const moments = queue.get();
    queue.set([]);
    if (moments.length === 0) return;
    isLooking.set(true);
    lastLook.set(now);
    try {
      const done = await work(promptOf(moments));
      if (!done.ok) info("Kumo couldn't look at where they came and went", { error: done.failure });
    } finally {
      isLooking.set(false);
    }
  };

  const schedule = (delayMs = settleMs): void => {
    timer.get()?.();
    timer.set(
      clock.after(delayMs, () => {
        void look();
      }),
    );
  };

  location.onMoments((moments) => {
    if (isClosed.get()) return;
    const ordered = moments.toSorted((left, right) => left.at - right.at);
    for (const moment of ordered) take(moment);
    if (queue.get().length > 0) schedule();
    else {
      timer.get()?.();
      timer.set(undefined);
    }
  });

  return {
    close: () => {
      isClosed.set(true);
      timer.get()?.();
    },
  };
};
