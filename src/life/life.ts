import type { DatabaseSync } from "node:sqlite";
import type { Calendar } from "#calendar/calendar.ts";
import type { Clock } from "#clock.ts";
import type { DayNotes } from "#dream/notes.ts";
import type { Complete } from "#engine/engine.ts";
import type { QuickChoice } from "#engine/quick-model.ts";
import { createAboutYou, type AboutYouReader } from "#life/about-you.ts";
import type { Busy } from "#life/busy.ts";
import { createDays, type Days, type LifeLocation } from "#life/days.ts";
import { createGoingOn, type GoingOn } from "#life/going-on.ts";
import { createLines } from "#life/lines.ts";
import { createPlacePages, type PlacePages } from "#life/place.ts";
import { createSearch, type Search } from "#life/search.ts";
import type { MadePages } from "#made/made.ts";
import type { Location } from "#location/location.ts";
import type { Memory } from "#memory/memory.ts";
import type { Motions } from "#motion/motion.ts";
import type { PeopleKeeper } from "#people/people.ts";
import type { Store } from "#store/store.ts";
import type { Info } from "#turns/turns.ts";
import type { Questions } from "#work/questions.ts";
import type { Tracks } from "#work/tracks.ts";

// Life, the app's third tab, as the server answers it: the search on top, Days for the Week, Month and Year sheets,
// Going on, and what Kumo knows about them behind Kumo on the Desk. Places and People have their own APIs; a place's
// page is read here, with who he went with and Kumo's line.
export type Life = {
  readonly search: Search["find"];
  readonly days: Days["range"];
  readonly place: PlacePages["read"];
  readonly goingOn: GoingOn["threads"];
  readonly aboutYou: AboutYouReader["read"];
};

export type LifeOptions = {
  readonly database: DatabaseSync;
  readonly memory: Pick<Memory, "sync" | "search" | "pages" | "page" | "chapters" | "changesOf" | "learnt">;
  readonly motions: Pick<Motions, "list" | "detail">;
  readonly made: Pick<MadePages, "list">;
  readonly people: Pick<PeopleKeeper, "list" | "known">;
  readonly dayNotes: Pick<DayNotes, "since">;
  readonly store: Pick<Store, "findMessage">;
  readonly tracks: Pick<Tracks, "list">;
  readonly questions: Pick<Questions, "open">;
  readonly location: LifeLocation & Pick<Location, "place">;
  readonly calendar: Pick<Calendar, "listItems" | "attendeesOf">;
  readonly busy: Pick<Busy, "isWorking">;
  readonly complete: Complete;
  readonly quickChoice: QuickChoice;
  readonly clock: Clock;
  readonly timeZone: () => string;
  readonly info: Info;
};

export const createLife = (options: LifeOptions): Life => {
  const { database, memory, motions, made, people, dayNotes, store, tracks, questions, location, calendar, busy } =
    options;
  const { complete, quickChoice, clock, timeZone, info } = options;
  const now = (): number => clock.now();
  const lines = createLines({ database, complete, quickChoice, clock, info });
  const goingOn = createGoingOn({ memory, motions, busy, now, timeZone });
  const search = createSearch({ memory, dayNotes, location, people, goingOn, made, store, lines, now, timeZone });
  const days = createDays({ memory, dayNotes, location, lines, now, timeZone });
  const aboutYou = createAboutYou({ memory, tracks, questions, lines });
  const places = createPlacePages({ location, memory, dayNotes, calendar, people, lines, now, timeZone });
  return {
    search: search.find,
    days: days.range,
    place: places.read,
    goingOn: goingOn.threads,
    aboutYou: aboutYou.read,
  };
};
