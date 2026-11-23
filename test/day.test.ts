import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, assert, describe, expect, it } from "vitest";
import { createCell } from "#cell.ts";
import { toTimestamp } from "#clock.ts";
import type { Calendar } from "#calendar/calendar.ts";
import type { NewCalendarEvent } from "#calendar/icalendar.ts";
import { createBlockStore } from "#day/blocks.ts";
import { createDayPicture, guessMark } from "#day/picture.ts";
import { atLocal } from "#day/time.ts";
import { startOfDay, untilMinutes } from "#desk/day.ts";
import type { CalendarItem } from "#protocol/types.ts";
import { fail, ok } from "#result.ts";
import { openDatabase } from "#store/database.ts";
import { createTracks } from "#work/tracks.ts";
import { createVirtualClock } from "./support/virtual-clock.ts";

const home = mkdtempSync(path.join(os.tmpdir(), "ito-day-"));

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

const kumo = { name: "Kumo", kumo: true };

// Kumo's calendar in memory: what the day picture writes, as a calendar would hold it.
const memoryCalendar = (theirs: readonly CalendarItem[] = []) => {
  const items = createCell<readonly CalendarItem[]>(theirs);
  const listeners = createCell<readonly (() => void)[]>([]);
  const refreshed = (): void => {
    for (const listener of listeners.get()) listener();
  };
  const calendar: Pick<
    Calendar,
    "addEvent" | "changeEvent" | "removeEvent" | "isConnected" | "listItems" | "onRefreshed"
  > = {
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
    removeEvent: (uid) => {
      const found = items.get().find((item) => item.uid === uid);
      if (!found) return Promise.resolve(fail("There's no such event in the next week."));
      items.update((current) => current.filter((item) => item.uid !== uid));
      refreshed();
      return Promise.resolve(ok({ uid, title: found.title, start: found.start, end: found.end }));
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

const noMotions = { list: () => [] };

const pictureWith = (name: string, theirs: readonly CalendarItem[] = []) => {
  const clock = createVirtualClock(sunday);
  const memory = memoryCalendar(theirs);
  const database = openDatabase(path.join(home, `${name}.db`));
  const saved = createCell<ReadonlyMap<string, string>>(new Map());
  const picture = createDayPicture({
    blocks: createBlockStore(database),
    calendar: memory.calendar,
    motions: noMotions,
    desk: { addDone: () => assert.fail("The day picture records nothing here."), onUndo: ignore },
    tracks: createTracks({ database, clock, identifiers: { track: () => "l_day" }, info: ignore }),
    settings: {
      setting: (key) => saved.get().get(key),
      setSetting: (key, value) => {
        saved.update((current) => new Map([...current, [key, value]]));
      },
    },
    clock,
    timeZone: () => "UTC",
    info: ignore,
    lead: () => "Kumo",
  });
  const tool = (name: string) => {
    const found = picture.tools.find((candidate) => candidate.name === name);
    if (!found) throw new Error(`no tool ${name}`);
    return found;
  };
  return { clock, memory, picture, tool };
};

const working = {
  kind: "guess",
  title: "Working",
  start: "2026-11-15T09:00:00.000Z",
  end: "2026-11-15T12:00:00.000Z",
  activity: "working",
  why: "Your usual weekday at the desk.",
};

const london = "Europe/London";

const midnightOf = (instant: string): string => toTimestamp(startOfDay(Date.parse(instant), london));

// When the local clock next shows a time, as seen from an instant.
const at = (instant: string, minutes: number): string =>
  toTimestamp(Date.parse(instant) + untilMinutes(Date.parse(instant), london, minutes));

describe("local days across a change of clock", () => {
  it("start at local midnight, on the days the clocks go forward and back", () => {
    expect(midnightOf("2026-10-25T08:00:00.000Z")).toBe("2026-10-24T23:00:00.000Z");
    expect(midnightOf("2026-03-29T08:00:00.000Z")).toBe("2026-03-29T00:00:00.000Z");
    expect(midnightOf("2026-07-01T08:30:15.000Z")).toBe("2026-06-30T23:00:00.000Z");
  });

  it("wait until the local clock really shows the time, across a change of clock", () => {
    // The night the clocks go forward, 07:30 is six hours after half past midnight.
    expect(at("2026-03-29T00:30:00.000Z", 7 * 60 + 30)).toBe("2026-03-29T06:30:00.000Z");
    // The day they go forward has 23 hours, so the next midnight is 23 hours away.
    expect(at("2026-03-29T00:00:00.000Z", 0)).toBe("2026-03-29T23:00:00.000Z");
    // The day they go back has 25 hours.
    expect(at("2026-10-24T23:00:00.000Z", 0)).toBe("2026-10-26T00:00:00.000Z");
    expect(at("2026-11-11T07:29:30.000Z", 7 * 60 + 30)).toBe("2026-11-11T07:30:00.000Z");
    expect(at("2026-11-11T07:30:00.000Z", 7 * 60 + 30)).toBe("2026-11-12T07:30:00.000Z");
  });

  it("find local instants across a change of offset", () => {
    expect(toTimestamp(atLocal("2026-10-25", 90, london))).toBe("2026-10-25T01:30:00.000Z");
    expect(toTimestamp(atLocal("2026-07-01", 60, london))).toBe("2026-07-01T00:00:00.000Z");
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
    expect(clash.text).toBe(
      "That overlaps “Quillfield Dental” (dentist@icloud, 13:00–13:30, confirmed on their calendar). Fit it around " +
        "what's confirmed. Only if they've told you both stand, call again with overlap \"intended\" and " +
        "overlap_reason saying why.",
    );
    expect(clash.isError).toBe(true);
    expect(meals.isError).toBe(true);
    const [, written] = memory.items.get();
    expect(written?.title).toBe(`Working${guessMark}`);
    expect(written && picture.enrich(written)).toMatchObject({
      title: "Working",
      guess: { activity: "working", why: "Your usual weekday at the desk." },
    });
  });

  it("puts a soft plan over a hold only when Kumo means it, keeping why and each one's status", async () => {
    const hold: CalendarItem = {
      id: "v_hold",
      uid: "hold-call",
      title: "Call with Dana",
      start: "2026-11-15T09:30:00.000Z",
      end: "2026-11-15T10:00:00.000Z",
      all_day: false,
      calendar: kumo,
      status: "hold",
    };
    const { picture, tool, memory } = pictureWith("overlaps", [hold]);
    const walk = {
      kind: "plan",
      title: "Morning walk",
      start: "2026-11-15T09:00:00.000Z",
      end: "2026-11-15T10:30:00.000Z",
      activity: "rest",
    };
    const reason = "Both stand until Dana confirms the call; the walk gives way if it's on.";

    const refused = await tool("plan_block").call(walk);
    const bare = await tool("plan_block").call({ ...walk, overlap: "intended" });
    const unasked = await tool("plan_block").call({ ...walk, overlap_reason: reason });
    const placed = await tool("plan_block").call({ ...walk, overlap: "intended", overlap_reason: reason });
    // A guess over the walk and the hold, both soft, goes on the same way.
    const guessed = await tool("plan_block").call({
      ...working,
      start: "2026-11-15T10:00:00.000Z",
      overlap: "intended",
      overlap_reason: "They may work through the walk; the guess says so.",
    });

    expect(refused).toEqual({
      isError: true,
      text:
        "That overlaps the hold “Call with Dana” (hold-call, 09:30–10:00, not settled). Fit it around, or move " +
        "what's there; if they mean both to stand while it's decided, such as a soft plan beside a call that's only " +
        'held, call again with overlap "intended" and overlap_reason saying why and how they\'ll settle it.',
    });
    expect(bare.text).toBe('Give overlap "intended" with overlap_reason, or neither.');
    expect(unasked.text).toBe('Give overlap "intended" with overlap_reason, or neither.');
    expect(placed.isError).toBeUndefined();
    expect(placed.text).toMatch(
      /^Planned Morning walk \(block-[\w-]+\)\. It overlaps the hold “Call with Dana” \(hold-call, 09:30–10:00, not settled\) on purpose: Both stand until Dana confirms the call; the walk gives way if it's on\. Each keeps its own status; the day view shows the overlap\.$/u,
    );
    expect(guessed.isError).toBeUndefined();
    expect(guessed.text).toContain("your plan “Morning walk”");
    const [held, written] = memory.items.get();
    expect(held).toEqual(hold);
    expect(written && picture.enrich(written)).toMatchObject({ title: "Morning walk", overlap: { reason } });
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
    // Kumo keeps what it was told in mind, so its next guesses learn from it.
    expect(picture.inMindText().split("\n")).toEqual([
      "<your_guesses>",
      "What they told you about your guesses at their day lately:",
      "They said 1 of your guesses were right.",
      "- Sun 13:00–15:00: you guessed otherwise; it was Dentist, then errands",
      "- Sun 19:00–22:00: you guessed otherwise; it was Building",
      "</your_guesses>",
    ]);
  });

  it("forgets a block once it's gone from Kumo's calendar", async () => {
    const { picture, tool, memory, clock } = pictureWith("forgets");
    await tool("plan_block").call(working);
    const [written] = memory.items.get();
    if (!written) throw new Error("the guess wasn't written");
    clock.moveTo(sunday + 5 * 60 * 1000);
    memory.remove(written.uid);
    expect(picture.enrich(written)).toEqual(written);
  });
});
