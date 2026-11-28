import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { Place, PlaceKind, Placemark } from "#protocol/types.ts";

// What the box keeps of where they've been, as rows: live points, visits (iOS's, and stays seeded from photos) and
// photo locations, each with the local day it happened on in its own time zone, so a day can be forgotten whole.

export type Sample = {
  readonly at: number;
  readonly source: "live" | "change";
  readonly latitude: number;
  readonly longitude: number;
  readonly accuracy: number;
  readonly speed?: number;
};

export type Visit = {
  readonly id: number;
  readonly arrivedAt?: number;
  readonly departedAt?: number;
  readonly day: string;
  readonly timeZone: string;
  readonly latitude: number;
  readonly longitude: number;
  readonly accuracy: number;
  readonly placemark?: Placemark;
  readonly place?: string;
  // A stay seeded from photos, with how many were taken there; never a visit iOS recorded.
  readonly seeded: boolean;
  readonly photos: number;
};

export type Photo = {
  readonly takenAt: number;
  readonly day: string;
  readonly timeZone: string;
  readonly latitude: number;
  readonly longitude: number;
  readonly placemark?: Placemark;
};

// A place as the box keeps it: what the API shows, and who set its name and kind. `not_a_place` is one they said
// isn't a place: it keeps its visits, so later ones there stay unnamed and unasked, but it's never shown.
export type KeptPlace = Place & {
  readonly named_by?: "you";
  readonly kind_by?: "you" | "home";
  readonly not_a_place?: true;
};

export type PlaceKindOf = PlaceKind;

// An object without some of its keys.
export const without = <Value extends object, Key extends keyof Value>(
  value: Value,
  ...keys: readonly Key[]
): Omit<Value, Key> =>
  Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key as Key))) as Omit<Value, Key>;

type VisitRow = {
  readonly id: number;
  readonly arrived_at: number | null;
  readonly departed_at: number | null;
  readonly day: string;
  readonly time_zone: string;
  readonly latitude: number;
  readonly longitude: number;
  readonly accuracy: number;
  readonly placemark: string | null;
  readonly place: string | null;
  readonly seeded: number;
  readonly photos: number;
};

type PhotoRow = {
  readonly taken_at: number;
  readonly day: string;
  readonly time_zone: string;
  readonly latitude: number;
  readonly longitude: number;
  readonly placemark: string | null;
};

const toVisit = (row: VisitRow): Visit => ({
  id: row.id,
  ...(row.arrived_at !== null && { arrivedAt: row.arrived_at }),
  ...(row.departed_at !== null && { departedAt: row.departed_at }),
  day: row.day,
  timeZone: row.time_zone,
  latitude: row.latitude,
  longitude: row.longitude,
  accuracy: row.accuracy,
  ...(row.placemark !== null && { placemark: JSON.parse(row.placemark) as Placemark }),
  ...(row.place !== null && { place: row.place }),
  seeded: row.seeded === 1,
  photos: row.photos,
});

const toPhoto = (row: PhotoRow): Photo => ({
  takenAt: row.taken_at,
  day: row.day,
  timeZone: row.time_zone,
  latitude: row.latitude,
  longitude: row.longitude,
  ...(row.placemark !== null && { placemark: JSON.parse(row.placemark) as Placemark }),
});

// The last local day a visit touches: the day it ended, or for one still open, any day to come.
const lastDay = "COALESCE(until_day, CASE WHEN departed_at IS NULL THEN '9999-12-31' ELSE day END)";

// Every day from one to another, both included; a long span is cut at a year, which no visit lasts.
const daysFrom = (from: string, to: string): readonly string[] => {
  const span = Math.min(
    366,
    Math.round((Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / 86_400_000),
  );
  return Array.from({ length: Math.max(0, span) + 1 }, (_, index) =>
    new Date(Date.parse(`${from}T00:00:00.000Z`) + index * 86_400_000).toISOString().slice(0, 10),
  );
};

const byDay = (left: string, right: string): number => left.localeCompare(right);

const visitColumns =
  "id, arrived_at, departed_at, day, time_zone, latitude, longitude, accuracy, placemark, place, seeded, photos";

export type Records = ReturnType<typeof createRecords>;

export const createRecords = (database: DatabaseSync) => {
  const all = (sql: string, ...values: readonly SQLInputValue[]): readonly unknown[] =>
    database.prepare(sql).all(...values);
  const one = (sql: string, ...values: readonly SQLInputValue[]): unknown => database.prepare(sql).get(...values);
  const run = (sql: string, ...values: readonly SQLInputValue[]): number =>
    Number(database.prepare(sql).run(...values).changes);

  const transaction = <Value>(work: () => Value): Value => {
    database.exec("BEGIN IMMEDIATE");
    try {
      const value = work();
      database.exec("COMMIT");
      return value;
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  };

  const visits = (sql: string, ...values: readonly SQLInputValue[]): readonly Visit[] =>
    (all(`SELECT ${visitColumns} FROM location_visits ${sql}`, ...values) as readonly VisitRow[]).map((row) =>
      toVisit(row),
    );

  return {
    transaction,
    batch: (id: string): string | undefined =>
      (one("SELECT result FROM location_batches WHERE id = ?", id) as { readonly result: string } | undefined)?.result,
    keepBatch: (id: string, at: string, result: string): void => {
      run("INSERT OR IGNORE INTO location_batches (id, at, result) VALUES (?, ?, ?)", id, at, result);
    },
    lastBatchAt: (): string | undefined =>
      (one("SELECT MAX(at) AS at FROM location_batches") as { readonly at: string | null } | undefined)?.at ??
      undefined,
    addSample: (sample: Sample & { readonly course?: number; readonly altitude?: number }, day: string, zone: string) =>
      run(
        `INSERT OR IGNORE INTO location_points
           (at, source, day, time_zone, latitude, longitude, accuracy, speed, course, altitude)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        sample.at,
        sample.source,
        day,
        zone,
        sample.latitude,
        sample.longitude,
        sample.accuracy,
        sample.speed ?? null,
        sample.course ?? null,
        sample.altitude ?? null,
      ) > 0,
    samplesBetween: (from: number, to: number): readonly Sample[] =>
      (
        all(
          `SELECT at, source, latitude, longitude, accuracy, speed FROM location_points
         WHERE at >= ? AND at < ? ORDER BY at`,
          from,
          to,
        ) as readonly (Omit<Sample, "speed"> & { readonly speed: number | null })[]
      ).map(({ speed, ...sample }) => ({
        ...sample,
        ...(speed !== null && { speed }),
      })),
    visitArrivedAt: (at: number): Visit | undefined => visits("WHERE arrived_at = ? AND seeded = 0", at).at(0),
    visitDepartedAt: (at: number): Visit | undefined => visits("WHERE departed_at = ? AND seeded = 0", at).at(0),
    // The live visits still open that began before a time, latest first.
    openVisitsBefore: (at: number): readonly Visit[] =>
      visits("WHERE departed_at IS NULL AND seeded = 0 AND arrived_at < ? ORDER BY arrived_at DESC", at),
    addVisit: (visit: Omit<Visit, "id">, untilDay?: string): number => {
      const result = database
        .prepare(
          `INSERT INTO location_visits
             (arrived_at, departed_at, day, until_day, time_zone, latitude, longitude, accuracy, placemark, place, seeded,
              photos)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          visit.arrivedAt ?? null,
          visit.departedAt ?? null,
          visit.day,
          untilDay ?? null,
          visit.timeZone,
          visit.latitude,
          visit.longitude,
          visit.accuracy,
          visit.placemark === undefined ? null : JSON.stringify(visit.placemark),
          visit.place ?? null,
          visit.seeded ? 1 : 0,
          visit.photos,
        );
      return Number(result.lastInsertRowid);
    },
    closeVisit: (id: number, departedAt: number, untilDay: string, placemark?: Placemark): void => {
      run(
        "UPDATE location_visits SET departed_at = ?, until_day = ?, placemark = COALESCE(placemark, ?) WHERE id = ?",
        departedAt,
        untilDay,
        placemark === undefined ? null : JSON.stringify(placemark),
        id,
      );
    },
    nameVisit: (id: number, placemark: Placemark): void => {
      run("UPDATE location_visits SET placemark = ? WHERE id = ?", JSON.stringify(placemark), id);
    },
    placeVisit: (id: number, place: string | undefined): void => {
      run("UPDATE location_visits SET place = ? WHERE id = ?", place ?? null, id);
    },
    visit: (id: number): Visit | undefined => visits("WHERE id = ?", id).at(0),
    visitsOf: (place: string): readonly Visit[] =>
      visits("WHERE place = ? ORDER BY COALESCE(arrived_at, departed_at)", place),
    visitsInDays: (from: string, to: string): readonly Visit[] =>
      visits("WHERE day >= ? AND day <= ? ORDER BY COALESCE(arrived_at, departed_at)", from, to),
    // The visits overlapping a span of time, oldest first; an open one lasts until `now`.
    visitsDuring: (from: number, to: number, now: number): readonly Visit[] =>
      visits(
        `WHERE COALESCE(arrived_at, departed_at) < ? AND COALESCE(departed_at, ?) > ?
         ORDER BY COALESCE(arrived_at, departed_at)`,
        to,
        now,
        from,
      ),
    seededVisitsOn: (day: string): readonly Visit[] => visits("WHERE seeded = 1 AND day = ?", day),
    removeSeededVisitsOn: (day: string): void => {
      run("DELETE FROM location_visits WHERE seeded = 1 AND day = ?", day);
    },
    addPhoto: (photo: Photo): boolean =>
      run(
        `INSERT OR IGNORE INTO location_photos (taken_at, day, time_zone, latitude, longitude, placemark)
         VALUES (?, ?, ?, ?, ?, ?)`,
        photo.takenAt,
        photo.day,
        photo.timeZone,
        photo.latitude,
        photo.longitude,
        photo.placemark === undefined ? null : JSON.stringify(photo.placemark),
      ) > 0,
    photosOn: (day: string): readonly Photo[] =>
      (
        all(
          "SELECT taken_at, day, time_zone, latitude, longitude, placemark FROM location_photos WHERE day = ? ORDER BY taken_at",
          day,
        ) as readonly PhotoRow[]
      ).map((row) => toPhoto(row)),
    // The time zone a day's data was collected in, if the box has any for it.
    zoneOf: (day: string): string | undefined =>
      (
        one(
          `SELECT time_zone FROM location_visits WHERE day = ?
         UNION ALL SELECT time_zone FROM location_points WHERE day = ?
         UNION ALL SELECT time_zone FROM location_photos WHERE day = ? LIMIT 1`,
          day,
          day,
          day,
        ) as { readonly time_zone: string } | undefined
      )?.time_zone,
    // Whether the phone recorded the day live: a visit there at any time of it, or a point.
    hasLive: (day: string): boolean =>
      one(
        `SELECT 1 FROM location_visits WHERE seeded = 0 AND day <= ? AND ${lastDay} >= ?
         UNION ALL SELECT 1 FROM location_points WHERE day = ? LIMIT 1`,
        day,
        day,
        day,
      ) !== undefined,
    // Every day the box has anything for, oldest first: a visit counts on every day it spans, an open one up to
    // `today`.
    days: (today: string): readonly string[] => {
      const spans = all(
        `SELECT day, MIN(${lastDay}, ?) AS until FROM location_visits
         UNION SELECT day, day FROM location_points UNION SELECT day, day FROM location_photos`,
        today,
      ) as readonly { readonly day: string; readonly until: string }[];
      return [...new Set(spans.flatMap(({ day, until }) => daysFrom(day, until)))].toSorted(byDay);
    },
    // The days with live visits, newest first, each a visit spans.
    liveDays: (limit: number, today: string): readonly string[] =>
      [
        ...new Set(
          (
            all(`SELECT day, MIN(${lastDay}, ?) AS until FROM location_visits WHERE seeded = 0`, today) as readonly {
              readonly day: string;
              readonly until: string;
            }[]
          ).flatMap(({ day, until }) => daysFrom(day, until)),
        ),
      ]
        .toSorted((left, right) => byDay(right, left))
        .slice(0, limit),
    counts: () => ({
      samples: (one("SELECT COUNT(*) AS n FROM location_points") as { readonly n: number } | undefined)?.n ?? 0,
      visits:
        (one("SELECT COUNT(*) AS n FROM location_visits WHERE seeded = 0") as { readonly n: number } | undefined)?.n ??
        0,
      photos: (one("SELECT COUNT(*) AS n FROM location_photos") as { readonly n: number } | undefined)?.n ?? 0,
    }),
    // The days the visits touching a range of days began and ended on, outside it too.
    daysAround: (from: string, to: string): readonly string[] =>
      (
        all(
          `SELECT day, COALESCE(until_day, day) AS until FROM location_visits
           WHERE day <= ? AND COALESCE(until_day, day) >= ?`,
          to,
          from,
        ) as readonly { readonly day: string; readonly until: string }[]
      ).flatMap(({ day, until }) => [day, until]),
    // A visit that touches the range at all goes whole: forgetting errs on the side of forgetting.
    forget: (from: string, to: string) => ({
      samples: run("DELETE FROM location_points WHERE day >= ? AND day <= ?", from, to),
      visits: run(
        "DELETE FROM location_visits WHERE day <= ? AND COALESCE(until_day, day) >= ? AND seeded = 0",
        to,
        from,
      ),
      photos: run("DELETE FROM location_photos WHERE day >= ? AND day <= ?", from, to),
      seeded: run("DELETE FROM location_visits WHERE day >= ? AND day <= ? AND seeded = 1", from, to),
    }),
    forgetEverything: () => {
      const forgotten = {
        samples: run("DELETE FROM location_points"),
        visits: run("DELETE FROM location_visits WHERE seeded = 0"),
        photos: run("DELETE FROM location_photos"),
        seeded: run("DELETE FROM location_visits"),
      };
      run("DELETE FROM location_heat");
      run("DELETE FROM location_days");
      run("DELETE FROM location_batches");
      return forgotten;
    },
    places: (): readonly KeptPlace[] =>
      (all("SELECT body FROM places") as readonly { readonly body: string }[]).map(
        ({ body }) => JSON.parse(body) as KeptPlace,
      ),
    savePlace: (place: KeptPlace): void => {
      run(
        "INSERT INTO places (id, body) VALUES (?, ?) ON CONFLICT (id) DO UPDATE SET body = excluded.body",
        place.id,
        JSON.stringify(place),
      );
    },
    removePlace: (id: string): void => {
      run("DELETE FROM places WHERE id = ?", id);
      run("UPDATE location_visits SET place = NULL WHERE place = ?", id);
    },
    keepDay: (day: string, body: string, cells: ReadonlyMap<string, number>): void => {
      run("DELETE FROM location_heat WHERE day = ?", day);
      run("DELETE FROM location_days WHERE day = ?", day);
      if (cells.size === 0) return;
      run("INSERT INTO location_days (day, body) VALUES (?, ?)", day, body);
      const insert = database.prepare("INSERT INTO location_heat (day, cell, seconds) VALUES (?, ?, ?)");
      for (const [cell, seconds] of cells) insert.run(day, cell, seconds);
    },
    dayBodies: (from: string, to: string): readonly { readonly day: string; readonly body: string }[] =>
      all("SELECT day, body FROM location_days WHERE day >= ? AND day <= ? ORDER BY day", from, to) as readonly {
        readonly day: string;
        readonly body: string;
      }[],
    heat: (from: string, to: string, precision: number) =>
      all(
        `SELECT SUBSTR(cell, 1, ?) AS cell, SUM(seconds) AS seconds FROM location_heat
         WHERE day >= ? AND day <= ? GROUP BY SUBSTR(cell, 1, ?) ORDER BY seconds DESC, cell`,
        precision,
        from,
        to,
        precision,
      ) as readonly { readonly cell: string; readonly seconds: number }[],
  };
};
