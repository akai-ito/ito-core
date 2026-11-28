import type { DatabaseSync } from "node:sqlite";
import { createCell } from "#cell.ts";
import { toTimestamp, type Clock } from "#clock.ts";
import { atLocal } from "#desk/day.ts";
import { toDay } from "#memory/pages.ts";
import { createDays, type Days } from "#location/days.ts";
import { meanOf, metresBetween, rounded } from "#location/geo.ts";
import { createRecords, without, type KeptPlace, type Visit } from "#location/records.ts";
import { isTimeZone } from "#places/places.ts";
import type {
  ForgetLocation,
  ForgetResult,
  LocationBatch,
  LocationBatchResult,
  LocationHeld,
  PhotoSeeds,
  PhotoSeedsResult,
  Place,
  PlaceAsk,
  PlaceChange,
  PlaceKind,
  PlacePage,
  Placemark,
  PlaceVisit,
} from "#protocol/types.ts";
import { fail, ok, type Result } from "#result.ts";
import type { Info } from "#turns/turns.ts";

// Places: where they've been, from their phone while places are on. The phone uploads live points and iOS's visits in
// batches, and seeds the past from where photos were taken. Visits within about 75 m gather into places; home is
// where they sleep, and days mostly 50 km or more from it are days away, which make trips. Every day's heat is kept
// by cell, so any range is a cheap sum. Arriving and leaving are moments Kumo hears about (see events.ts); seeded
// data never is. Everything stays until they forget a day, a range or all of it, which takes what came from it too.

// A fresh arrival or departure, for Kumo to judge.
export type Moment = {
  readonly kind: "arrived" | "left";
  readonly at: number;
  readonly visit: number;
  readonly place: string;
  readonly since?: number;
};

export type Location = {
  readonly upload: (batch: LocationBatch) => Result<LocationBatchResult, string>;
  readonly seed: (seeds: PhotoSeeds) => Result<PhotoSeedsResult, string>;
  readonly forget: (what: ForgetLocation) => Result<ForgetResult, string>;
  readonly held: () => LocationHeld;
  readonly places: (from?: string, to?: string) => readonly Place[];
  readonly place: (id: string) => PlacePage | undefined;
  readonly change: (id: string, change: PlaceChange) => Result<Place, string>;
  readonly days: Days;
  // Today worked out again, so an open stay counts until now.
  readonly freshen: () => void;
  readonly find: (id: string) => KeptPlace | undefined;
  readonly all: () => readonly KeptPlace[];
  readonly home: () => KeptPlace | undefined;
  readonly visit: (id: number) => Visit | undefined;
  readonly visitsOf: (place: string) => readonly Visit[];
  readonly visitsDuring: (from: number, to: number) => readonly Visit[];
  // The seam for People: the visits in a span of time, each with its place as the API shows it (name, kind and
  // Apple's name), for last seen and places shared, such as visits to Leo's. Places set aside are left out.
  readonly placeVisits: (from: number, to: number) => readonly PlaceVisitOf[];
  // What a place question shows: the place and its latest stay.
  readonly askAbout: (id: string) => Result<PlaceAsk, string>;
  // They named it, answering a place question.
  readonly named: (id: string, name: string) => void;
  // Whether Kumo could ask about it: not named, not home, not set aside, and seen live.
  readonly isUnknown: (place: KeptPlace) => boolean;
  readonly displayName: (place: KeptPlace) => string;
  readonly onMoments: (listener: (moments: readonly Moment[]) => void) => void;
};

export type PlaceVisitOf = PlaceVisit & { readonly place: Place };

export type LocationOptions = {
  readonly database: DatabaseSync;
  readonly clock: Clock;
  readonly timeZone: () => string;
  readonly newPlace: () => string;
  // A place's open question is settled or dropped when the place is renamed, set aside or forgotten.
  readonly closeQuestion: (place: string, note: string, state: "settled" | "dropped") => void;
  readonly info: Info;
};

const minuteMs = 60 * 1000;
const hourMs = 60 * minuteMs;
const joinMetres = 75;
const coarsestJoin = 150;
// A stay shorter than this is passing through, not a visit to a place.
const shortestStay = 5 * minuteMs;
// A stay seeded from photos makes a place of its own only with this many photos, or this long.
const seedPhotos = 3;
const seedMs = 30 * minuteMs;
// Photos this close in space and time are one stay.
const seedMetres = 300;
const seedGapMs = 4 * hourMs;
// A moment older than this when it arrives isn't news.
const freshMs = 60 * minuteMs;
const nightsLooked = 60;
const fewestNights = 2;
const nightMinutes = 3 * 60;
const nameLength = 80;

const kindWords: readonly (readonly [PlaceKind, RegExp])[] = [
  ["home", /\bhome\b|\bmy (?:flat|house|place)\b/iu],
  ["work", /\b(?:work|office|studio)\b/iu],
  ["gym", /\b(?:gym|climbing|pool|yoga|pilates|fitness)\b/iu],
  ["cafe", /\b(?:cafe|café|coffee|bakery)\b/iu],
  ["restaurant", /\b(?:restaurant|bistro|pizza|sushi|kitchen|dinner|lunch)\b/iu],
  ["bar", /\b(?:bar|pub|tavern|wine)\b/iu],
  ["shop", /\b(?:shop|store|market|supermarket|grocer)\b/iu],
  ["school", /\b(?:school|university|college|library|class)\b/iu],
  ["health", /\b(?:doctor|dentist|dental|clinic|hospital|gp|physio|pharmacy)\b/iu],
  ["outdoors", /\b(?:park|beach|hill|trail|garden|pitch|five-a-side|football)\b/iu],
  ["travel", /\b(?:station|airport|hotel|terminal)\b/iu],
  ["family", /\b(?:mum|mom|dad|parents|gran|grandma|grandpa|sister|brother|aunt|uncle)\b/iu],
  ["friend", /\p{L}['’]s\b/iu],
];

const categoryKinds: Readonly<Record<string, PlaceKind>> = {
  Restaurant: "restaurant",
  Cafe: "cafe",
  Bakery: "cafe",
  FitnessCenter: "gym",
  Park: "outdoors",
  Beach: "outdoors",
  NationalPark: "outdoors",
  Store: "shop",
  FoodMarket: "shop",
  School: "school",
  University: "school",
  Library: "school",
  Hospital: "health",
  Pharmacy: "health",
  Airport: "travel",
  PublicTransport: "travel",
  Hotel: "travel",
  Nightlife: "bar",
  Brewery: "bar",
  Winery: "bar",
};

// The kind a name says, such as a gym for "the climbing wall", or Apple's category for it.
export const kindOf = (name: string, category?: string): PlaceKind =>
  kindWords.find(([, pattern]) => pattern.test(name))?.[0] ??
  (category === undefined ? undefined : categoryKinds[category]) ??
  "other";

const durationOf = (visit: Visit, now: number): number =>
  visit.arrivedAt === undefined ? 0 : Math.max(0, (visit.departedAt ?? now) - visit.arrivedAt);

const hoursOf = (ms: number): number => Math.round((ms / hourMs) * 10) / 10;

const whenOf = (visit: Visit): number => visit.arrivedAt ?? visit.departedAt ?? 0;

const dayIn = (at: number, zone: string): string => toDay(at, zone);

// What the API shows of a kept place.
const shown = (place: KeptPlace): Place => without(place, "named_by", "kind_by", "not_a_place");

const toPlaceVisit = (visit: Visit, now: number): PlaceVisit => ({
  ...(visit.arrivedAt !== undefined && { arrived_at: toTimestamp(visit.arrivedAt) }),
  ...(visit.departedAt !== undefined && { departed_at: toTimestamp(visit.departedAt) }),
  minutes: Math.round(durationOf(visit, now) / minuteMs),
  ...(visit.seeded && { from_photos: true as const }),
});

const isUnknown = (candidate: KeptPlace): boolean =>
  candidate.name === undefined &&
  candidate.kind !== "home" &&
  candidate.not_a_place !== true &&
  candidate.from_photos !== true;

const displayName = (candidate: KeptPlace): string =>
  candidate.name ??
  (candidate.kind === "home"
    ? "home"
    : candidate.apple_name === undefined
      ? "a place you can't name yet"
      : `a place you can't name yet (Apple calls it ${candidate.apple_name})`);

export const createLocation = ({
  database,
  clock,
  timeZone,
  newPlace,
  closeQuestion,
  info,
}: LocationOptions): Location => {
  const records = createRecords(database);
  const listeners = createCell<readonly ((moments: readonly Moment[]) => void)[]>([]);

  const find = (id: string): KeptPlace | undefined => records.places().find((place) => place.id === id);

  const home = (): KeptPlace | undefined => {
    const homes = records.places().filter(({ kind, not_a_place: set }) => kind === "home" && set !== true);
    return homes.find(({ kind_by: by }) => by === "you") ?? homes[0];
  };

  const days = createDays({ records, now: () => clock.now(), timeZone, placeOf: find, home });

  const zoneFor = (given: string | undefined): string =>
    given !== undefined && isTimeZone(given) ? given : timeZone();

  // A place's facts again, from its visits: where it is, how long, how often, Apple's words for it.
  const refresh = (id: string): void => {
    const place = find(id);
    if (!place) return;
    const visits = records.visitsOf(id);
    if (visits.length === 0) {
      records.removePlace(id);
      closeQuestion(id, "The visits that made it were forgotten.", "dropped");
      return;
    }
    const now = clock.now();
    const centre =
      meanOf(visits.map((visit) => ({ ...visit, weight: Math.max(durationOf(visit, now), minuteMs) }))) ?? place;
    const named = visits.findLast(({ placemark }) => placemark?.name !== undefined)?.placemark;
    const where = visits.findLast(({ placemark }) => placemark !== undefined)?.placemark;
    const times = visits.map((visit) => whenOf(visit));
    const live = visits.filter(({ seeded }) => !seeded);
    const radius = Math.round(Math.max(...visits.map((visit) => metresBetween(centre, visit))));
    const kept = without(place, "apple_name", "street", "locality", "country", "country_code", "here", "from_photos");
    records.savePlace({
      ...kept,
      latitude: rounded(centre.latitude),
      longitude: rounded(centre.longitude),
      radius,
      hours: hoursOf(visits.reduce((sum, visit) => sum + durationOf(visit, now), 0)),
      visits: visits.length,
      first_visit: toTimestamp(Math.min(...times)),
      last_visit: toTimestamp(Math.max(...times)),
      ...(named?.name !== undefined && { apple_name: named.name }),
      ...(where?.street !== undefined && { street: where.street }),
      ...(where?.locality !== undefined && { locality: where.locality }),
      ...(where?.country !== undefined && { country: where.country }),
      ...(where?.country_code !== undefined && { country_code: where.country_code }),
      ...(live.some(({ departedAt }) => departedAt === undefined) && { here: true as const }),
      ...(live.length === 0 && { from_photos: true as const }),
    });
  };

  // The place a visit belongs to: the nearest within about 75 m (more for a coarse fix), or a new one.
  const assign = (visit: Visit): string | undefined => {
    const now = clock.now();
    const ms = durationOf(visit, now);
    const isPassing = visit.departedAt !== undefined && ms < shortestStay;
    if (isPassing) {
      if (visit.place !== undefined) records.placeVisit(visit.id, undefined);
      return visit.place;
    }
    if (visit.place !== undefined) return visit.place;
    const reach = Math.max(joinMetres, Math.min(visit.accuracy, coarsestJoin));
    const nearest = records
      .places()
      .map((place) => ({ place, metres: metresBetween(place, visit) }))
      .filter(({ metres }) => metres <= reach)
      .toSorted((left, right) => left.metres - right.metres)[0]?.place;
    if (nearest) {
      records.placeVisit(visit.id, nearest.id);
      return nearest.id;
    }
    if (visit.seeded && visit.photos < seedPhotos && ms < seedMs) return undefined;
    const id = newPlace();
    records.savePlace({
      id,
      kind: "unknown",
      latitude: rounded(visit.latitude),
      longitude: rounded(visit.longitude),
      radius: 0,
      hours: 0,
      visits: 1,
      first_visit: toTimestamp(whenOf(visit)),
      last_visit: toTimestamp(whenOf(visit)),
    });
    records.placeVisit(visit.id, id);
    return id;
  };

  // Home is the place they slept at most, at 03:00, over the last two months of visits; a home they set wins.
  const findHome = (): boolean => {
    const before = home();
    if (before?.kind_by === "you") return false;
    const now = clock.now();
    const nights = records
      .liveDays(nightsLooked, dayIn(now, timeZone()))
      .reduce<ReadonlyMap<string, number>>((sum, day) => {
        const night = atLocal(day, nightMinutes, records.zoneOf(day) ?? timeZone());
        const slept = records
          .visitsDuring(night, night + 1, now)
          .find(({ seeded, place }) => !seeded && place !== undefined)?.place;
        return slept === undefined ? sum : new Map(sum).set(slept, (sum.get(slept) ?? 0) + 1);
      }, new Map());
    const [best, count = 0] = [...nights].toSorted(([, left], [, right]) => right - left)[0] ?? [];
    const found = best === undefined || count < fewestNights ? undefined : find(best);
    if (found === undefined || found.id === before?.id || found.not_a_place === true || found.kind_by === "you") {
      return false;
    }
    if (before) {
      records.savePlace({
        ...without(before, "kind_by"),
        kind: before.name === undefined ? "unknown" : kindOf(before.name),
      });
    }
    records.savePlace({ ...found, kind: "home", kind_by: "home" });
    info("Home is where they sleep", { place: found.id });
    return true;
  };

  const today = (): string => dayIn(clock.now(), timeZone());

  const rebuildAll = (): void => {
    const all = records.days(today());
    for (const day of all) days.rebuild(day);
  };

  // After rows change: places for the visits, home, and the days touched worked out again.
  // Gives the place each visit belongs to, or belonged to before it turned out to be passing through.
  const settle = (visits: readonly number[], touched: ReadonlySet<string>): ReadonlyMap<number, string> => {
    const placed = new Map(
      visits.flatMap((id) => {
        const visit = records.visit(id);
        const place = visit === undefined ? undefined : assign(visit);
        return place === undefined ? [] : [[id, place] as const];
      }),
    );
    const places = new Set(placed.values());
    for (const place of places) refresh(place);
    if (findHome()) rebuildAll();
    else for (const day of touched) days.rebuild(day);
    return placed;
  };

  const upload = (batch: LocationBatch): Result<LocationBatchResult, string> => {
    const kept = records.batch(batch.batch);
    if (kept !== undefined) return ok({ ...(JSON.parse(kept) as LocationBatchResult), repeated: true });
    if (batch.time_zone !== undefined && !isTimeZone(batch.time_zone)) {
      return fail(`${batch.time_zone} isn't a time zone, such as Europe/London.`);
    }
    const isUnfit = (batch.visits ?? []).some(
      ({ arrived_at: arrived, departed_at: departed }) =>
        (arrived === undefined && departed === undefined) ||
        (arrived !== undefined && departed !== undefined && departed < arrived),
    );
    if (isUnfit) return fail("A visit needs its arrival or its departure, and can't leave before it arrives.");
    const zone = zoneFor(batch.time_zone);
    const now = clock.now();
    const touched = createCell<ReadonlySet<string>>(new Set());
    const changed = createCell<readonly number[]>([]);
    const moments = createCell<readonly Moment[]>([]);
    const touch = (day: string): void => {
      touched.update((current) => new Set([...current, day]));
    };
    const note = (id: number): void => {
      changed.update((current) => [...current, id]);
    };
    const hear = (moment: Moment): void => {
      moments.update((current) => [...current, moment]);
    };
    const result = records.transaction((): LocationBatchResult => {
      const samples = (batch.samples ?? []).map((sample) => {
        const at = Date.parse(sample.at);
        const day = dayIn(at, zone);
        const isNew = records.addSample({ ...sample, at, source: sample.source ?? "live" }, day, zone);
        if (isNew) touch(day);
        return isNew;
      });
      const ordered = (batch.visits ?? []).toSorted(
        (left, right) =>
          Date.parse(left.arrived_at ?? left.departed_at ?? "") -
          Date.parse(right.arrived_at ?? right.departed_at ?? ""),
      );
      const outcomes = ordered.map((given): "taken" | "updated" | "already" => {
        const arrivedAt = given.arrived_at === undefined ? undefined : Date.parse(given.arrived_at);
        const departedAt = given.departed_at === undefined ? undefined : Date.parse(given.departed_at);
        const existing =
          arrivedAt === undefined
            ? ((departedAt === undefined ? undefined : records.visitDepartedAt(departedAt)) ??
              records
                .openVisitsBefore(departedAt ?? now)
                .find((visit) => metresBetween(visit, given) <= coarsestJoin * 2))
            : records.visitArrivedAt(arrivedAt);
        if (existing) {
          if (departedAt !== undefined && existing.departedAt === undefined) {
            records.closeVisit(existing.id, departedAt, dayIn(departedAt, existing.timeZone), given.placemark);
            note(existing.id);
            touch(existing.day);
            touch(dayIn(departedAt, existing.timeZone));
            hear({
              kind: "left",
              at: departedAt,
              visit: existing.id,
              place: "",
              ...(existing.arrivedAt !== undefined && { since: existing.arrivedAt }),
            });
            return "updated";
          }
          if (given.placemark !== undefined && existing.placemark === undefined) {
            records.nameVisit(existing.id, given.placemark);
            note(existing.id);
          }
          return "already";
        }
        if (arrivedAt !== undefined) {
          // iOS sometimes never says they left: an earlier visit still open ended when this one began.
          for (const open of records.openVisitsBefore(arrivedAt)) {
            records.closeVisit(open.id, arrivedAt, dayIn(arrivedAt, open.timeZone));
            note(open.id);
          }
        }
        const day = dayIn(arrivedAt ?? departedAt ?? now, zone);
        const placemark: Placemark | undefined = given.placemark;
        const id = records.addVisit(
          {
            ...(arrivedAt !== undefined && { arrivedAt }),
            ...(departedAt !== undefined && { departedAt }),
            day,
            timeZone: zone,
            latitude: given.latitude,
            longitude: given.longitude,
            accuracy: given.accuracy,
            ...(placemark && { placemark }),
            seeded: false,
            photos: 0,
          },
          departedAt === undefined ? undefined : dayIn(departedAt, zone),
        );
        note(id);
        touch(day);
        if (departedAt !== undefined) touch(dayIn(departedAt, zone));
        if (arrivedAt !== undefined && departedAt === undefined) {
          hear({ kind: "arrived", at: arrivedAt, visit: id, place: "" });
        }
        if (departedAt !== undefined) {
          hear({
            kind: "left",
            at: departedAt,
            visit: id,
            place: "",
            ...(arrivedAt !== undefined && { since: arrivedAt }),
          });
        }
        return "taken";
      });
      const counted: LocationBatchResult = {
        batch: batch.batch,
        repeated: false,
        samples: { taken: samples.filter(Boolean).length, already: samples.filter((isNew) => !isNew).length },
        visits: {
          taken: outcomes.filter((outcome) => outcome === "taken").length,
          updated: outcomes.filter((outcome) => outcome === "updated").length,
          already: outcomes.filter((outcome) => outcome === "already").length,
        },
      };
      records.keepBatch(batch.batch, toTimestamp(now), JSON.stringify(counted));
      return counted;
    });
    touch(dayIn(now, timeZone()));
    const placed = settle(changed.get(), touched.get());
    const fresh = moments.get().flatMap((moment): readonly Moment[] => {
      const place = placed.get(moment.visit) ?? records.visit(moment.visit)?.place;
      return place === undefined || now - moment.at > freshMs ? [] : [{ ...moment, place }];
    });
    if (fresh.length > 0) for (const listener of listeners.get()) listener(fresh);
    return ok(result);
  };

  // A day's photos as stays: photos close together in space and time are one.
  const seedDay = (day: string): readonly number[] => {
    records.removeSeededVisitsOn(day);
    const photos = records.photosOn(day);
    const stays = photos.reduce<readonly (typeof photos)[number][][]>((sofar, photo) => {
      const stay = sofar.at(-1);
      const first = stay?.[0];
      const last = stay?.at(-1);
      return stay !== undefined &&
        first !== undefined &&
        last !== undefined &&
        photo.takenAt - last.takenAt <= seedGapMs &&
        metresBetween(first, photo) <= seedMetres
        ? [...sofar.slice(0, -1), [...stay, photo]]
        : [...sofar, [photo]];
    }, []);
    return stays.flatMap((stay) => {
      const first = stay[0];
      const last = stay.at(-1);
      const centre = meanOf(stay.map((photo) => ({ ...photo, weight: 1 })));
      if (first === undefined || last === undefined || centre === undefined) return [];
      const placemark = stay.find((photo) => photo.placemark !== undefined)?.placemark;
      return records.addVisit({
        arrivedAt: first.takenAt,
        departedAt: last.takenAt,
        day,
        timeZone: first.timeZone,
        latitude: centre.latitude,
        longitude: centre.longitude,
        accuracy: seedMetres,
        ...(placemark && { placemark }),
        seeded: true,
        photos: stay.length,
      });
    });
  };

  const seed = (seeds: PhotoSeeds): Result<PhotoSeedsResult, string> => {
    const kept = records.batch(seeds.batch);
    if (kept !== undefined) return ok({ ...(JSON.parse(kept) as PhotoSeedsResult), repeated: true });
    if (seeds.time_zone !== undefined && !isTimeZone(seeds.time_zone)) {
      return fail(`${seeds.time_zone} isn't a time zone, such as Europe/London.`);
    }
    const zone = zoneFor(seeds.time_zone);
    const touched = createCell<ReadonlySet<string>>(new Set());
    const { result, visits } = records.transaction(() => {
      const taken = seeds.photos.map((photo) => {
        const takenAt = Date.parse(photo.taken_at);
        const day = dayIn(takenAt, zone);
        const isNew = records.addPhoto({
          takenAt,
          day,
          timeZone: zone,
          latitude: photo.latitude,
          longitude: photo.longitude,
          ...(photo.placemark && { placemark: photo.placemark }),
        });
        if (isNew) touched.update((current) => new Set([...current, day]));
        return isNew;
      });
      const counted: PhotoSeedsResult = {
        batch: seeds.batch,
        repeated: false,
        taken: taken.filter(Boolean).length,
        already: taken.filter((isNew) => !isNew).length,
      };
      records.keepBatch(seeds.batch, toTimestamp(clock.now()), JSON.stringify(counted));
      const days = [...touched.get()];
      const before = days.flatMap((day) => records.seededVisitsOn(day).flatMap(({ place }) => place ?? []));
      const made = days.flatMap((day) => seedDay(day));
      const emptied = new Set(before);
      for (const place of emptied) refresh(place);
      return { result: counted, visits: made };
    });
    settle(visits, touched.get());
    return ok(result);
  };

  const forget = (what: ForgetLocation): Result<ForgetResult, string> => {
    const range =
      "everything" in what
        ? undefined
        : "day" in what
          ? { from: what.day, to: what.day }
          : { from: what.from, to: what.to };
    if (range && range.from > range.to) return fail("The range ends before it begins.");
    const before = records.places().map(({ id }) => id);
    const homeBefore = home()?.id;
    const touched =
      range === undefined
        ? []
        : [
            ...new Set([
              ...records.days(today()).filter((day) => day >= range.from && day <= range.to),
              ...records.daysAround(range.from, range.to),
            ]),
          ];
    const forgotten = records.transaction(() =>
      range === undefined ? records.forgetEverything() : records.forget(range.from, range.to),
    );
    for (const id of before) refresh(id);
    const removed = before.filter((id) => find(id) === undefined).length;
    findHome();
    if (home()?.id === homeBefore) for (const day of touched) days.rebuild(day);
    else rebuildAll();
    info("They forgot where they'd been", {
      span: range === undefined ? "everything" : `${range.from} to ${range.to}`,
    });
    return ok({ samples: forgotten.samples, visits: forgotten.visits, photos: forgotten.photos, places: removed });
  };

  const freshen = (): void => {
    const day = today();
    if (records.hasLive(day) || records.zoneOf(day) !== undefined) days.rebuild(day);
  };

  const visible = (): readonly KeptPlace[] => records.places().filter(({ not_a_place: set }) => set !== true);

  const places = (from?: string, to?: string): readonly Place[] => {
    if (from === undefined && to === undefined) {
      return visible()
        .map((place) => shown(place))
        .toSorted((left, right) => right.hours - left.hours || left.first_visit.localeCompare(right.first_visit));
    }
    const now = clock.now();
    const visits = records.visitsInDays(from ?? "0000-01-01", to ?? "9999-12-31");
    return visible()
      .flatMap((place): readonly Place[] => {
        const mine = visits.filter((visit) => visit.place === place.id);
        if (mine.length === 0) return [];
        return [
          {
            ...shown(place),
            hours: hoursOf(mine.reduce((sum, visit) => sum + durationOf(visit, now), 0)),
            visits: mine.length,
          },
        ];
      })
      .toSorted((left, right) => right.hours - left.hours || left.first_visit.localeCompare(right.first_visit));
  };

  const place = (id: string): PlacePage | undefined => {
    const found = find(id);
    if (!found || found.not_a_place === true) return undefined;
    const now = clock.now();
    return {
      place: shown(found),
      visits: records
        .visitsOf(id)
        .toReversed()
        .map((visit) => toPlaceVisit(visit, now)),
    };
  };

  const change = (id: string, given: PlaceChange): Result<Place, string> => {
    const found = find(id);
    if (!found || found.not_a_place === true) return fail("not_found");
    if (given.kind === "unknown") return fail("A place's kind can be anything but unknown.");
    const name = given.name?.replaceAll(/\s+/gu, " ").trim();
    if (name === "") return fail("Give the place a name.");
    if (given.not_a_place === true) {
      records.savePlace({ ...found, not_a_place: true });
      closeQuestion(id, "You said it isn't a place.", "settled");
      const visited = new Set(records.visitsOf(id).map((visit) => visit.day));
      for (const day of visited) days.rebuild(day);
      return ok(shown(found));
    }
    const kind = given.kind ?? (name === undefined ? found.kind : found.kind === "unknown" ? kindOf(name) : found.kind);
    const changed: KeptPlace = {
      ...found,
      ...(name !== undefined && { name, named_by: "you" as const }),
      kind,
      ...(given.kind !== undefined && { kind_by: "you" as const }),
    };
    records.savePlace(changed);
    if (name !== undefined) closeQuestion(id, `You named it ${name}.`, "settled");
    if (kind === "home" || found.kind === "home") {
      if (kind === "home") {
        for (const other of records.places()) {
          if (other.id === id || other.kind !== "home") continue;
          records.savePlace({
            ...without(other, "kind_by"),
            kind: other.name === undefined ? "unknown" : kindOf(other.name),
          });
        }
      }
      rebuildAll();
    }
    return ok(shown(changed));
  };

  const askAbout = (id: string): Result<PlaceAsk, string> => {
    const found = find(id);
    if (!found) return fail(`There's no place ${id}.`);
    if (found.not_a_place === true) return fail("They said that isn't a place.");
    if (found.name !== undefined) return fail(`That place already has a name: ${found.name}.`);
    if (found.kind === "home") return fail("That's their home.");
    if (found.from_photos === true)
      return fail("That place is known only from photos: ask about places they visit now.");
    const now = clock.now();
    const latest = records.visitsOf(id).findLast(({ seeded }) => !seeded);
    if (latest === undefined) return fail(`There's no visit to ${id} to ask about.`);
    return ok({
      place: id,
      latitude: found.latitude,
      longitude: found.longitude,
      arrived_at: toTimestamp(whenOf(latest)),
      ...(latest.departedAt !== undefined &&
        latest.arrivedAt !== undefined && {
          departed_at: toTimestamp(latest.departedAt),
        }),
      minutes: Math.round(durationOf(latest, now) / minuteMs),
      visits: found.visits,
      hours: found.hours,
      ...(found.apple_name !== undefined && { apple_name: found.apple_name }),
      ...(found.street !== undefined && { street: found.street }),
      ...(found.locality !== undefined && { locality: found.locality }),
    });
  };

  const named = (id: string, name: string): void => {
    const found = find(id);
    const clean = name.replaceAll(/\s+/gu, " ").trim().slice(0, nameLength);
    if (clean === "" || !found || found.not_a_place === true) return;
    const category = records.visitsOf(id).findLast(({ placemark }) => placemark?.category !== undefined)
      ?.placemark?.category;
    records.savePlace({
      ...found,
      name: clean,
      named_by: "you",
      ...(found.kind_by === undefined && { kind: kindOf(clean, category) }),
    });
    info("They named a place", { place: id });
  };

  const held = (): LocationHeld => {
    const counts = records.counts();
    const all = records.days(today());
    const homePlace = home();
    const uploaded = records.lastBatchAt();
    return {
      ...counts,
      places: visible().length,
      ...(all[0] !== undefined && { first_day: all[0] }),
      ...(all.at(-1) !== undefined && { last_day: all.at(-1) }),
      ...(uploaded !== undefined && { uploaded_at: uploaded }),
      ...(homePlace && { home: homePlace.id }),
    };
  };

  return {
    upload,
    seed,
    forget,
    held,
    places,
    place,
    change,
    days,
    freshen,
    find,
    all: visible,
    home,
    visit: (id) => records.visit(id),
    visitsOf: (id) => records.visitsOf(id),
    visitsDuring: (from, to) => records.visitsDuring(from, to, clock.now()),
    placeVisits: (from, to) => {
      const now = clock.now();
      return records.visitsDuring(from, to, now).flatMap((visit): readonly PlaceVisitOf[] => {
        const found = visit.place === undefined ? undefined : find(visit.place);
        return found === undefined || found.not_a_place === true
          ? []
          : [{ ...toPlaceVisit(visit, now), place: shown(found) }];
      });
    },
    askAbout,
    named,
    isUnknown,
    displayName,
    onMoments: (listener) => {
      listeners.update((current) => [...current, listener]);
    },
  };
};

export { daysBetween, jitterMs } from "#location/days.ts";
