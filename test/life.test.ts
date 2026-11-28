import { describe, expect, it } from "vitest";
import { createCell } from "#cell.ts";
import type { DayNote } from "#dream/notes.ts";
import type { Complete } from "#engine/engine.ts";
import { createAboutYou } from "#life/about-you.ts";
import { createBusy, targetsOf } from "#life/busy.ts";
import { createDays } from "#life/days.ts";
import { createGoingOn } from "#life/going-on.ts";
import { createLines, type Lines } from "#life/lines.ts";
import type { LifePlaces } from "#life/places.ts";
import { createSearch, wordsOf } from "#life/search.ts";
import type { ChapterSummary } from "#memory/chapters.ts";
import type { Hit, PageBody, PageSummary, RecentChangeBody } from "#memory/memory.ts";
import type { Shelf } from "#memory/pages.ts";
import type { MotionDetail } from "#motion/motion.ts";
import type { DayThread, Made, Message, Motion, People, Place } from "#protocol/types.ts";
import { fail, ok } from "#result.ts";
import { openDatabase } from "#store/database.ts";
import { createVirtualClock } from "./support/virtual-clock.ts";

const ignore = (): void => undefined;

// Tuesday 24 November 2026, 16:30 in London.
const now = Date.parse("2026-11-24T16:30:00.000Z");
const timeZone = (): string => "Europe/London";

type Pages = Partial<Record<Shelf, readonly PageSummary[]>>;

const summary = (address: string, title: string, gist?: string, changedAt = "2026-11-20T10:00:00.000Z") => ({
  address,
  title,
  ...(gist !== undefined && { gist }),
  changed_at: changedAt,
});

const fakeMemory = ({
  pages = {},
  markdown = {},
  chapters = [],
  changes = {},
  hits = [],
}: {
  readonly pages?: Pages;
  readonly markdown?: Readonly<Record<string, string>>;
  readonly chapters?: readonly ChapterSummary[];
  readonly changes?: Readonly<Record<string, readonly RecentChangeBody[]>>;
  readonly hits?: readonly Hit[];
}) => ({
  sync: () => Promise.resolve(),
  pages: (shelf: Shelf) => pages[shelf] ?? [],
  page: (address: string) => {
    const text = markdown[address];
    return text === undefined
      ? fail({ code: "not_found" as const, detail: `There's no page at ${address}.` })
      : ok({ address, markdown: text } as unknown as PageBody);
  },
  chapters: () => chapters,
  changesOf: (address: string) => changes[address] ?? [],
  learnt: () => [
    {
      text: "Friends before family, in your circles",
      at: "2026-11-24T09:00:00.000Z",
      address: "memory:portrait",
      change: "c_1",
    },
  ],
  search: () => Promise.resolve(hits),
});

// Kumo's lines, answered by a list of canned answers in turn, counting the asks.
const cannedLines = (answers: readonly unknown[]) => {
  const left = createCell(answers);
  const prompts = createCell<readonly string[]>([]);
  const complete: Complete = (prompt) => {
    prompts.update((current) => [...current, prompt]);
    const [next, ...rest] = left.get();
    left.set(rest);
    return Promise.resolve(next === undefined ? fail("Nothing to answer.") : ok(next));
  };
  const lines = createLines({
    database: openDatabase(":memory:"),
    complete,
    quickChoice: () => Promise.resolve(undefined),
    clock: createVirtualClock(now),
    info: ignore,
  });
  return { lines, prompts: () => prompts.get() };
};

const noThread = undefined as DayThread | undefined;

const placesOf = (overrides: Partial<LifePlaces> = {}): LifePlaces => ({
  find: () => [],
  threadOf: (): DayThread | undefined => noThread,
  trips: () => [],
  summary: () => [],
  ...overrides,
});

const motion = (fields: Partial<Motion> & Pick<Motion, "id" | "kind" | "title">): Motion => ({
  summary: "",
  status: "active",
  pinned: false,
  salience: "normal",
  version: 1,
  started_at: "2026-10-05T09:00:00.000Z",
  changed_at: "2026-11-23T09:00:00.000Z",
  position: 1,
  ...fields,
});

describe("what Kumo is working on", () => {
  it("names what a tool call touches", () => {
    expect(targetsOf("change_motion", { id: "northwind" })).toEqual(["motion:northwind"]);
    expect(targetsOf("edit_page", { address: "memory:projects/spare-room" })).toEqual(["memory:projects/spare-room"]);
    expect(targetsOf("recall", { query: "Omar" })).toEqual([]);
  });

  it("lasts while the turn or the run that touched it runs", () => {
    const clock = createVirtualClock(now);
    const busy = createBusy(clock);
    busy.called("read_motion", { id: "northwind" }, undefined);
    expect(busy.isWorking("motion:northwind")).toBe(false);
    busy.turnStarted();
    busy.called("read_motion", { id: "northwind" }, undefined);
    busy.called("edit_page", { address: "memory:goals/spring-10k" }, "r_1");
    expect(busy.isWorking("motion:northwind")).toBe(true);
    expect(busy.isWorking("memory:goals/spring-10k")).toBe(true);
    busy.turnEnded();
    expect(busy.isWorking("motion:northwind")).toBe(false);
    busy.ended("r_1");
    expect(busy.isWorking("memory:goals/spring-10k")).toBe(false);
  });

  it("never outlives the backstop", () => {
    const clock = createVirtualClock(now);
    const busy = createBusy(clock);
    busy.called("change_motion", { id: "lisbon" }, "r_2");
    clock.moveTo(now + 31 * 60 * 1000);
    expect(busy.isWorking("motion:lisbon")).toBe(false);
  });
});

const request = (basis: string, lines: Lines) =>
  lines.write({
    key: "days:2026-11-18:2026-11-24",
    basis,
    prompt: "Write it.",
    schema: { type: "object" },
    toValue: (answer) => answer as { readonly line: string },
  });

describe("Kumo's lines in Life", () => {
  it("keeps a line until what it's written from changes", async () => {
    const { lines, prompts } = cannedLines([{ line: "Home, mostly." }, { line: "Home and the gym." }]);
    expect(await request("a", lines)).toEqual({ line: "Home, mostly." });
    expect(await request("a", lines)).toEqual({ line: "Home, mostly." });
    expect(prompts()).toHaveLength(1);
    expect(await request("b", lines)).toEqual({ line: "Home and the gym." });
  });

  it("gives none when the quick model can't write one, and asks again next time", async () => {
    const { lines, prompts } = cannedLines([]);
    expect(await request("a", lines)).toBeUndefined();
    expect(await request("a", lines)).toBeUndefined();
    expect(prompts()).toHaveLength(2);
  });

  it("goes without a line that takes too long, and keeps it for next time", async () => {
    const clock = createVirtualClock(now);
    const release = createCell<(() => void) | undefined>(undefined);
    const complete: Complete = () =>
      new Promise((resolve) => {
        release.set(() => {
          resolve(ok({ line: "Slow, but kept." }));
        });
      });
    const lines = createLines({
      database: openDatabase(":memory:"),
      complete,
      quickChoice: () => Promise.resolve(undefined),
      clock,
      info: ignore,
      waitMs: 1000,
    });
    const asked = request("a", lines);
    await Promise.resolve();
    clock.runNext(now + 1000);
    expect(await asked).toBeUndefined();
    release.get()?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(await request("a", lines)).toEqual({ line: "Slow, but kept." });
  });
});

describe("days of a range", () => {
  const journal = [
    summary("memory:journal/2026-11-23", "23 November 2026", "The office, the gym, an early night."),
    summary("memory:journal/2026-11-22", "22 November 2026", "A short run, then nothing at all."),
    summary("memory:journal/2026-10-30", "30 October 2026", "Lisbon talk at Leo's."),
  ];
  const autumn: ChapterSummary = {
    address: "memory:chapters/the-northwind-autumn",
    title: "The Northwind autumn",
    began: "2026-10-05",
    changed_at: "2026-11-20T10:00:00.000Z",
  };
  const winter: ChapterSummary = {
    address: "memory:chapters/winter-at-the-old-job",
    title: "Winter at the old job",
    began: "2026-01-04",
    ended: "2026-03-20",
    changed_at: "2026-03-21T10:00:00.000Z",
  };
  const notes: readonly DayNote[] = [
    { id: 1, at: "2026-11-24T08:58:00.000Z", day: "2026-11-24", text: "At the café before the final.", yours: false },
    { id: 2, at: "2026-11-24T13:10:00.000Z", day: "2026-11-24", text: "The final went well.", yours: true },
  ];

  const daysWith = (answers: readonly unknown[], places: LifePlaces = placesOf()) => {
    const canned = cannedLines(answers);
    const days = createDays({
      memory: fakeMemory({ pages: { journal }, chapters: [autumn, winter] }),
      dayNotes: { since: (day) => notes.filter((note) => note.day >= day) },
      places,
      lines: canned.lines,
      now: () => now,
      timeZone,
    });
    return { days, prompts: canned.prompts };
  };

  it("gives a week's days newest first, up to today, with Kumo's line and the chapter it's in", async () => {
    const thread = { day: "2026-11-24", items: [] };
    const { days, prompts } = daysWith(
      [{ line: "Home and the office, mostly. The gym four times.", weeks: [] }],
      placesOf({ threadOf: (day) => (day === "2026-11-24" ? thread : undefined) }),
    );
    const week = await days.range("2026-11-23", "2026-11-29");
    expect(week).toEqual(
      ok({
        from: "2026-11-23",
        to: "2026-11-29",
        line: "Home and the office, mostly. The gym four times.",
        days: [
          { day: "2026-11-24", notes: 2, thread },
          { day: "2026-11-23", gist: "The office, the gym, an early night.", journal: "memory:journal/2026-11-23" },
        ],
        chapters: [autumn],
        trips: [],
      }),
    );
    expect(prompts()[0]).toContain("Mon 23 Nov: The office, the gym, an early night.");
  });

  it("gives a month its weeks, each with Kumo's line", async () => {
    const { days } = daysWith([
      {
        line: "Home, the office, the gym most mornings.",
        weeks: [
          { from: "2026-11-23", line: "The final, and a lot of the office." },
          { from: "2026-11-16", line: "Up the hill with Mira." },
        ],
      },
    ]);
    const month = await days.range("2026-11-01", "2026-11-30");
    expect(month.ok && month.value.weeks).toEqual([
      { from: "2026-11-23", to: "2026-11-24", line: "The final, and a lot of the office." },
      { from: "2026-11-16", to: "2026-11-22", line: "Up the hill with Mira." },
      { from: "2026-11-09", to: "2026-11-15" },
      { from: "2026-11-02", to: "2026-11-08" },
      { from: "2026-11-01", to: "2026-11-01" },
    ]);
    expect(month.ok && month.value.days).toHaveLength(24);
  });

  it("gives a year its chapters as spans, earliest first, and its trips", async () => {
    const trip = {
      id: "2026-05-02",
      from: "2026-05-02",
      to: "2026-05-09",
      days: 8,
      countries: [{ name: "Portugal", code: "PT" }],
      cities: ["Lisbon"],
      latitude: 38.72,
      longitude: -9.14,
      kilometres: 1950,
    };
    const { days, prompts } = daysWith(
      [{ line: "Three countries. Lisbon was the longest.", weeks: [] }],
      placesOf({ trips: () => [trip], summary: () => ["A trip to Lisbon"] }),
    );
    const year = await days.range("2026-01-01", "2026-12-31");
    expect(year.ok && year.value.chapters.map(({ title }) => title)).toEqual([
      "Winter at the old job",
      "The Northwind autumn",
    ]);
    expect(year.ok && year.value.trips).toEqual([trip]);
    expect(year.ok && year.value.weeks).toBeUndefined();
    expect(prompts()[0]).not.toContain("Their journal");
    expect(prompts()[0]).toContain("A trip to Lisbon");
  });

  it("writes no line from nothing, and refuses a range it can't read", async () => {
    const { days, prompts } = daysWith([]);
    const empty = await days.range("2025-02-03", "2025-02-09");
    expect(empty.ok && empty.value.line).toBeUndefined();
    expect(prompts()).toHaveLength(0);
    expect(await days.range("2026-11-30", "2026-11-01")).toEqual(fail("from comes before to."));
    expect(await days.range("2025-01-01", "2026-12-31")).toEqual(fail("A range is at most 366 days."));
    expect(await days.range("24 Nov", "2026-11-30")).toEqual(fail("Give from and to as YYYY-MM-DD."));
  });
});

describe("Going on", () => {
  const northwind = motion({
    id: "northwind",
    kind: "career",
    title: "Northwind",
    summary: "Final today",
    salience: "loud",
  });
  const lisbon = motion({
    id: "lisbon-in-march",
    kind: "trip",
    title: "Lisbon in March",
    summary: "Flights held till Sun",
  });
  const spareRoom = motion({ id: "spare-room", kind: "project", title: "The spare room", summary: "2 of 5 done" });
  const oldRole = motion({ id: "kestrel", kind: "career", title: "Kestrel", status: "done" });
  const details: Readonly<Record<string, MotionDetail>> = {
    northwind: {
      motion: northwind,
      content: { next: { text: "Hear back from Clara", at: "2026-11-27T12:00" } },
      state: {},
      changes: [
        { version: 2, at: "2026-11-24T15:00:00.000Z", note: "Final round done", position: 9 },
        { version: 1, at: "2026-10-05T09:00:00.000Z", note: "Applied", position: 1 },
      ],
    },
    "lisbon-in-march": {
      motion: lisbon,
      content: { dates: { start: "2027-03-12", end: "2027-03-15" } },
      state: {},
      changes: [],
    },
    "spare-room": {
      motion: spareRoom,
      content: {
        aim: "A study",
        parts: [
          { id: "shelves", title: "Shelves", status: "done" },
          { id: "desk", title: "The desk", status: "planned" },
          { id: "rug", title: "A rug", status: "dropped" },
        ],
      },
      state: {},
      changes: [],
    },
  };
  const pages: Pages = {
    projects: [
      summary("memory:projects/lisbon", "Lisbon in March", "Leo's in, Omar's a maybe."),
      summary("memory:projects/kestrel-move", "Kestrel move", undefined, "2026-11-01T10:00:00.000Z"),
      summary("memory:projects/old-shed", "The old shed", undefined, "2026-05-01T10:00:00.000Z"),
    ],
    goals: [summary("memory:goals/spring-10k", "Spring 10k", "Three runs a week.")],
  };
  const markdown = {
    "memory:projects/lisbon": "Flights for four.",
    "memory:projects/kestrel-move": "Linked to motion:kestrel.",
    "memory:projects/old-shed": "Done in May.",
    "memory:goals/spring-10k": "Week 4 of 10.",
  };
  const changes = {
    "memory:goals/spring-10k": [
      {
        change: "c_2",
        address: "memory:goals/spring-10k",
        title: "Spring 10k",
        at: "2026-11-21T08:00:00.000Z",
        note: "Week 4",
      },
      { change: "c_1", address: "memory:goals/spring-10k", title: "Spring 10k", at: "2026-10-12T08:00:00.000Z" },
    ],
  };

  it("joins things in motion with pages, groups them, and shows what Kumo is on", async () => {
    const busy = createBusy(createVirtualClock(now));
    busy.turnStarted();
    busy.called("change_motion", { id: "northwind" }, undefined);
    const goingOn = createGoingOn({
      memory: fakeMemory({ pages, markdown, changes }),
      motions: {
        list: () => [lisbon, spareRoom, northwind, oldRole],
        detail: (id) => {
          const detail = details[id];
          return Promise.resolve(detail ? ok(detail) : fail({ code: "not_found" as const, detail: id }));
        },
      },
      busy,
      now: () => now,
      timeZone,
    });
    const threads = await goingOn.threads();
    expect(threads.map(({ id, group }) => [id, group])).toEqual([
      ["motion:northwind", "matters"],
      ["motion:lisbon-in-march", "projects"],
      ["motion:spare-room", "projects"],
      ["memory:goals/spring-10k", "goals"],
    ]);
    expect(threads[0]).toEqual({
      id: "motion:northwind",
      group: "matters",
      title: "Northwind",
      status: "Final today",
      began: "2026-10-05",
      marks: [
        { at: "2026-10-05T09:00:00.000Z", note: "Applied" },
        { at: "2026-11-24T15:00:00.000Z", note: "Final round done" },
      ],
      next: { text: "Hear back from Clara", at: "2026-11-27T12:00" },
      working: true,
      motion: "northwind",
      kind: "career",
      salience: "loud",
    });
    expect(threads[2]).toMatchObject({
      steps: [
        { title: "Shelves", status: "done" },
        { title: "The desk", status: "planned" },
      ],
      working: false,
    });
    expect(threads[1]).toMatchObject({
      line: "Leo's in, Omar's a maybe.",
      ends: "2027-03-15",
      page: "memory:projects/lisbon",
    });
    expect(threads[3]).toEqual({
      id: "memory:goals/spring-10k",
      group: "goals",
      title: "Spring 10k",
      line: "Three runs a week.",
      began: "2026-10-12",
      marks: [{ at: "2026-10-12T08:00:00.000Z" }, { at: "2026-11-21T08:00:00.000Z", note: "Week 4" }],
      working: false,
      page: "memory:goals/spring-10k",
    });
  });
});

describe("search", () => {
  const omar = {
    id: "omar",
    name: "Omar",
    circle: "Friends",
    coming_up: [],
    last_seen: { day: "2026-11-20", kind: "journal" as const },
  };
  const people: People = { circles: [{ name: "Friends", people: [omar] }], count: 1, linked: 0 };
  const orrins: Place = {
    id: "p_orrins",
    name: "Orrin's",
    kind: "restaurant",
    latitude: 55.96,
    longitude: -3.21,
    radius: 30,
    hours: 4.5,
    visits: 2,
    first_visit: "2026-10-03T18:40:00.000Z",
    last_visit: "2026-11-20T19:40:00.000Z",
  };
  const guide: Made = {
    id: "dinner-ideas",
    title: "Dinner ideas for Omar's visit",
    summary: "5 places · 2 booked",
    version: 1,
    made_at: "2026-11-10T10:00:00.000Z",
    changed_at: "2026-11-10T10:00:00.000Z",
    position: 4,
  };
  const message: Message = {
    id: "m_0040",
    role: "user",
    text: "Dinner with Omar on Friday was lovely",
    at: "2026-11-21T09:00:00.000Z",
    position: 40,
  };
  const hits: readonly Hit[] = [
    {
      address: "memory:journal/2026-11-20",
      title: "20 November 2026",
      text: "20 November 2026: Orrin's with Omar, and the fig thing.",
      at: "2026-11-21T04:00:00.000Z",
    },
    {
      address: "memory:people/omar",
      title: "Omar",
      text: "Omar: a friend from five-a-side.",
      at: "2026-11-01T10:00:00.000Z",
    },
    {
      address: "conversation:past",
      title: "Past conversations",
      message: "m_0040",
      text: "You said: Dinner with Omar on Friday was lovely",
      at: "2026-11-21T09:00:00.000Z",
    },
  ];

  const searchWith = (answers: readonly unknown[]) => {
    const canned = cannedLines(answers);
    const search = createSearch({
      memory: fakeMemory({
        hits,
        pages: {
          journal: [summary("memory:journal/2026-11-20", "20 November 2026", "Orrin's with Omar, and the fig thing.")],
        },
      }),
      dayNotes: {
        since: () => [
          {
            id: 3,
            at: "2026-11-24T08:00:00.000Z",
            day: "2026-11-24",
            text: "Booked dinner for Saturday.",
            yours: false,
          },
        ],
      },
      places: placesOf({ find: (words) => (words.includes("orrin") ? [orrins] : []) }),
      people: { list: () => Promise.resolve(people) },
      goingOn: { threads: () => Promise.resolve([]) },
      made: { list: () => [guide] },
      store: { findMessage: (id) => (id === message.id ? message : undefined) },
      lines: canned.lines,
      now: () => now,
      timeZone,
    });
    return { search, prompts: canned.prompts };
  };

  it("keeps the words worth finding by", () => {
    expect(wordsOf("Dinner with Omar, last Friday")).toEqual(["dinner", "omar", "friday"]);
  });

  it("answers first, then groups what it found", async () => {
    const { search, prompts } = searchWith([{ answer: "Orrin's, last Friday. You wrote about the fig thing." }]);
    const found = await search.find("  dinner with Omar ");
    expect(found).toEqual(
      ok({
        query: "dinner with Omar",
        answer: "Orrin's, last Friday. You wrote about the fig thing.",
        days: [
          {
            day: "2026-11-20",
            gist: "Orrin's with Omar, and the fig thing.",
            journal: "memory:journal/2026-11-20",
            excerpt: "Orrin's with Omar, and the fig thing.",
          },
          { day: "2026-11-24", excerpt: "Booked dinner for Saturday." },
        ],
        places: [],
        people: [omar],
        going_on: [],
        made: [guide],
        messages: [
          {
            message: "m_0040",
            position: 40,
            at: "2026-11-21T09:00:00.000Z",
            yours: true,
            excerpt: "Dinner with Omar on Friday was lovely",
          },
        ],
      }),
    );
    expect(prompts()[0]).toContain("Today is Tuesday, 24 November 2026.");
    expect(prompts()[0]).toContain(
      "- 20 November 2026: Orrin's with Omar, and the fig thing.\n- 24 November 2026: Booked",
    );
  });

  it("finds places by name, and still finds when Kumo can't answer", async () => {
    const { search } = searchWith([]);
    const found = await search.find("Orrin's");
    expect(found.ok && found.value.places).toEqual([orrins]);
    expect(found.ok && found.value.answer).toBeUndefined();
  });

  it("refuses an empty search", async () => {
    const { search } = searchWith([]);
    expect(await search.find(" ".repeat(3))).toEqual(fail("Give something to search for."));
  });
});

const read = (answers: readonly unknown[]) => {
  const canned = cannedLines(answers);
  const aboutYou = createAboutYou({
    memory: fakeMemory({
      pages: { topics: [summary("memory:topics/food", "Food", "Figs, spicy but not hot.")] },
      markdown: {
        "memory:portrait": "You plan in bursts.",
        "memory:helping-you": "Short and straight.",
        "memory:topics/food": "You love figs.",
      },
    }),
    tracks: { list: () => [] },
    questions: { open: () => [] },
    lines: canned.lines,
  });
  return { aboutYou, prompts: canned.prompts };
};

describe("what Kumo knows about you", () => {
  it("gives the short Portrait, How to help you and tastes with the pages they come from", async () => {
    const { aboutYou } = read([
      {
        portrait: "You plan in bursts, then want it all to just happen.",
        helping: ["Short and straight.", "Drafts only. You press send."],
        tastes: [
          { taste: "Figs", page: "memory:topics/food" },
          { taste: "Window seats", page: "memory:topics/travel" },
        ],
      },
    ]);
    expect(await aboutYou.read()).toEqual({
      portrait: { text: "You plan in bursts, then want it all to just happen.", address: "memory:portrait" },
      helping: { lines: ["Short and straight.", "Drafts only. You press send."], address: "memory:helping-you" },
      tastes: [{ text: "Figs", address: "memory:topics/food" }],
      learnt: [
        {
          text: "Friends before family, in your circles",
          at: "2026-11-24T09:00:00.000Z",
          address: "memory:portrait",
          change: "c_1",
        },
      ],
      tracks: [],
      to_ask: 0,
    });
  });

  it("leaves out what Kumo couldn't write", async () => {
    const { aboutYou } = read([]);
    const known = await aboutYou.read();
    expect(known.portrait).toBeUndefined();
    expect(known.helping).toBeUndefined();
    expect(known.tastes).toEqual([]);
  });
});
