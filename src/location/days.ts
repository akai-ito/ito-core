import { toTimestamp } from "#clock.ts";
import { atLocal, nextDay } from "#desk/day.ts";
import {
  cellBounds,
  centreOf,
  geohash,
  meanOf,
  metresBetween,
  pathMetres,
  rounded,
  simplify,
  type Point,
} from "#location/geo.ts";
import { without, type KeptPlace, type Records, type Sample, type Visit } from "#location/records.ts";
import type { DayThread, Heat, Placemark, ThreadMove, ThreadStop, Trail, Trip } from "#protocol/types.ts";

// Days: what each day was, worked out from the rows and kept so any range is a cheap sum. A day's heat is the time
// spent in each fine geohash cell: at its visits, and on the move between them along the live points. A day mostly
// 50 km or more from home is a day away, which counts as 14 hours shared among its cells, so a trip glows by its
// length rather than by how much the phone recorded. A day known only from photos counts an hour for each spot
// photos were taken at, or 14 hours away.

export type DayBody = {
  readonly zone: string;
  readonly seconds: number;
  readonly away: boolean;
  readonly seeded: boolean;
  readonly centre?: Point;
  readonly countries: readonly { readonly name: string; readonly code?: string; readonly seconds: number }[];
  readonly cities: readonly { readonly name: string; readonly seconds: number }[];
};

export type DaysOptions = {
  readonly records: Records;
  readonly now: () => number;
  readonly timeZone: () => string;
  readonly placeOf: (id: string) => KeptPlace | undefined;
  readonly home: () => KeptPlace | undefined;
};

type Segment = {
  readonly from: number;
  readonly to: number;
  readonly point: Point;
  readonly placemark?: Placemark;
};

type Window = { readonly zone: string; readonly start: number; readonly end: number };

const hourMs = 60 * 60 * 1000;
const minuteMs = 60 * 1000;
const dayAwayMs = 14 * hourMs;
const awayMetres = 50_000;
// A live point stands for the time until the next one, up to this.
const pointMs = 5 * minuteMs;
// Points coarser than this don't trace a route.
const traceAccuracy = 100;
const heatAccuracy = 200;
// Two stays at the same place this close together are one: GPS jitter, not a new visit.
export const jitterMs = 15 * minuteMs;
const trailTolerance = 15;
const shortestTrip = 2;

const weekFull = 10;
const monthFull = 40;
const yearFull = 500;

// The hours at which a cell is fully lit, for a range of so many days: 10 h for a week, 40 h for a month, 500 h for
// a year, and straight lines between.
export const fullFor = (days: number): number => {
  if (days <= 7) return weekFull;
  if (days < 28) return weekFull + ((days - 7) / 21) * (monthFull - weekFull);
  if (days <= 31) return monthFull;
  if (days < 365) return monthFull + ((days - 31) / 334) * (yearFull - monthFull);
  if (days <= 366) return yearFull;
  return (yearFull * days) / 365;
};

// How lit a cell is: saturating, so home and the office are simply full and a two-hour dinner still shows.
export const glowOf = (hours: number, full: number): number =>
  Math.min(1, (1 - Math.exp((-3 * hours) / full)) / (1 - Math.exp(-3)));

export const daysBetween = (from: string, to: string): number =>
  Math.round((Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / (24 * hourMs)) + 1;

type Mode = ThreadMove["mode"];

// A guess at how they went, from the speed.
const modeOf = (metres: number, ms: number): Mode => {
  const speed = ms <= 0 ? 0 : metres / (ms / 1000);
  if (speed < 2.2) return "walk";
  if (speed < 6.5) return "cycle";
  return speed < 60 && metres < 1_000_000 ? "ride" : "flight";
};

const addTo = <Key>(map: ReadonlyMap<Key, number>, key: Key, value: number): ReadonlyMap<Key, number> =>
  new Map(map).set(key, (map.get(key) ?? 0) + value);

export type Days = ReturnType<typeof createDays>;

export const createDays = ({ records, now, timeZone, placeOf, home }: DaysOptions) => {
  const windowOf = (day: string): Window => {
    const zone = records.zoneOf(day) ?? timeZone();
    return { zone, start: atLocal(day, 0, zone), end: atLocal(nextDay(day), 0, zone) };
  };

  const endOf = (visit: Visit): number => visit.departedAt ?? now();
  const startOf = (visit: Visit): number => visit.arrivedAt ?? visit.departedAt ?? now();

  // Live points on the move: not within any visit, and fine enough.
  const movingIn = (from: number, to: number, visits: readonly Visit[], accuracy: number): readonly Sample[] =>
    records
      .samplesBetween(from, to)
      .filter(
        (sample) =>
          sample.accuracy <= accuracy &&
          visits.every((visit) => !(startOf(visit) <= sample.at && sample.at < endOf(visit))),
      );

  const liveSegments = ({ start, end }: Window): readonly Segment[] => {
    const visits = records.visitsDuring(start, end, now()).filter(({ seeded }) => !seeded);
    const stays = visits.flatMap((visit): readonly Segment[] => {
      const from = Math.max(start, startOf(visit));
      const to = Math.min(end, endOf(visit));
      const place = visit.place === undefined ? undefined : placeOf(visit.place);
      const placemark = visit.placemark ?? toPlacemark(place);
      return to > from ? [{ from, to, point: place ?? visit, ...(placemark && { placemark }) }] : [];
    });
    const moving = movingIn(start, end, visits, heatAccuracy);
    const moves = moving.map((sample, index): Segment => {
      const next = moving[index + 1]?.at ?? sample.at + minuteMs;
      return { from: sample.at, to: Math.min(end, sample.at + Math.min(pointMs, next - sample.at)), point: sample };
    });
    return [...stays, ...moves];
  };

  const seededSegments = (day: string): readonly Segment[] =>
    records.seededVisitsOn(day).map((visit) => {
      const from = visit.arrivedAt ?? 0;
      const placemark = visit.placemark ?? toPlacemark(visit.place === undefined ? undefined : placeOf(visit.place));
      return {
        from,
        to: from + hourMs,
        point: visit,
        ...(placemark && { placemark }),
      };
    });

  // Works a day out again from its rows, and keeps its heat and what it was.
  const rebuild = (day: string): void => {
    const window = windowOf(day);
    const isLive = records.hasLive(day);
    const segments = isLive ? liveSegments(window) : seededSegments(day);
    const seconds = segments.reduce((sum, { from, to }) => sum + (to - from) / 1000, 0);
    const homePlace = home();
    const farSeconds =
      homePlace === undefined
        ? 0
        : segments
            .filter(({ point }) => metresBetween(point, homePlace) >= awayMetres)
            .reduce((sum, { from, to }) => sum + (to - from) / 1000, 0);
    const away = seconds > 0 && farSeconds / seconds >= 0.5;
    const scale = away ? dayAwayMs / 1000 / seconds : 1;
    const cells = segments.reduce<ReadonlyMap<string, number>>(
      (sum, { from, to, point }) => addTo(sum, geohash(point), ((to - from) / 1000) * scale),
      new Map(),
    );
    const weighed = segments.filter(
      ({ point }) => !away || homePlace === undefined || metresBetween(point, homePlace) >= awayMetres,
    );
    const countries = weighed.reduce<ReadonlyMap<string, number>>((sum, { from, to, placemark }) => {
      const name = placemark?.country;
      return name === undefined ? sum : addTo(sum, `${name}\t${placemark?.country_code ?? ""}`, (to - from) / 1000);
    }, new Map());
    const cities = weighed.reduce<ReadonlyMap<string, number>>((sum, { from, to, placemark }) => {
      const name = placemark?.locality;
      return name === undefined ? sum : addTo(sum, name, (to - from) / 1000);
    }, new Map());
    const centre = meanOf(weighed.map(({ from, to, point }) => ({ ...point, weight: to - from })));
    const body: DayBody = {
      zone: window.zone,
      seconds,
      away,
      seeded: !isLive,
      ...(centre && { centre }),
      countries: [...countries]
        .toSorted(([, left], [, right]) => right - left)
        .map(([key, value]) => {
          const [name = "", code = ""] = key.split("\t", 2);
          return { name, ...(code !== "" && { code }), seconds: value };
        }),
      cities: [...cities]
        .toSorted(([, left], [, right]) => right - left)
        .map(([name, value]) => ({ name, seconds: value })),
    };
    records.keepDay(day, JSON.stringify(body), cells);
  };

  const heat = (from: string, to: string, precision: number, given?: number): Heat => {
    const full = given ?? fullFor(daysBetween(from, to));
    const cells = records.heat(from, to, precision).map(({ cell, seconds }) => {
      const bounds = cellBounds(cell);
      const centre = centreOf(bounds);
      const hours = seconds / 3600;
      return {
        cell,
        latitude: rounded(centre.latitude),
        longitude: rounded(centre.longitude),
        south: rounded(bounds.south),
        west: rounded(bounds.west),
        north: rounded(bounds.north),
        east: rounded(bounds.east),
        hours: Math.round(hours * 10) / 10,
        glow: Math.round(glowOf(hours, full) * 100) / 100,
      };
    });
    return { from, to, precision, full: Math.round(full * 10) / 10, cells: cells.filter(({ hours }) => hours > 0) };
  };

  type Stay = { readonly place: KeptPlace; readonly visit: Visit; readonly from?: number; readonly to?: number };

  // The day's stays at places, oldest first, with stays at the same place a moment apart joined.
  const staysOn = (day: string, window: Window): { readonly stays: readonly Stay[]; readonly seeded: boolean } => {
    const live = records
      .visitsDuring(window.start, window.end, now())
      .filter(({ seeded, place }) => !seeded && place !== undefined);
    const seeded = live.length === 0 && !records.hasLive(day);
    const visits = seeded ? records.seededVisitsOn(day).filter(({ place }) => place !== undefined) : live;
    const stays = visits.flatMap((visit): readonly Stay[] => {
      const place = visit.place === undefined ? undefined : placeOf(visit.place);
      return place === undefined || place.not_a_place === true
        ? []
        : [
            {
              place,
              visit,
              ...(visit.arrivedAt !== undefined && { from: visit.arrivedAt }),
              ...(visit.departedAt !== undefined && { to: visit.departedAt }),
            },
          ];
    });
    const joined = stays.reduce<readonly Stay[]>((sofar, stay) => {
      const last = sofar.at(-1);
      const isSame =
        last?.place.id === stay.place.id &&
        last.to !== undefined &&
        stay.from !== undefined &&
        stay.from - last.to <= jitterMs;
      if (!isSame) return [...sofar, stay];
      return [
        ...sofar.slice(0, -1),
        { ...without(last, "to"), ...(stay.to !== undefined && { to: stay.to }), visit: stay.visit },
      ];
    }, []);
    return { stays: joined, seeded };
  };

  const thread = (day: string): DayThread => {
    const window = windowOf(day);
    const { stays, seeded } = staysOn(day, window);
    const items = stays.flatMap((stay, index): readonly (ThreadStop | ThreadMove)[] => {
      const from = Math.max(window.start, stay.from ?? window.start);
      const to = Math.min(window.end, stay.to ?? now());
      const stop: ThreadStop = {
        kind: "stop",
        place: stay.place.id,
        ...(stay.place.name !== undefined && { name: stay.place.name }),
        ...(stay.place.apple_name !== undefined && { apple_name: stay.place.apple_name }),
        place_kind: stay.place.kind,
        latitude: stay.place.latitude,
        longitude: stay.place.longitude,
        ...(stay.from !== undefined && { arrived_at: toTimestamp(stay.from) }),
        ...(stay.to !== undefined && { departed_at: toTimestamp(stay.to) }),
        minutes: Math.max(0, Math.round((to - from) / minuteMs)),
        ...(stay.to === undefined && !seeded && { here: true as const }),
      };
      const next = stays[index + 1];
      if (seeded || next === undefined || stay.to === undefined || next.from === undefined) return [stop];
      const points = records.samplesBetween(stay.to, next.from).filter(({ accuracy }) => accuracy <= traceAccuracy);
      const traced = points.length >= 2;
      const metres = traced ? pathMetres([stay.place, ...points, next.place]) : metresBetween(stay.place, next.place);
      const ms = next.from - stay.to;
      const move: ThreadMove = {
        kind: "move",
        started_at: toTimestamp(stay.to),
        ended_at: toTimestamp(next.from),
        minutes: Math.max(0, Math.round(ms / minuteMs)),
        metres: Math.round(metres),
        traced,
        mode: modeOf(metres, ms),
      };
      return [stop, move];
    });
    return { day, items, ...(seeded && items.length > 0 && { from_photos: true as const }) };
  };

  const trail = (day: string): Trail => {
    const window = windowOf(day);
    const { stays } = staysOn(day, window);
    const visits = records.visitsDuring(window.start, window.end, now()).filter(({ seeded }) => !seeded);
    const ends = stays.flatMap(({ place, from, to }) => [
      { at: Math.max(window.start, from ?? window.start), latitude: place.latitude, longitude: place.longitude },
      { at: Math.min(window.end, to ?? now()), latitude: place.latitude, longitude: place.longitude },
    ]);
    const moving = movingIn(window.start, window.end, visits, traceAccuracy).map(({ at, latitude, longitude }) => ({
      at,
      latitude,
      longitude,
    }));
    const points = simplify(
      [...ends, ...moving].toSorted((left, right) => left.at - right.at),
      trailTolerance,
    );
    return {
      day,
      points: points.map(({ at, latitude, longitude }) => ({
        at: toTimestamp(at),
        latitude: rounded(latitude),
        longitude: rounded(longitude),
      })),
    };
  };

  const bodies = (from: string, to: string): readonly (DayBody & { readonly day: string })[] =>
    records.dayBodies(from, to).map(({ day, body }) => ({ day, ...(JSON.parse(body) as DayBody) }));

  // Runs of days away, a day with nothing between two away days bridged, at least two days long.
  const trips = (from = "0000-01-01", to = "9999-12-31"): readonly Trip[] => {
    const homePlace = home();
    if (homePlace === undefined) return [];
    const runs = bodies("0000-01-01", "9999-12-31").reduce<readonly (DayBody & { readonly day: string })[][]>(
      (sofar, body) => {
        if (!body.away) return sofar;
        const run = sofar.at(-1);
        const last = run?.at(-1);
        return run !== undefined && last !== undefined && daysBetween(last.day, body.day) <= 3
          ? [...sofar.slice(0, -1), [...run, body]]
          : [...sofar, [body]];
      },
      [],
    );
    return runs
      .filter((run) => {
        const first = run[0]?.day ?? "";
        const last = run.at(-1)?.day ?? "";
        return daysBetween(first, last) >= shortestTrip && last >= from && first <= to;
      })
      .map((run): Trip => {
        const first = run[0]?.day ?? "";
        const last = run.at(-1)?.day ?? "";
        const countries = run
          .flatMap(({ countries: given }) => given)
          .reduce<ReadonlyMap<string, number>>(
            (sum, { name, code = "", seconds }) => addTo(sum, `${name}\t${code}`, seconds),
            new Map(),
          );
        const cities = run
          .flatMap(({ cities: given }) => given)
          .reduce<ReadonlyMap<string, number>>((sum, { name, seconds }) => addTo(sum, name, seconds), new Map());
        const centre =
          meanOf(run.flatMap(({ centre: point, seconds }) => (point ? { ...point, weight: seconds } : []))) ??
          homePlace;
        return {
          id: first,
          from: first,
          to: last,
          days: daysBetween(first, last),
          countries: [...countries]
            .toSorted(([, left], [, right]) => right - left)
            .map(([key]) => {
              const [name = "", code = ""] = key.split("\t", 2);
              return { name, ...(code !== "" && { code }) };
            }),
          cities: [...cities].toSorted(([, left], [, right]) => right - left).map(([name]) => name),
          latitude: rounded(centre.latitude),
          longitude: rounded(centre.longitude),
          kilometres: Math.round(metresBetween(homePlace, centre) / 1000),
          ...(run.every(({ seeded }) => seeded) && { from_photos: true as const }),
        };
      })
      .toReversed();
  };

  return { windowOf, rebuild, heat, thread, trail, trips, bodies };
};

export const toPlacemark = (place: KeptPlace | undefined): Placemark | undefined =>
  place === undefined
    ? undefined
    : {
        ...(place.locality !== undefined && { locality: place.locality }),
        ...(place.country !== undefined && { country: place.country }),
        ...(place.country_code !== undefined && { country_code: place.country_code }),
      };
