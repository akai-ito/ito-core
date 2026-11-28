import type { Clock } from "#clock.ts";
import type { Location } from "#location/location.ts";
import { toDay } from "#memory/pages.ts";
import { mentionOf, type Evidence } from "#people/evidence.ts";
import type { PersonReference } from "#people/people.ts";
import type { Place, SharedPlace } from "#protocol/types.ts";

// People's view of places: a place named after someone, such as Leo's or Five-a-side with Omar, is a place they
// share, and each visit there is evidence of time together. Location only knows where he was, never where anyone
// else is, so this is the whole of it.
export type PeoplePlaces = {
  readonly visits: (person: PersonReference) => readonly Evidence[];
  // Undefined when no place is named after them, so People falls back on the place pages in memory.
  readonly places: (person: PersonReference) => readonly SharedPlace[] | undefined;
};

const yearMs = 366 * 24 * 60 * 60 * 1000;

export const createPeoplePlaces = (
  location: Pick<Location, "all" | "placeVisits">,
  clock: Clock,
  timeZone: () => string,
): PeoplePlaces => {
  const theirs = (names: readonly string[]): readonly Place[] => {
    const mentions = mentionOf(names);
    return location.all().filter(({ name }) => name !== undefined && mentions(name));
  };

  return {
    visits: ({ names }) => {
      const ids = new Set(theirs(names).map(({ id }) => id));
      if (ids.size === 0) return [];
      const now = clock.now();
      return location.placeVisits(now - yearMs, now).flatMap((visit): readonly Evidence[] => {
        const at = visit.arrived_at ?? visit.departed_at;
        return at === undefined || !ids.has(visit.place.id)
          ? []
          : [
              {
                day: toDay(Date.parse(at), timeZone()),
                kind: "place",
                ...(visit.arrived_at !== undefined && { at: visit.arrived_at }),
                ...(visit.place.name !== undefined && { what: visit.place.name }),
                hours: Math.round((visit.minutes / 60) * 10) / 10,
              },
            ];
      });
    },
    places: ({ names }) => {
      const shared = theirs(names);
      return shared.length === 0 ? undefined : shared.map(({ id, name = id }) => ({ place: id, title: name }));
    },
  };
};
