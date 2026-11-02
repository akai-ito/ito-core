import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setImmediate as yieldToIo } from "node:timers/promises";
import { afterAll, describe, expect, it } from "vitest";
import { createCell } from "#cell.ts";
import { systemClock, toTimestamp } from "#clock.ts";
import type { Calendar } from "#calendar/calendar.ts";
import type { NewCalendarEvent } from "#calendar/icalendar.ts";
import { createBlockStore } from "#day/blocks.ts";
import { createCheckins } from "#day/checkins.ts";
import { createNights } from "#day/nights.ts";
import { createDayPicture, guessMark } from "#day/picture.ts";
import { createQuestions } from "#day/questions.ts";
import { createStatus } from "#day/status.ts";
import { atLocal, spokenTime } from "#day/time.ts";
import type { Line } from "#desk/moments.ts";
import { demoAnswers, demoScripts, demoWork } from "#engine/scripted/demo.ts";
import { createScriptEngine } from "#engine/scripted/script-engine.ts";
import { hashToken, tokenSetting } from "#http/auth.ts";
import { randomIdentifiers } from "#identifiers.ts";
import { wordEmbedder } from "#memory/embedder.ts";
import type { CalendarItem, Desk, Moment } from "#protocol/types.ts";
import { fail, ok, type Result } from "#result.ts";
import { createServer } from "#server.ts";
import { openDatabase } from "#store/database.ts";
import { createStore, type Listener } from "#store/store.ts";
import { createVirtualClock } from "./support/virtual-clock.ts";

const home = mkdtempSync(path.join(os.tmpdir(), "ito-day-"));

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

const storeAt = (name: string) =>
  createStore(openDatabase(path.join(home, `${name}.db`)), systemClock, randomIdentifiers);

const kumo = { name: "Kumo", kumo: true };

// Kumo's calendar in memory: what the day picture writes, as a calendar would hold it.
const memoryCalendar = (theirs: readonly CalendarItem[] = []) => {
  const items = createCell<readonly CalendarItem[]>(theirs);
  const listeners = createCell<readonly (() => void)[]>([]);
  const refreshed = (): void => {
    for (const listener of listeners.get()) listener();
  };
  const calendar: Pick<Calendar, "addEvent" | "changeEvent" | "isConnected" | "listItems" | "onRefreshed"> = {
    addEvent: (event: NewCalendarEvent) => {
      const item: CalendarItem = {
        id: `v_${randomUUID().slice(0, 8)}`,
        uid: event.uid ?? randomUUID(),
        title: event.title,
        start: event.start,
        end: event.end,
        all_day: false,
        calendar: kumo,
        status: "confirmed",
      };
      items.update((current) => [...current, item]);
      refreshed();
      return Promise.resolve(ok(item));
    },
    changeEvent: (uid, changes) => {
      const found = items.get().find((item) => item.uid === uid);
      if (!found) return Promise.resolve(fail("There's no such event in the next week."));
      const changed = { ...found, ...(changes.title !== undefined && { title: changes.title }) };
      items.update((current) => current.map((item) => (item.uid === uid ? changed : item)));
      refreshed();
      return Promise.resolve(ok(changed));
    },
    isConnected: () => true,
    listItems: () => items.get(),
    onRefreshed: (listener) => {
      listeners.update((current) => [...current, listener]);
    },
  };
  const remove = (uid: string): void => {
    items.update((current) => current.filter((item) => item.uid !== uid));
    refreshed();
  };
  return { calendar, items, remove };
};

const ignore = (): void => undefined;

const sunday = Date.parse("2026-11-15T08:00:00.000Z");

const unsubscribed = (): (() => void) => ignore;

const noMotions = { list: () => [], detail: () => Promise.resolve(fail({ code: "not_found" as const, detail: "" })) };

const pictureWith = (name: string, theirs: readonly CalendarItem[] = []) => {
  const store = storeAt(name);
  const clock = createVirtualClock(sunday);
  const memory = memoryCalendar(theirs);
  const work = createCell<readonly string[]>([]);
  const database = openDatabase(path.join(home, `${name}.db`));
  const picture = createDayPicture({
    blocks: createBlockStore(database),
    calendar: memory.calendar,
    motions: noMotions,
    nights: createNights(store, "UTC"),
    settings: store,
    clock,
    timeZone: "UTC",
    work: (prompt) => {
      work.update((current) => [...current, prompt]);
      return Promise.resolve(ok("A free Sunday, with a quiet plan under it."));
    },
    info: ignore,
    lead: () => "Kumo",
    morning: () => "07:30",
  });
  const tool = (name: string) => {
    const found = picture.tools.find((candidate) => candidate.name === name);
    if (!found) throw new Error(`no tool ${name}`);
    return found;
  };
  return { store, clock, memory, picture, tool, work };
};

const working = {
  kind: "guess",
  title: "Working",
  start: "2026-11-15T09:00:00.000Z",
  end: "2026-11-15T12:00:00.000Z",
  activity: "working",
  why: "Your usual weekday at the desk.",
};

describe("time on the clock", () => {
  it("says late-night times as you would, and finds local instants across a change of offset", () => {
    expect(["01:00", "00:30", "23:15", "12:00"].map((time) => spokenTime(time))).toEqual(["1", "12:30", "11:15", "12"]);
    expect(toTimestamp(atLocal("2026-10-25", 90, "Europe/London"))).toBe("2026-10-25T01:30:00.000Z");
    expect(toTimestamp(atLocal("2026-07-01", 60, "Europe/London"))).toBe("2026-07-01T00:00:00.000Z");
  });
});

describe("nights", () => {
  it("names a night by its evening, places a stop after midnight, and marks late signs", () => {
    const nights = createNights(storeAt("nights"), "UTC");
    expect(nights.nightOf(Date.parse("2026-11-12T01:30:00.000Z"))).toBe("2026-11-11");
    expect(nights.nightOf(Date.parse("2026-11-11T20:00:00.000Z"))).toBe("2026-11-11");
    expect(toTimestamp(nights.stopAt("2026-11-11", "01:00"))).toBe("2026-11-12T01:00:00.000Z");
    expect(toTimestamp(nights.stopAt("2026-11-11", "23:30"))).toBe("2026-11-11T23:30:00.000Z");
    nights.change("2026-11-11", (night) => ({ ...night, stop: "01:00" }));
    nights.touch(Date.parse("2026-11-11T18:00:00.000Z"));
    nights.touch(Date.parse("2026-11-12T02:10:00.000Z"));
    nights.touch(Date.parse("2026-11-12T01:00:00.000Z"));
    expect(nights.get("2026-11-11")?.lastActive).toBe("2026-11-12T02:10:00.000Z");
    expect(nights.lately(Date.parse("2026-11-12T09:00:00.000Z"))).toEqual([
      "Wed: up until 02:10, against the 1 they set",
    ]);
  });
});

describe("what Kumo knows you're doing", () => {
  it("hears your Focus, latest first, until it's off or stale, and what you say until it's not true", async () => {
    const clock = createVirtualClock(Date.parse("2026-11-11T20:00:00.000Z"));
    const store = storeAt("status");
    const nights = createNights(store, "UTC");
    const status = createStatus({ settings: store, clock, timeZone: "UTC", nights, info: ignore });
    status.setFocus("phone", "work");
    expect(status.lines()).toEqual(["Now: their Work Focus has been on since 20:00, last heard 1 minute ago."]);
    expect(status.likely()).toBe("their Work Focus is on this evening");
    clock.moveTo(Date.parse("2026-11-11T20:30:00.000Z"));
    const noted = await status.tool.call({ text: "Building tonight, the sync screen" });
    expect(noted.text).toBe("Noted until 00:30.");
    expect(status.likely()).toBe("they told you: Building tonight, the sync screen");
    status.setFocus("phone", undefined);
    expect(status.lines()).toEqual(["They told you at 20:30: Building tonight, the sync screen"]);

    nights.change("2026-11-11", (night) => ({ ...night, stop: "01:00" }));
    clock.moveTo(Date.parse("2026-11-12T01:20:00.000Z"));
    status.setFocus("phone", "sleep");
    expect(status.isAsleep()).toBe(true);
    expect(status.lines()).toEqual(["Now: their Sleep Focus has been on since 01:20, last heard 1 minute ago."]);
    expect(nights.get("2026-11-11")).toMatchObject({
      stoppedAt: "2026-11-12T01:20:00.000Z",
      lastActive: "2026-11-12T01:20:00.000Z",
    });
    clock.moveTo(Date.parse("2026-11-12T17:30:00.000Z"));
    expect(status.isAsleep()).toBe(false);
  });

  it("takes the same Focus said again as nothing new, and says how long ago it last heard", () => {
    const clock = createVirtualClock(Date.parse("2026-11-11T23:10:00.000Z"));
    const store = storeAt("status-again");
    const nights = createNights(store, "UTC");
    const status = createStatus({ settings: store, clock, timeZone: "UTC", nights, info: ignore });
    status.setFocus("phone", "sleep");
    clock.moveTo(Date.parse("2026-11-12T03:00:00.000Z"));
    expect(status.lines()).toEqual(["Now: their Sleep Focus has been on since 23:10, last heard 4 hours ago."]);

    // The app says its Focus again whenever it reconnects: it isn't a sign of them, and the Focus began earlier.
    status.setFocus("phone", "sleep");
    status.setFocus("tablet", undefined);
    expect(status.lines()).toEqual(["Now: their Sleep Focus has been on since 23:10, last heard 1 minute ago."]);
    expect(nights.lastActive()).toBe(Date.parse("2026-11-11T23:10:00.000Z"));
    expect(nights.get("2026-11-11")?.lastActive).toBe("2026-11-11T23:10:00.000Z");
  });

  it("lets a Sleep Focus count only until the morning, and for 12 hours at most, and logs each change", () => {
    const clock = createVirtualClock(Date.parse("2026-11-11T23:10:00.000Z"));
    const store = storeAt("status-morning");
    const logged = createCell<readonly unknown[]>([]);
    const status = createStatus({
      settings: store,
      clock,
      timeZone: "UTC",
      nights: createNights(store, "UTC"),
      info: (message, details) => {
        logged.update((current) => [...current, { message, ...details }]);
      },
    });
    status.setFocus("phone", "sleep");
    clock.moveTo(Date.parse("2026-11-12T07:29:00.000Z"));
    expect(status.isAsleep()).toBe(true);
    expect(status.held("phone")).toEqual({
      focus: "sleep",
      since: "2026-11-11T23:10:00.000Z",
      heard: "2026-11-11T23:10:00.000Z",
      until: "2026-11-12T07:30:00.000Z",
    });
    clock.moveTo(Date.parse("2026-11-12T07:30:00.000Z"));
    expect(status.isAsleep()).toBe(false);
    expect(status.lines()).toEqual([]);
    expect(status.held("phone")).toEqual({});

    // Said again once it's stopped counting, it counts afresh.
    status.setFocus("phone", "sleep");
    clock.moveTo(Date.parse("2026-11-12T19:29:00.000Z"));
    expect(status.isAsleep()).toBe(true);
    clock.moveTo(Date.parse("2026-11-12T19:30:00.000Z"));
    expect(status.isAsleep()).toBe(false);

    status.setFocus("phone", "work");
    status.setFocus("phone", "work");
    clock.moveTo(Date.parse("2026-11-13T11:29:00.000Z"));
    expect(status.held("phone").focus).toBe("work");
    status.setFocus("phone", undefined);
    expect(logged.get()).toEqual([
      { message: "A Focus changed", device: "phone", focus: "sleep" },
      { message: "A Focus changed", device: "phone", focus: "sleep" },
      { message: "A Focus changed", device: "phone", focus: "work" },
      { message: "A Focus changed", device: "phone", focus: "off", was: "work" },
    ]);
  });
});

describe("the day's question", () => {
  it("waits for a calm moment, goes out once a day, and is never asked again once skipped", () => {
    const clock = createVirtualClock(Date.parse("2026-11-11T15:00:00.000Z"));
    const questions = createQuestions(storeAt("questions"), clock, "UTC");
    const climbing = { text: "Guard Thursday climbing?", options: ["Guard it", "Fine to move"], about: "climbing" };
    expect(questions.propose({ ...climbing, options: ["Yes"] })).toMatch(/two or three/u);
    const first = questions.propose(climbing);
    if (typeof first === "string") throw new TypeError(first);
    expect(questions.propose(climbing)).toMatch(/already waiting/u);
    questions.propose({ text: "Runs before work, still?", options: ["Yes", "Evenings now"], about: "run time" });
    expect(questions.next()?.id).toBe(first.id);
    questions.mark(first.id, { askedAt: toTimestamp(clock.now()), outcome: "skipped" });
    expect(questions.next()).toBeUndefined();
    expect(questions.propose(climbing)).toMatch(/skipped/u);
    clock.moveTo(Date.parse("2026-11-12T15:00:00.000Z"));
    expect(questions.next()?.about).toBe("run time");
  });
});

describe("Kumo's picture of the day", () => {
  it("puts plans and guesses on Kumo's calendar, marks guesses, and keeps them clear of yours", async () => {
    const dentist: CalendarItem = {
      id: "v_dentist",
      uid: "dentist@icloud",
      title: "Quillfield Dental",
      start: "2026-11-15T13:00:00.000Z",
      end: "2026-11-15T13:30:00.000Z",
      all_day: false,
      calendar: { name: "Home", kumo: false },
    };
    const { picture, tool, memory } = pictureWith("picture", [dentist]);
    const guessed = await tool("plan_block").call(working);
    const unexplained = await tool("plan_block").call({ ...working, why: "", start: "2026-11-15T14:00:00.000Z" });
    const clash = await tool("plan_block").call({
      kind: "plan",
      title: "Interview prep",
      start: "2026-11-15T12:30:00.000Z",
      end: "2026-11-15T13:15:00.000Z",
      activity: "studying",
    });
    const meals = await tool("plan_block").call({ ...working, activity: "meals", start: "2026-11-15T15:00:00.000Z" });

    expect(guessed.isError).toBeUndefined();
    expect(unexplained.text).toBe("Say why you guess so, in a line.");
    expect(clash.text).toBe("That clashes with Quillfield Dental on their calendar: fit it around.");
    expect(meals.isError).toBe(true);
    const [, written] = memory.items.get();
    expect(written?.title).toBe(`Working${guessMark}`);
    expect(written && picture.enrich(written)).toMatchObject({
      title: "Working",
      guess: { activity: "working", why: "Your usual weekday at the desk." },
    });
  });

  it("takes your answers to its guesses: right, what it really was, or your words", async () => {
    const { picture, tool, memory } = pictureWith("answers");
    await tool("plan_block").call(working);
    await tool("plan_block").call({ ...working, start: "2026-11-15T13:00:00.000Z", end: "2026-11-15T15:00:00.000Z" });
    await tool("plan_block").call({
      ...working,
      title: "Chilling",
      activity: "chilling",
      start: "2026-11-15T19:00:00.000Z",
      end: "2026-11-15T22:00:00.000Z",
    });
    const [morning, afternoon, evening] = memory.items.get();
    if (!morning || !afternoon || !evening) throw new Error("the guesses weren't written");

    const right = await picture.answer(morning.id, { right: true });
    const building = await picture.answer(evening.id, { activity: "building" });
    const words = await tool("correct_guess").call({ uid: afternoon.uid, text: "Dentist, then errands" });
    const again = await picture.answer(morning.id, { right: true });

    expect(right).toEqual(ok(expect.objectContaining({ title: "Working" })));
    expect(right.ok && right.value.guess).toBeUndefined();
    expect(building).toEqual(ok(expect.objectContaining({ title: "Building" })));
    expect(words.text).toBe("It's Dentist, then errands now.");
    expect(again).toEqual(fail({ code: "not_found", detail: "That guess has moved on." }));
    expect(memory.items.get().map(({ title }) => title)).toEqual(["Working", "Dentist, then errands", "Building"]);
    const hours = picture.hours(sunday, Date.parse("2026-11-16T00:00:00.000Z"));
    expect(Object.fromEntries(hours.guessed)).toEqual({ working: 3, other: 2, building: 3 });
  });

  it("forgets a block once it's gone from Kumo's calendar", async () => {
    const { picture, tool, memory, clock } = pictureWith("forgets");
    await tool("plan_block").call(working);
    const [written] = memory.items.get();
    if (!written) throw new Error("the guess wasn't written");
    clock.moveTo(sunday + 5 * 60 * 1000);
    memory.remove(written.uid);
    expect(picture.hours(sunday, sunday + 6 * 60 * 60 * 1000).guessed.size).toBe(0);
  });

  it("plans once a day before the day's line, and tells the line about last night", async () => {
    const { picture, store, work } = pictureWith("plans");
    const nights = createNights(store, "UTC");
    nights.change("2026-11-14", (night) => ({ ...night, stop: "01:00", nextStep: "the sync screen" }));
    nights.touch(Date.parse("2026-11-15T02:10:00.000Z"));

    const first = await picture.plan();
    const second = await picture.plan();

    expect(work.get()).toHaveLength(1);
    expect(work.get()[0]).toContain("Last night they set a stop at 1; their last sign was at 02:10.");
    expect(first).toEqual([
      "Last night they set a stop at 1; their last sign was at 02:10.",
      "The next step they noted for today: the sync screen",
      "Your plan for today, as you put it after planning: A free Sunday, with a quiet plan under it.",
    ]);
    expect(second).toEqual(first);
  });
});

// The check-ins, with a clock to move and the line Kumo would say captured rather than shown.
const checkinsWith = (name: string, start: string, building: boolean) => {
  const clock = createVirtualClock(Date.parse(start));
  const store = storeAt(name);
  const nights = createNights(store, "UTC");
  const said = createCell<readonly Line[]>([]);
  const desk = createCell<Desk>({ coming_up: [], waiting: [], handled: 0 });
  const listeners = createCell<readonly Listener[]>([]);
  const isAsleep = createCell(false);
  const evening: CalendarItem = {
    id: "v_build",
    uid: "build@kumo",
    title: "Building",
    start: "2026-11-11T21:00:00.000Z",
    end: "2026-11-12T02:00:00.000Z",
    all_day: false,
    calendar: kumo,
    guess: { activity: "building", why: "Most weeknights you build." },
  };
  const checkins = createCheckins({
    store: {
      desk: () => desk.get(),
      subscribe: (listener) => {
        listeners.update((current) => [...current, listener]);
        return ignore;
      },
      setting: (key) => store.setting(key),
      setSetting: (key, value) => {
        store.setSetting(key, value);
      },
    },
    clock,
    timeZone: "UTC",
    presence: { isWatched: () => false, onWatched: unsubscribed },
    isBusy: () => false,
    isGettingStarted: () => false,
    nights,
    picture: {
      dayItems: (day) => (building && day === "2026-11-11" ? [evening] : []),
      dayLines: () => [],
      goals: () => Promise.resolve([]),
      hours: () => ({ guessed: new Map(), planned: new Map() }),
    },
    questions: createQuestions(store, clock, "UTC"),
    moments: {
      say: (line) => {
        said.update((current) => [...current, line]);
        const moment: Moment = {
          id: `o_${String(said.get().length)}`,
          kind: line.kind,
          at: toTimestamp(clock.now()),
          text: line.text,
          message: "m_1",
          options: (line.options ?? []).map((label) => ({ label })),
          allows_text: line.allowsText === true,
        };
        return Promise.resolve(moment);
      },
    },
    complete: (_prompt, schema): Promise<Result<unknown, string>> =>
      Object.keys(schema.properties ?? {}).includes("stop")
        ? Promise.resolve(ok({ text: "Building tonight? Stop at 1, next step being…?", stop: "01:00" }))
        : Promise.resolve(fail("No words tonight.")),
    choice: () => Promise.resolve(undefined),
    work: () => Promise.resolve(ok("Moved the run to the evening.")),
    motions: { list: () => [] },
    lead: () => "Kumo",
    morning: () => "07:30",
    info: ignore,
    isAsleep: () => isAsleep.get(),
  });
  const advance = async (to: string): Promise<void> => {
    const target = Date.parse(to);
    const runDue = async (): Promise<void> => {
      if (!clock.runNext(target)) return;
      await yieldToIo();
      await yieldToIo();
      await runDue();
    };
    await runDue();
    clock.moveTo(target);
  };
  const answer = async (index: number, given: { readonly option?: string; readonly text?: string }) => {
    const line = said.get()[index];
    if (!line?.handler) throw new Error(`no line ${String(index)} to answer`);
    return line.handler.answer({} as Moment, given);
  };
  return { said, nights, advance, answer, checkins, isAsleep, clock };
};

describe("check-ins", () => {
  it("asks about tonight once, and only when building is likely", async () => {
    const quiet = checkinsWith("quiet-evening", "2026-11-11T20:00:00.000Z", false);
    const likely = checkinsWith("likely-evening", "2026-11-11T20:00:00.000Z", true);

    await quiet.advance("2026-11-11T23:00:00.000Z");
    await likely.advance("2026-11-11T23:00:00.000Z");

    expect(quiet.said.get()).toEqual([]);
    expect(likely.said.get()).toEqual([
      expect.objectContaining({
        kind: "checkin",
        text: "Building tonight? Stop at 1, next step being…?",
        options: ["Stop at 1", "Not tonight"],
        replyLabel: "Next step",
        matters: true,
      }),
    ]);
    quiet.checkins.close();
    likely.checkins.close();
  });

  it("keeps quiet tonight after Not tonight", async () => {
    const { said, advance, answer, checkins } = checkinsWith("not-tonight", "2026-11-11T20:25:00.000Z", true);
    await advance("2026-11-11T20:31:00.000Z");
    expect(await answer(0, { option: "Not tonight" })).toEqual(ok("No check-ins tonight."));
    await advance("2026-11-12T03:00:00.000Z");
    expect(said.get()).toHaveLength(1);
    checkins.close();
  });

  it("checks in before the line, again after a snooze, and past it only when you're still up", async () => {
    const { said, advance, answer, nights, checkins } = checkinsWith("the-line", "2026-11-11T20:25:00.000Z", true);
    await advance("2026-11-11T20:31:00.000Z");
    expect(await answer(0, { option: "Stop at 1" })).toEqual(ok("Tonight's line is 1; I'll check in at 12:45."));

    await advance("2026-11-12T00:46:00.000Z");
    expect(said.get()[1]).toMatchObject({
      text: "15 minutes to your 1. Note the next step now?",
      options: ["Snooze 15m"],
    });
    expect(await answer(1, { option: "Snooze 15m" })).toEqual(ok("I'll ask again at 01:01."));
    await advance("2026-11-12T01:06:00.000Z");
    expect(said.get()).toHaveLength(3);
    expect(await answer(2, { text: "Wire the empty state" })).toEqual(ok("Noted for tomorrow: Wire the empty state"));

    await advance("2026-11-12T01:30:00.000Z");
    expect(said.get()).toHaveLength(3);
    nights.touch(Date.parse("2026-11-12T01:30:00.000Z"));
    await advance("2026-11-12T01:36:00.000Z");
    expect(said.get()[3]).toMatchObject({ text: "It's past your 1. Your call.", options: ["I'm stopping"] });
    expect(await answer(3, { option: "I'm stopping" })).toEqual(ok("Good night. Tomorrow's plan stands."));
    await advance("2026-11-12T03:00:00.000Z");
    expect(said.get()).toHaveLength(4);
    expect(nights.get("2026-11-11")).toMatchObject({ stop: "01:00", nextStep: "Wire the empty state" });
    checkins.close();
  });

  it("says nothing once your Sleep Focus is on", async () => {
    const { said, advance, answer, isAsleep, checkins } = checkinsWith("asleep", "2026-11-11T20:25:00.000Z", true);
    await advance("2026-11-11T20:31:00.000Z");
    await answer(0, { option: "Stop at 1" });
    isAsleep.set(true);
    await advance("2026-11-12T03:00:00.000Z");
    expect(said.get()).toHaveLength(1);
    checkins.close();
  });
});

describe("the day's question on the Desk", () => {
  it("can be skipped, and only the question can", async () => {
    const token = "ito_day_test_not_a_real_token_000000000000000000000000";
    const server = createServer({
      dataDirectory: path.join(home, "server"),
      name: "day",
      embedder: wordEmbedder,
      timeZone: "UTC",
      createEngine: ({ callTool }) =>
        createScriptEngine(systemClock, demoScripts, callTool, undefined, demoAnswers, demoWork(callTool)),
    });
    server.store.setSetting(tokenSetting, hashToken(token));
    const skip = (moment = "none") =>
      server.app.inject({
        method: "POST",
        url: `/v0/desk/moment/${moment}/answer`,
        headers: { authorization: `Bearer ${token}` },
        payload: { skip: true },
      });
    await server.app.listen({ host: "127.0.0.1", port: 0 });
    try {
      await server.callTool("show_checkin", { kind: "past" });
      const past = await skip(server.store.desk().moment?.id);
      await server.callTool("show_checkin", { kind: "question" });
      const question = server.store.desk().moment;
      const skipped = await skip(question?.id);

      expect(past.statusCode).toBe(400);
      expect(question).toMatchObject({ kind: "question", options: [{ label: "Guard it" }, { label: "Fine to move" }] });
      expect(skipped.statusCode).toBe(202);
      expect(server.store.desk().moment).toBeUndefined();
      expect(server.store.listDone(undefined, 10).entries).toEqual([]);
    } finally {
      await server.close();
    }
  });
});

describe("your phone's Focus over the API", () => {
  it("holds what the phone said, and the same Focus said again keeps when it began", async () => {
    const token = "ito_focus_test_not_a_real_token_0000000000000000000000";
    const clock = createVirtualClock(Date.parse("2026-11-11T23:10:00.000Z"));
    const server = createServer({
      dataDirectory: path.join(home, "focus-server"),
      name: "focus",
      embedder: wordEmbedder,
      timeZone: "UTC",
      clock,
      createEngine: ({ callTool }) =>
        createScriptEngine(clock, demoScripts, callTool, undefined, demoAnswers, demoWork(callTool)),
    });
    server.store.setSetting(tokenSetting, hashToken(token));
    const url = "/v0/devices/184f020c-92fa-4fa7-bdc9-c76b45930cec/status";
    const headers = { authorization: `Bearer ${token}` };
    try {
      const put = () => server.app.inject({ method: "PUT", url, headers, payload: { focus: "sleep" } });
      const first = await put();
      clock.moveTo(Date.parse("2026-11-12T03:00:00.000Z"));
      const again = await put();
      expect([first.statusCode, again.statusCode]).toEqual([204, 204]);
      const held = await server.app.inject({ method: "GET", url, headers });
      expect(held.statusCode).toBe(200);
      expect(held.json()).toEqual({
        focus: "sleep",
        since: "2026-11-11T23:10:00.000Z",
        heard: "2026-11-12T03:00:00.000Z",
        until: "2026-11-12T07:30:00.000Z",
      });
      await server.app.inject({ method: "PUT", url, headers, payload: {} });
      const off = await server.app.inject({ method: "GET", url, headers });
      expect(off.json()).toEqual({});
    } finally {
      await server.close();
    }
  });
});
