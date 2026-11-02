import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setImmediate as yieldToIo } from "node:timers/promises";
import { afterAll, describe, expect, it } from "vitest";
import { createCell } from "#cell.ts";
import { toTimestamp } from "#clock.ts";
import { startOfDay, untilMinutes } from "#desk/day.ts";
import { createDesk } from "#desk/desk.ts";
import { createMoments } from "#desk/moments.ts";
import { randomIdentifiers } from "#identifiers.ts";
import { ok, type Result } from "#result.ts";
import { openDatabase } from "#store/database.ts";
import { createStore } from "#store/store.ts";
import { createVirtualClock } from "./support/virtual-clock.ts";

const home = mkdtempSync(path.join(os.tmpdir(), "ito-moments-"));

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

const ignore = (): void => undefined;

const settle = async (rounds = 10): Promise<void> => {
  if (rounds === 0) return;
  await yieldToIo();
  await settle(rounds - 1);
};

const london = "Europe/London";

const midnightOf = (instant: string): string => toTimestamp(startOfDay(Date.parse(instant), london));

// When the local clock next shows a time, as seen from an instant.
const at = (instant: string, minutes: number): string =>
  toTimestamp(Date.parse(instant) + untilMinutes(Date.parse(instant), london, minutes));

// Kumo's lines with a clock to move, a model that answers only when told to, and being looked at on cue.
const momentsWith = (name: string, start: string) => {
  const clock = createVirtualClock(Date.parse(start));
  const store = createStore(openDatabase(path.join(home, `${name}.db`)), clock, randomIdentifiers);
  const desk = createDesk({
    store,
    identifiers: randomIdentifiers,
    clock,
    timeZone: "UTC",
    work: () => Promise.resolve(ok("")),
    info: ignore,
  });
  const watchers = createCell<readonly (() => void)[]>([]);
  const answers = createCell<readonly ((answer: Result<unknown, string>) => void)[]>([]);
  const moments = createMoments({
    store,
    desk,
    clock,
    timeZone: "UTC",
    presence: {
      isWatched: () => true,
      onWatched: (listener) => {
        watchers.update((current) => [...current, listener]);
        return ignore;
      },
    },
    complete: () =>
      new Promise((resolve) => {
        answers.update((current) => [...current, resolve]);
      }),
    choice: () => Promise.resolve(undefined),
    isBusy: () => false,
    isGettingStarted: () => false,
    identifiers: randomIdentifiers,
    lead: () => "Kumo",
    notify: ignore,
    info: ignore,
  });
  const answerAll = async (text: string): Promise<void> => {
    const waiting = answers.get();
    answers.set([]);
    for (const answer of waiting) answer(ok({ text, detail: "", options: [], reply: false, important: false }));
    await settle();
  };
  const look = async (): Promise<void> => {
    for (const watcher of watchers.get()) watcher();
    await settle();
  };
  const lines = (): readonly string[] =>
    store
      .snapshot("no_cursor")
      .event.messages.filter(({ kind }) => kind === "moment")
      .map(({ text }) => text);
  return { clock, moments, settle, answerAll, look, lines, pending: () => answers.get().length };
};

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
});

describe("Kumo's line for the moment", () => {
  it("writes the day's first line once, even when they open Ito while it's being written", async () => {
    const { clock, moments, settle, answerAll, look, lines, pending } = momentsWith(
      "day-once",
      "2026-11-11T07:00:00.000Z",
    );
    await settle();
    clock.runNext(Date.parse("2026-11-11T07:30:00.000Z"));
    await settle();
    expect(pending()).toBe(1);

    await look();
    await look();
    await answerAll("A free Wednesday, with a quiet plan under it.");
    await answerAll("A free Wednesday, again.");

    expect(lines()).toEqual(["A free Wednesday, with a quiet plan under it."]);
    moments.close();
  });
});
