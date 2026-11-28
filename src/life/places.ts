import type { Location } from "#location/location.ts";
import type { DayThread, Place, Trip } from "#protocol/types.ts";

// The seam for location: Life's places, day threads and trips come from it.
export type LifePlaces = {
  // The places a search's words name, most hours first.
  readonly find: (words: readonly string[]) => readonly Place[];
  // A day's thread of places, for the week's rows; none for a day with no stops.
  readonly threadOf: (day: string) => DayThread | undefined;
  // The trips in a range, for the year's chapters.
  readonly trips: (from: string, to: string) => readonly Trip[];
  // Where a range's time went, in a few lines for Kumo's line: the places by hours, and the trips.
  readonly summary: (from: string, to: string) => readonly string[];
};

// Places Kumo's line names: the ones the most time went to.
const placesSummed = 8;

const nameOf = (place: Place): string => place.name ?? place.apple_name ?? `somewhere (${place.kind})`;

const tripLine = (trip: Trip): string =>
  `A trip, ${trip.from} to ${trip.to} (${String(trip.days)} days): ${[...trip.cities, ...trip.countries.map(({ name }) => name)].join(", ")}`;

export const placesFrom = (location: Pick<Location, "places" | "days">): LifePlaces => ({
  find: (words) =>
    words.length === 0
      ? []
      : location.places().filter((place) => {
          const names = [place.name, place.apple_name, place.street, place.locality].join(" ").toLowerCase();
          return words.some((word) => names.includes(word));
        }),
  threadOf: (day) => {
    const thread = location.days.thread(day);
    return thread.items.length > 0 ? thread : undefined;
  },
  trips: (from, to) => location.days.trips(from, to),
  summary: (from, to) => [
    ...location
      .places(from, to)
      .toSorted((left, right) => right.hours - left.hours)
      .slice(0, placesSummed)
      .map(
        (place) =>
          `${nameOf(place)} (${place.kind}): ${String(place.hours)} h over ${String(place.visits)} visit${place.visits === 1 ? "" : "s"}`,
      ),
    ...location.days.trips(from, to).map((trip) => tripLine(trip)),
  ],
});
