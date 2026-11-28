import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createCell } from "#cell.ts";
import { createComingsAndGoings, lookGapMs, settleMs } from "#location/events.ts";
import { fullFor, glowOf } from "#location/days.ts";
import { cellBounds, geohash, metresBetween, simplify } from "#location/geo.ts";
import { createLocation, kindOf, type Location } from "#location/location.ts";
import { createPeoplePlaces } from "#location/people.ts";
import { mapsIn } from "#memory/maps.ts";
import type { LocationSample, LocationVisit } from "#protocol/types.ts";
import { ok } from "#result.ts";
import { openDatabase } from "#store/database.ts";
import { createVirtualClock, type VirtualClock } from "./support/virtual-clock.ts";

const folder = mkdtempSync(path.join(os.tmpdir(), "ito-location-"));

afterAll(() => {
  rmSync(folder, { recursive: true, force: true });
});

// A made-up Edinburgh: a flat, an office 1.3 km away, a café and a gym.
const flat = { latitude: 55.9415, longitude: -3.2058 };
const office = { latitude: 55.9524, longitude: -3.1965 };
const cafe = { latitude: 55.9466, longitude: -3.2012 };
const lisbon = { latitude: 38.7139, longitude: -9.1394 };

const at = (iso: string): string => new Date(Date.parse(iso)).toISOString();

const ignore = (): void => undefined;

const visit = (
  where: { readonly latitude: number; readonly longitude: number },
  arrived?: string,
  departed?: string,
  extra: Partial<LocationVisit> = {},
): LocationVisit => ({
  ...(arrived !== undefined && { arrived_at: at(arrived) }),
  ...(departed !== undefined && { departed_at: at(departed) }),
  ...where,
  accuracy: 20,
  ...extra,
});

// Points every 30 s on a straight line between two spots.
const walk = (
  from: { readonly latitude: number; readonly longitude: number },
  to: { readonly latitude: number; readonly longitude: number },
  start: string,
  minutes: number,
): LocationSample[] => {
  const startMs = Date.parse(start);
  return Array.from({ length: minutes * 2 + 1 }, (_, index) => {
    const share = index / (minutes * 2);
    return {
      at: new Date(startMs + index * 30_000).toISOString(),
      latitude: from.latitude + (to.latitude - from.latitude) * share,
      longitude: from.longitude + (to.longitude - from.longitude) * share,
      accuracy: 8,
      speed: 1.4,
    };
  });
};

type Opened = {
  readonly location: Location;
  readonly clock: VirtualClock;
  readonly closed: () => readonly string[];
};

const open = (start = "2026-11-24T21:00:00.000Z"): Opened => {
  const clock = createVirtualClock(Date.parse(start));
  const directory = mkdtempSync(path.join(folder, "db-"));
  const database = openDatabase(path.join(directory, "ito.db"));
  const serial = createCell(0);
  const closed = createCell<readonly string[]>([]);
  const location = createLocation({
    database,
    clock,
    timeZone: () => "Europe/London",
    newPlace: () => `p_${String(serial.update((count) => count + 1))}`,
    closeQuestion: (place, _note, state) => {
      closed.update((current) => [...current, `${place}:${state}`]);
    },
    info: ignore,
  });
  return { location, clock, closed: () => closed.get() };
};

// Two nights at the flat, a day at the office with a walk each way and a coffee on the way home.
const twoDays = (location: Location): void => {
  const uploaded = location.upload({
    batch: "b-1",
    time_zone: "Europe/London",
    visits: [
      visit(flat, "2026-11-22T18:00:00Z", "2026-11-23T08:40:00Z"),
      visit(office, "2026-11-23T09:00:00Z", "2026-11-23T17:30:00Z"),
      visit(cafe, "2026-11-23T17:45:00Z", "2026-11-23T18:20:00Z", { placemark: { name: "Kestrel Coffee" } }),
      visit(flat, "2026-11-23T18:35:00Z", "2026-11-24T08:40:00Z"),
      visit(office, "2026-11-24T09:00:00Z", "2026-11-24T17:30:00Z"),
      visit(flat, "2026-11-24T18:00:00Z"),
    ],
    samples: [...walk(flat, office, "2026-11-23T08:40:00Z", 20), ...walk(flat, office, "2026-11-24T08:40:00Z", 20)],
  });
  expect(uploaded.ok).toBe(true);
};

describe("geometry", () => {
  it("names cells by geohash, so a prefix is the cell around them", () => {
    expect(geohash({ latitude: 57.64911, longitude: 10.40744 }, 7)).toBe("u4pruyd");
    const bounds = cellBounds("u4pruyd");
    expect(bounds.south).toBeLessThan(57.64911);
    expect(bounds.north).toBeGreaterThan(57.64911);
    expect(geohash(flat, 5)).toBe(geohash(flat, 7).slice(0, 5));
  });

  it("simplifies a route without losing its corners", () => {
    const line = walk(flat, office, "2026-11-23T08:40:00Z", 10);
    expect(simplify(line, 15)).toHaveLength(2);
    const turn = { latitude: flat.latitude, longitude: office.longitude };
    const corner = [...walk(flat, turn, "2026-11-23T08:40:00Z", 5), ...walk(turn, office, "2026-11-23T08:45:30Z", 5)];
    expect(simplify(corner, 15).length).toBe(3);
  });

  it("glows on a saturating curve: full at 10 h a week, 40 h a month, 500 h a year", () => {
    expect(fullFor(7)).toBe(10);
    expect(fullFor(30)).toBe(40);
    expect(fullFor(365)).toBe(500);
    expect(Math.round(glowOf(6, 10) * 100) / 100).toBe(0.88);
    expect(Math.round(glowOf(2, 10) * 100) / 100).toBe(0.47);
    expect(Math.round(glowOf(1.5, 10) * 100) / 100).toBe(0.38);
    expect(glowOf(10, 10)).toBe(1);
    expect(glowOf(60, 10)).toBe(1);
  });
});

describe("uploading", () => {
  it("takes a batch once, however often it's sent", () => {
    const { location } = open();
    const batch = {
      batch: "b-once",
      visits: [visit(office, "2026-11-24T09:00:00Z")],
      samples: walk(flat, office, "2026-11-24T08:40:00Z", 2),
    };
    const first = location.upload(batch);
    expect(first.ok && first.value).toEqual({
      batch: "b-once",
      repeated: false,
      samples: { taken: 5, already: 0 },
      visits: { taken: 1, updated: 0, already: 0 },
    });
    const again = location.upload(batch);
    expect(again.ok && again.value.repeated).toBe(true);
    const renamed = location.upload({ ...batch, batch: "b-twice" });
    expect(renamed.ok && renamed.value).toEqual({
      batch: "b-twice",
      repeated: false,
      samples: { taken: 0, already: 5 },
      visits: { taken: 0, updated: 0, already: 1 },
    });
    const closed = location.upload({
      batch: "b-left",
      visits: [visit(office, "2026-11-24T09:00:00Z", "2026-11-24T17:30:00Z")],
    });
    expect(closed.ok && closed.value.visits).toEqual({ taken: 0, updated: 1, already: 0 });
    expect(location.held()).toMatchObject({ samples: 5, visits: 1, photos: 0, places: 1 });
  });

  it("refuses a visit with neither end, or one that leaves before it arrives", () => {
    const { location } = open();
    const backwards = location.upload({
      batch: "b-bad",
      visits: [visit(office, "2026-11-24T10:00:00Z", "2026-11-24T09:00:00Z")],
    });
    expect(backwards.ok).toBe(false);
  });
});

describe("places", () => {
  it("gathers visits within about 75 m, and lets a short stop pass", () => {
    const { location } = open();
    location.upload({
      batch: "b-1",
      visits: [
        visit(office, "2026-11-24T09:00:00Z", "2026-11-24T12:00:00Z"),
        visit(
          { latitude: office.latitude + 0.0003, longitude: office.longitude },
          "2026-11-24T13:00:00Z",
          "2026-11-24T17:00:00Z",
        ),
        visit(cafe, "2026-11-24T12:20:00Z", "2026-11-24T12:23:00Z"),
      ],
    });
    const places = location.places();
    expect(places).toHaveLength(1);
    expect(places[0]).toMatchObject({ hours: 7, visits: 2, kind: "unknown" });
  });

  it("finds home from where they sleep, and threads a day with its moves", () => {
    const { location } = open();
    twoDays(location);
    const home = location.home();
    expect(home).toBeDefined();
    expect(metresBetween(home ?? flat, flat)).toBeLessThan(10);
    const thread = location.days.thread("2026-11-23");
    expect(thread.items.map((item) => item.kind)).toEqual(["stop", "move", "stop", "move", "stop", "move", "stop"]);
    const [first, toWork] = thread.items;
    expect(first).toMatchObject({ kind: "stop", place_kind: "home", minutes: 520 });
    expect(toWork).toMatchObject({ kind: "move", minutes: 20, traced: true, mode: "walk" });
    expect(toWork?.kind === "move" && Math.abs(toWork.metres - 1300)).toBeLessThan(150);
    const cafeStop = thread.items[4];
    expect(cafeStop).toMatchObject({ apple_name: "Kestrel Coffee", minutes: 35 });
    const today = location.days.thread("2026-11-24");
    expect(today.items.at(-1)).toMatchObject({ kind: "stop", here: true, place_kind: "home" });
    expect(location.days.trail("2026-11-23").points.length).toBeLessThan(20);
  });

  it("ranks places by true hours over a range", () => {
    const { location } = open();
    twoDays(location);
    const week = location.places("2026-11-23", "2026-11-23");
    expect(week.map(({ kind }) => kind)).toEqual(["home", "unknown", "unknown"]);
    expect(week[1]).toMatchObject({ hours: 8.5, visits: 1 });
    const visits = location.placeVisits(Date.parse("2026-11-23T12:00:00Z"), Date.parse("2026-11-23T18:30:00Z"));
    expect(visits.map(({ place, minutes }) => [place.apple_name ?? place.kind, minutes])).toEqual([
      ["unknown", 510],
      ["Kestrel Coffee", 35],
    ]);
  });

  it("names a place in their words, with a kind from them", () => {
    const { location, closed } = open();
    twoDays(location);
    const office = location.places().find(({ hours }) => hours === 17);
    if (!office) throw new Error("no office");
    const asked = location.askAbout(office.id);
    expect(asked.ok && asked.value).toMatchObject({ place: office.id, visits: 2, hours: 17, minutes: 510 });
    location.named(office.id, "Northwind office");
    expect(location.find(office.id)).toMatchObject({ name: "Northwind office", kind: "work" });
    expect(location.askAbout(office.id).ok).toBe(false);
    const changed = location.change(office.id, { not_a_place: true });
    expect(changed.ok).toBe(true);
    expect(location.places().some(({ id }) => id === office.id)).toBe(false);
    expect(closed()).toContain(`${office.id}:settled`);
  });

  it("gives People the places named after someone, and the visits there", () => {
    const { location, clock } = open();
    twoDays(location);
    const cafePlace = location.places().find(({ apple_name: name }) => name === "Kestrel Coffee");
    if (!cafePlace) throw new Error("no café");
    location.named(cafePlace.id, "Leo's");
    const people = createPeoplePlaces(location, clock, () => "Europe/London");
    const leo = { address: "memory:people/leo", names: ["Leo"] };
    expect(people.places(leo)).toEqual([{ place: cafePlace.id, title: "Leo's" }]);
    expect(people.visits(leo)).toEqual([
      { day: "2026-11-23", kind: "place", at: "2026-11-23T17:45:00.000Z", what: "Leo's", hours: 0.6 },
    ]);
    expect(people.places({ address: "memory:people/omar", names: ["Omar"] })).toBeUndefined();
  });

  it("reads kinds from names", () => {
    expect(kindOf("Omar's five-a-side")).toBe("outdoors");
    expect(kindOf("Leo's")).toBe("friend");
    expect(kindOf("Quillfield Dental")).toBe("health");
    expect(kindOf("Orrin's", "Restaurant")).toBe("friend");
    expect(kindOf("Orrin", "Restaurant")).toBe("restaurant");
    expect(kindOf("Halcyon")).toBe("other");
  });
});

describe("heat and trips", () => {
  it("sums hours per cell over any range, home included", () => {
    const { location } = open();
    twoDays(location);
    const heat = location.days.heat("2026-11-23", "2026-11-23", 7);
    expect(heat.full).toBe(10);
    const homeCell = heat.cells.find(({ cell }) => cell === geohash(flat));
    expect(homeCell?.glow).toBe(1);
    const coarse = location.days.heat("2026-11-23", "2026-11-23", 4);
    expect(coarse.cells).toHaveLength(1);
    expect(coarse.cells[0]?.hours).toBe(23.5);
  });

  it("makes trips of days away from photos, never waking Kumo", () => {
    const { location } = open();
    const heard = createCell(0);
    location.onMoments(() => {
      heard.update((count) => count + 1);
    });
    twoDays(location);
    const seeded = location.seed({
      batch: "photos-1",
      photos: ["2026-03-14", "2026-03-15", "2026-03-16"].flatMap((day) =>
        [10, 13, 17].map((hour) => ({
          taken_at: `${day}T${String(hour)}:00:00.000Z`,
          ...lisbon,
          placemark: { locality: "Lisbon", country: "Portugal", country_code: "PT" },
        })),
      ),
    });
    expect(seeded.ok && seeded.value).toEqual({ batch: "photos-1", repeated: false, taken: 9, already: 0 });
    const trips = location.days.trips();
    expect(trips).toEqual([
      expect.objectContaining({
        id: "2026-03-14",
        from: "2026-03-14",
        to: "2026-03-16",
        days: 3,
        countries: [{ name: "Portugal", code: "PT" }],
        cities: ["Lisbon"],
        from_photos: true,
      }),
    ]);
    const year = location.days.heat("2026-01-01", "2026-12-31", 3);
    const away = year.cells.find(({ cell }) => cell === geohash(lisbon, 3));
    expect(away?.hours).toBe(42);
    expect(location.days.thread("2026-03-15")).toMatchObject({ from_photos: true });
    const arrived = location.places().find(({ from_photos: photos }) => photos === true);
    expect(arrived && location.askAbout(arrived.id).ok).toBe(false);
    expect(heard.get()).toBe(0);
  });

  it("forgets a range, and everything, with what came from it", () => {
    const { location, closed } = open();
    twoDays(location);
    location.seed({ batch: "photos-1", photos: [{ taken_at: "2026-03-14T10:00:00.000Z", ...lisbon }] });
    const forgotten = location.forget({ from: "2026-03-01", to: "2026-03-31" });
    expect(forgotten.ok && forgotten.value).toEqual({ samples: 0, visits: 0, photos: 1, places: 0 });
    const cafePlace = location.places().find(({ apple_name: name }) => name === "Kestrel Coffee");
    const day = location.forget({ day: "2026-11-23" });
    expect(day.ok && day.value.places).toBe(1);
    expect(closed()).toContain(`${cafePlace?.id ?? ""}:dropped`);
    expect(location.days.thread("2026-11-23").items).toEqual([]);
    expect(location.days.heat("2026-11-23", "2026-11-23", 7).cells).toEqual([]);
    const all = location.forget({ everything: true });
    expect(all.ok).toBe(true);
    expect(location.held()).toEqual({ samples: 0, visits: 0, photos: 0, places: 0 });
  });
});

const watch = (start = "2026-11-24T09:00:00.000Z") => {
  const opened = open(start);
  const prompts = createCell<readonly string[]>([]);
  createComingsAndGoings({
    location: opened.location,
    clock: opened.clock,
    timeZone: () => "Europe/London",
    work: (prompt) => {
      prompts.update((current) => [...current, prompt]);
      return Promise.resolve(ok("Noted nothing."));
    },
    eventsDuring: () => [{ title: "Five-a-side", location: "Dalry" }],
    isAsked: () => false,
    info: ignore,
  });
  const later = (ms: number): void => {
    const until = opened.clock.now() + ms;
    const runDue = (): void => {
      if (opened.clock.runNext(until)) runDue();
    };
    runDue();
    opened.clock.moveTo(until);
  };
  return { ...opened, prompts: () => prompts.get(), later };
};

describe("comings and goings", () => {
  it("wakes Kumo once a fresh arrival settles", async () => {
    const { location, later, prompts } = watch("2026-11-24T09:02:00.000Z");
    location.upload({ batch: "b-1", visits: [visit(office, "2026-11-24T09:00:00Z")] });
    later(settleMs - 1000);
    expect(prompts()).toHaveLength(0);
    later(1000);
    await Promise.resolve();
    expect(prompts()).toHaveLength(1);
    expect(prompts()[0]).toContain("- Arrived at a place you can't name yet");
    expect(prompts()[0]).toContain("don't tell them");
  });

  it("lets jitter, short stops and stale data pass quietly", async () => {
    const { location, later, prompts, clock } = watch("2026-11-24T12:00:00.000Z");
    location.upload({
      batch: "b-stale",
      visits: [visit(office, "2026-11-24T09:00:00Z", "2026-11-24T10:30:00Z")],
    });
    later(settleMs);
    await Promise.resolve();
    expect(prompts()).toHaveLength(0);
    location.upload({ batch: "b-in", visits: [visit(cafe, "2026-11-24T12:02:00Z")] });
    clock.moveTo(Date.parse("2026-11-24T12:08:00.000Z"));
    location.upload({
      batch: "b-jitter",
      visits: [visit(cafe, "2026-11-24T12:02:00Z", "2026-11-24T12:06:00Z"), visit(cafe, "2026-11-24T12:07:00Z")],
    });
    later(settleMs);
    await Promise.resolve();
    expect(prompts()).toHaveLength(0);
  });

  it("looks at most every 15 minutes, with what came meanwhile", async () => {
    const { location, later, prompts, clock } = watch("2026-11-24T09:01:00.000Z");
    location.upload({ batch: "b-1", visits: [visit(flat, "2026-11-23T18:00:00Z", "2026-11-24T08:40:00Z")] });
    later(settleMs);
    await Promise.resolve();
    expect(prompts()).toHaveLength(1);
    clock.moveTo(Date.parse("2026-11-24T09:06:00.000Z"));
    location.upload({ batch: "b-2", visits: [visit(office, "2026-11-24T09:05:00Z")] });
    later(settleMs);
    await Promise.resolve();
    expect(prompts()).toHaveLength(1);
    later(lookGapMs);
    await Promise.resolve();
    expect(prompts()).toHaveLength(2);
    expect(prompts()[1]).toContain("Arrived at");
  });
});

describe("journal maps", () => {
  it("finds the routes and trips a page shows", () => {
    expect(
      mapsIn("Up the hill.\n\n![My walk](route:2026-11-22)\n\n![Lisbon](trip:2026-03-14) ![photo](../media/a.jpg)"),
    ).toEqual([
      { source: "route:2026-11-22", kind: "route", day: "2026-11-22" },
      { source: "trip:2026-03-14", kind: "trip", day: "2026-03-14" },
    ]);
  });
});
