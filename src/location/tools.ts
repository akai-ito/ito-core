import { clockOf } from "#day/time.ts";
import { toLocal } from "#desk/day.ts";
import { daysBetween } from "#location/days.ts";
import type { Location } from "#location/location.ts";
import type { KeptPlace } from "#location/records.ts";
import { toDay } from "#memory/pages.ts";
import type { DayThread, ThreadMove, ThreadStop } from "#protocol/types.ts";
import { textOf } from "#tools/input.ts";
import type { Tool, ToolResult } from "#tools/mcp.ts";

// Kumo's tools for where they've been, all read-only: where they were on a day or at a moment, time at places over a
// range, a day's route, and the places list. The words follow how they'd say it: names first, Apple's after.

export type PlaceToolsOptions = {
  readonly location: Pick<Location, "days" | "places" | "all" | "find" | "displayName" | "isUnknown" | "freshen">;
  readonly now: () => number;
  readonly timeZone: () => string;
};

const dayPattern = /^\d{4}-\d{2}-\d{2}$/u;
const mostPlaces = 40;
// The dream reads at most this many days of comings and goings.
const maxDigestDays = 14;

const failed = (text: string): ToolResult => ({ text, isError: true });

const isDay = (text: string): boolean => dayPattern.test(text) && !Number.isNaN(Date.parse(`${text}T00:00:00.000Z`));

const lengthOf = (minutes: number): string => {
  const hours = Math.floor(minutes / 60);
  if (hours === 0) return `${String(minutes)} min`;
  return minutes % 60 === 0 ? `${String(hours)} h` : `${String(hours)} h ${String(minutes % 60)} min`;
};

const distanceOf = (metres: number): string =>
  metres < 1000 ? `${String(Math.round(metres / 10) * 10)} m` : `${(metres / 1000).toFixed(1)} km`;

const modeWords: Readonly<Record<ThreadMove["mode"], string>> = {
  walk: "on foot",
  cycle: "by bike or similar",
  ride: "by car, bus or train",
  flight: "flying",
};

// Each stop and move of a day, as lines for Kumo.
export const threadLines = (
  thread: DayThread,
  timeZone: string,
  nameOf: (stop: ThreadStop) => string,
): readonly string[] =>
  thread.items.map((item) => {
    if (item.kind === "move") {
      return (
        `  ↓ ${lengthOf(item.minutes)} ${modeWords[item.mode]}, ${distanceOf(item.metres)}` +
        (item.traced ? "" : " as the crow flies")
      );
    }
    const from = item.arrived_at === undefined ? "?" : clockOf(Date.parse(item.arrived_at), timeZone);
    const to =
      item.here === true
        ? "now"
        : item.departed_at === undefined
          ? "?"
          : clockOf(Date.parse(item.departed_at), timeZone);
    const before =
      item.arrived_at !== undefined && toDay(Date.parse(item.arrived_at), timeZone) < thread.day
        ? " (from the day before)"
        : "";
    return `- ${from}–${to}${before} ${nameOf(item)} (${lengthOf(item.minutes)})`;
  });

export const createPlaceTools = ({ location, now, timeZone }: PlaceToolsOptions): readonly Tool[] => {
  const nameOfPlace = (place: KeptPlace | undefined): string =>
    place === undefined
      ? "a place"
      : `${location.displayName(place)}${location.isUnknown(place) ? ` [${place.id}]` : ""}`;

  const nameOfStop = (stop: ThreadStop): string => nameOfPlace(location.find(stop.place));

  const today = (): string => toLocal(now(), timeZone()).day;

  const dayText = (day: string): string => {
    location.freshen();
    const thread = location.days.thread(day);
    if (thread.items.length === 0) return `Nothing on where they were on ${day}.`;
    return [
      `Where they were on ${day}${thread.from_photos === true ? ", from where their photos were taken" : ""}:`,
      ...threadLines(thread, timeZone(), nameOfStop),
    ].join("\n");
  };

  const momentText = (at: number): string => {
    const day = toDay(at, timeZone());
    const thread = location.days.thread(day);
    const covering = thread.items.find((item) => {
      if (item.kind === "move") return Date.parse(item.started_at) <= at && at < Date.parse(item.ended_at);
      const from = item.arrived_at === undefined ? 0 : Date.parse(item.arrived_at);
      const to = item.departed_at === undefined ? now() : Date.parse(item.departed_at);
      return from <= at && at < to;
    });
    const when = `${day} ${clockOf(at, timeZone())}`;
    if (covering === undefined) return `Nothing on where they were at ${when}.`;
    if (covering.kind === "move") {
      return `At ${when} they were on the move, ${modeWords[covering.mode]}, between two places.`;
    }
    const from = covering.arrived_at === undefined ? "?" : clockOf(Date.parse(covering.arrived_at), timeZone());
    const to = covering.departed_at === undefined ? "now" : clockOf(Date.parse(covering.departed_at), timeZone());
    return `At ${when} they were at ${nameOfStop(covering)}, there ${from}–${to}.`;
  };

  return [
    {
      name: "where_was_i",
      title: "Look up where they were",
      description:
        "Where they were, from their phone's places: a whole day as a thread of places with arrive and leave times " +
        "and the moves between, or the place they were at a moment. Give day (YYYY-MM-DD) for a day, or at (a local " +
        "date and time, YYYY-MM-DDTHH:MM) for a moment. Read-only.",
      inputSchema: {
        type: "object",
        properties: {
          day: { type: "string", description: "A day, YYYY-MM-DD; today when nothing is given." },
          at: { type: "string", description: "A local moment, YYYY-MM-DDTHH:MM." },
        },
        additionalProperties: false,
      },
      call: (input) => {
        const at = textOf(input, "at").trim();
        if (at !== "") {
          const match = /^(?<day>\d{4}-\d{2}-\d{2})T(?<hour>\d{2}):(?<minute>\d{2})$/u.exec(at)?.groups;
          if (match === undefined || !isDay(match.day ?? ""))
            return Promise.resolve(failed(`${at} isn't YYYY-MM-DDTHH:MM.`));
          const local = (Number(match.hour) * 60 + Number(match.minute)) * 60 * 1000;
          const midnight = location.days.windowOf(match.day ?? "").start;
          return Promise.resolve({ text: momentText(midnight + local) });
        }
        const day = textOf(input, "day").trim() || today();
        return Promise.resolve(isDay(day) ? { text: dayText(day) } : failed(`${day} isn't a day: give YYYY-MM-DD.`));
      },
    },
    {
      name: "time_at_places",
      title: "Add up time at places",
      description:
        "How much time they spent at each place over a range of days, most first, with visits, and the trips in it. " +
        "Read-only.",
      inputSchema: {
        type: "object",
        properties: {
          from: { type: "string", description: "The first day, YYYY-MM-DD." },
          to: { type: "string", description: "The last day, YYYY-MM-DD; today when left out." },
        },
        required: ["from"],
        additionalProperties: false,
      },
      call: (input) => {
        const from = textOf(input, "from").trim();
        const to = textOf(input, "to").trim() || today();
        if (!isDay(from) || !isDay(to)) return Promise.resolve(failed("Give from and to as YYYY-MM-DD."));
        if (from > to) return Promise.resolve(failed("The range ends before it begins."));
        location.freshen();
        const places = location.places(from, to);
        const trips = location.days.trips(from, to);
        if (places.length === 0 && trips.length === 0) {
          return Promise.resolve({ text: `Nothing on where they were from ${from} to ${to}.` });
        }
        return Promise.resolve({
          text: [
            `Time at places from ${from} to ${to} (${String(daysBetween(from, to))} days):`,
            ...places
              .slice(0, mostPlaces)
              .map(
                (place) =>
                  `- ${nameOfPlace(location.find(place.id))}: ${String(place.hours)} h, ${String(place.visits)} ` +
                  (place.visits === 1 ? "visit" : "visits"),
              ),
            ...(places.length > mostPlaces ? [`…and ${String(places.length - mostPlaces)} more.`] : []),
            ...(trips.length === 0
              ? []
              : [
                  "Trips:",
                  ...trips.map(
                    (trip) =>
                      `- ${trip.from} to ${trip.to} (${String(trip.days)} days): ` +
                      `${[...trip.cities, ...trip.countries.map(({ name }) => name)].join(", ") || "somewhere away"}, ` +
                      `${String(trip.kilometres)} km from home${trip.from_photos === true ? ", from photos" : ""}. ` +
                      `Journal map: ![…](trip:${trip.id})`,
                  ),
                ]),
          ].join("\n"),
        });
      },
    },
    {
      name: "day_route",
      title: "Look at a day's route",
      description:
        "A day's route from their phone: each move between places with how long, how far and how, and where it " +
        "started and ended. To show it in the day's journal entry, put ![what it shows](route:YYYY-MM-DD) where it " +
        "belongs in the story; the app draws it as a map. Read-only.",
      inputSchema: {
        type: "object",
        properties: { day: { type: "string", description: "The day, YYYY-MM-DD." } },
        required: ["day"],
        additionalProperties: false,
      },
      call: (input) => {
        const day = textOf(input, "day").trim();
        if (!isDay(day)) return Promise.resolve(failed(`${day} isn't a day: give YYYY-MM-DD.`));
        location.freshen();
        const thread = location.days.thread(day);
        const trail = location.days.trail(day);
        const moves = thread.items.filter((item): item is ThreadMove => item.kind === "move");
        if (thread.items.length === 0) return Promise.resolve({ text: `Nothing on their route on ${day}.` });
        const metres = moves.reduce((sum, move) => sum + move.metres, 0);
        return Promise.resolve({
          text: [
            `Their route on ${day}: ${String(moves.length)} ${moves.length === 1 ? "move" : "moves"}, ` +
              `${distanceOf(metres)} in all, ${String(trail.points.length)} points on the map.`,
            ...threadLines(thread, timeZone(), nameOfStop),
            `Journal map: ![…](route:${day})`,
          ].join("\n"),
        });
      },
    },
    {
      name: "list_places",
      title: "List their places",
      description:
        "Every place their visits gathered into, most time first: your name for it or Apple's, its kind, hours and " +
        "visits in all, and first and last visit. Places you can't name yet show their id. Read-only.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      call: () => {
        const places = location.places();
        if (places.length === 0) return Promise.resolve({ text: "No places yet." });
        const zone = timeZone();
        return Promise.resolve({
          text: [
            "Their places:",
            ...places.slice(0, mostPlaces).map((place) => {
              const kept = location.find(place.id);
              const apple =
                place.apple_name === undefined || place.name === undefined ? "" : `, Apple: ${place.apple_name}`;
              return (
                `- ${nameOfPlace(kept)} (${place.kind}${apple}): ${String(place.hours)} h, ${String(place.visits)} ` +
                `${place.visits === 1 ? "visit" : "visits"}, first ${toDay(Date.parse(place.first_visit), zone)}, ` +
                `last ${toDay(Date.parse(place.last_visit), zone)}${place.here === true ? "; there now" : ""}` +
                (place.from_photos === true ? "; from photos" : "")
              );
            }),
            ...(places.length > mostPlaces ? [`…and ${String(places.length - mostPlaces)} more.`] : []),
          ].join("\n"),
        });
      },
    },
  ];
};

// Where they went since a time, day by day, for the dream's digest.
export const whereaboutsText = ({ location, now, timeZone }: PlaceToolsOptions, since: number): string => {
  const zone = timeZone();
  const first = toDay(since, zone);
  const last = toLocal(now(), zone).day;
  const days = Array.from({ length: Math.min(daysBetween(first, last), maxDigestDays) }, (_, index) =>
    toDay(Date.parse(`${first}T12:00:00.000Z`) + index * 24 * 60 * 60 * 1000, "UTC"),
  );
  const nameOf = (stop: ThreadStop): string => {
    const place = location.find(stop.place);
    return place === undefined
      ? "a place"
      : `${location.displayName(place)}${location.isUnknown(place) ? ` [${place.id}]` : ""}`;
  };
  location.freshen();
  const blocks = days.flatMap((day) => {
    const thread = location.days.thread(day);
    return thread.items.length === 0 ? [] : [`## ${day}`, ...threadLines(thread, zone, nameOf)];
  });
  const trips = location.days.trips(first, last);
  const lines = [
    ...blocks,
    ...(trips.length === 0
      ? []
      : [
          "## Trips",
          ...trips.map(
            (trip) =>
              `- ${trip.from} to ${trip.to}: ${[...trip.cities, ...trip.countries.map(({ name }) => name)].join(", ") || "away"} ` +
              `(trip:${trip.id})`,
          ),
        ]),
  ];
  return [
    "<where_they_went>",
    ...(lines.length === 0
      ? ["Their phone said nothing about where they went since your last dream, or places are off."]
      : [
          "Where their phone says they went since your last dream, day by day, with the moves between",
          "(where_was_i and day_route read more):",
          ...lines,
        ]),
    "</where_they_went>",
  ].join("\n");
};
