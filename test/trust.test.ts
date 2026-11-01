import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createCell } from "#cell.ts";
import { createDesk } from "#desk/desk.ts";
import { randomIdentifiers } from "#identifiers.ts";
import { ok } from "#result.ts";
import { openDatabase } from "#store/database.ts";
import { createStore } from "#store/store.ts";
import { climbCallsSetting, createTrust, sectionOf, stretchWords, type Rung, type TrustOptions } from "#work/trust.ts";
import { createVirtualClock } from "./support/virtual-clock.ts";

const home = mkdtempSync(path.join(os.tmpdir(), "ito-trust-"));

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

const dayMs = 24 * 60 * 60 * 1000;
const ignore = (): void => undefined;

const open = (name: string, start: string, random: () => number = () => 1) => {
  const clock = createVirtualClock(Date.parse(start));
  const store = createStore(openDatabase(path.join(home, `${name}.db`)), clock, randomIdentifiers);
  const prompts = createCell<readonly string[]>([]);
  const told = createCell<readonly string[]>([]);
  const undone = createCell<readonly unknown[]>([]);
  const work: TrustOptions["work"] = (prompt) => {
    prompts.update((current) => [...current, prompt]);
    return Promise.resolve(ok("Noted under Sorting mail: keep Acme's order mail in the inbox."));
  };
  const desk = createDesk({ store, identifiers: randomIdentifiers, clock, timeZone: "UTC", work, info: ignore });
  desk.onUndo((_entry, payload) => {
    undone.update((current) => [...current, payload]);
    return Promise.resolve(ok(undefined));
  });
  const trust = createTrust({
    store,
    desk,
    clock,
    timeZone: "UTC",
    tell: (text) => {
      told.update((current) => [...current, text]);
      return "told";
    },
    work,
    isGettingStarted: () => false,
    random,
    info: ignore,
  });
  const runUntil = (time: number): void => {
    if (clock.runNext(time)) {
      runUntil(time);
      return;
    }
    clock.moveTo(time);
  };
  return { clock, store, desk, trust, prompts, told, undone, runUntil };
};

const binned = (subject: string) => ({
  text: `Binned "${subject}" from Acme`,
  reason: "A promotion",
  mail: { account: "icloud", message_id: `${subject}@acme.com`, from: "Acme", subject },
  quiet: false,
  undo: { kind: "mail_filed", account: "icloud", id: `${subject}@acme.com`, back: "inbox" },
});

const climbed = (days: number, step: Rung["step"], since: string): Rung => ({
  step,
  since,
  change: { kind: "climb", days },
});

describe("the trust ladder", () => {
  it("counts mail calls as sorting, starts each kind at Learning, and leaves anything else off", () => {
    const { desk, trust } = open("kinds", "2026-11-10T09:00:00.000Z");
    const entry = desk.addDone(binned("Weekend sale"));
    const failed = desk.addDone({ ...binned("Flash sale"), text: "Couldn't move it; it's still in your inbox" });
    const answer = desk.addDone({ text: "You answered “Italian practice?”: Yes", quiet: false });
    const calendar = desk.addDone({ text: "Put the Halcyon call on your calendar", quiet: false, work: "calendar" });

    expect([entry.work, failed.work, answer.work, calendar.work]).toEqual([
      "sorting",
      undefined,
      undefined,
      "calendar",
    ]);
    expect(trust.ladder()).toEqual([
      {
        work: "sorting",
        title: "Sorting mail",
        step: "learning",
        line: "I show you the mail I sort while I learn what matters to you.",
        since: entry.at,
      },
      {
        work: "calendar",
        title: "Calendar",
        step: "learning",
        line: "I show you every calendar change while I learn your days.",
        since: calendar.at,
      },
    ]);
  });

  it("climbs a rung after enough clean calls and two weeks, and says so through Kumo's line", () => {
    const { clock, store, desk, trust, told } = open("climb", "2026-11-01T09:00:00.000Z");
    store.setSetting(climbCallsSetting, "3");
    for (const subject of ["A", "B", "C"]) desk.addDone(binned(subject));
    clock.moveTo(clock.now() + 13 * dayMs);
    desk.addDone(binned("D"));
    expect(trust.ladder()[0]?.step).toBe("learning");

    clock.moveTo(clock.now() + dayMs);
    desk.addDone(binned("E"));

    expect(trust.ladder()[0]).toMatchObject({
      step: "spot_checks",
      line: "Two weeks without a correction on sorting. I only check about one in five with you now.",
    });
    expect(told.get()).toEqual([
      "Two weeks without a correction on sorting. From now on I'll only check about one in five with you.",
    ]);
  });

  it("takes a correction: undoes it, steps back one rung, says so, and keeps a preference", async () => {
    const { desk, trust, told, prompts, undone, store } = open("correct", "2026-11-10T09:00:00.000Z");
    const entry = desk.addDone(binned("Your order has shipped"));
    trust.hold("sorting", climbed(15, "trusted", "2026-11-01T09:00:00.000Z"));

    const corrected = await trust.correct(entry.id, "  I needed that one ");
    await trust.settled();

    expect(corrected).toMatchObject({
      ok: true,
      value: { text: `Undone: ${entry.text}`, corrected_at: "2026-11-10T09:00:00.000Z", undo: false },
    });
    expect(undone.get()).toEqual([binned("Your order has shipped").undo]);
    expect(trust.ladder()[0]).toMatchObject({
      step: "spot_checks",
      line: 'You said “Binned "Your order has shipped" from Acme” was wrong today, so I\'m back to checking about one in five with you.',
    });
    expect(told.get()).toEqual([
      'You said “Binned "Your order has shipped" from Acme” was wrong, so I\'m back to checking about one in five with you.',
    ]);
    expect(prompts.get()[0]).toContain('under "Sorting mail" on their How to help you page');
    expect(prompts.get()[0]).toContain("They said: I needed that one");
    expect(prompts.get()[0]).toContain("It's been undone.");
    // Both entries share the virtual clock's moment, so find the correction's by its words.
    const noted = store.listDone(undefined, 10).entries.find(({ text }) => text.startsWith("You said"));
    expect(noted).toMatchObject({
      text: 'You said “Binned "Your order has shipped" from Acme” was wrong: I needed that one',
      reason: "Noted under Sorting mail: keep Acme's order mail in the inbox.",
    });
    expect(noted?.work).toBeUndefined();
  });

  it("only adds words to a correction said again, and stays at Learning without a word in Kumo's line", async () => {
    const { desk, trust, told, prompts } = open("again", "2026-11-10T09:00:00.000Z");
    const entry = desk.addDone({ text: "Put Leo's climbing on your calendar", quiet: false, work: "calendar" });

    await trust.correct(entry.id);
    await trust.correct(entry.id);
    await trust.correct(entry.id, "It's Thursdays, not Wednesdays");
    await trust.settled();

    expect(told.get()).toEqual([]);
    expect(trust.ladder()[0]).toMatchObject({
      step: "learning",
      line: "You said “Put Leo's climbing on your calendar” was wrong today. I'm still showing you every calendar change while I learn.",
    });
    expect(prompts.get()).toHaveLength(2);
    expect(prompts.get()[0]).toContain("work out what was most likely wrong");
    expect(prompts.get()[1]).toContain("They said: It's Thursdays, not Wednesdays");
    expect(await trust.correct("d_none")).toEqual({ ok: false, failure: "not_found" });
  });

  it("asks about about one call in five while spot checking, once a day, and a wrong answer corrects it", async () => {
    const { desk, trust, store } = open("spot", "2026-11-10T09:00:00.000Z", () => 0.1);
    desk.addDone(binned("First"));
    trust.hold("sorting", climbed(14, "spot_checks", "2026-11-09T09:00:00.000Z"));
    const entry = desk.addDone(binned("Your Acme receipt"));
    desk.addDone(binned("Another"));

    const cards = desk.cards();
    expect(cards).toEqual([
      expect.objectContaining({
        kind: "question",
        title: "Was this right?",
        quiet: true,
        allows_text: true,
        options: [{ label: "Right", acts: true }, { label: "That was wrong" }],
        question: { text: `${entry.text}. A promotion. Was this right?` },
      }),
    ]);
    const answered = desk.answer(cards[0]?.id ?? "", { text: "That's my receipt" });
    expect(answered.ok).toBe(true);
    await desk.settled();

    expect(desk.cards()).toEqual([]);
    expect(store.findDone(entry.id)?.entry.corrected_at).toBe("2026-11-10T09:00:00.000Z");
    expect(trust.ladder()[0]?.step).toBe("learning");
  });

  it("puts yesterday's calls of a kind still learning in one card a day to glance at", async () => {
    const { desk, store, runUntil } = open("review", "2026-11-10T15:00:00.000Z");
    desk.addDone(binned("One"));
    desk.addDone(binned("Two"));
    desk.addDone({ text: "Put the dentist on your calendar", quiet: false, work: "calendar" });
    runUntil(Date.parse("2026-11-11T07:00:00.000Z"));
    expect(desk.cards()).toEqual([]);

    runUntil(Date.parse("2026-11-11T07:30:00.000Z"));
    runUntil(Date.parse("2026-11-11T12:00:00.000Z"));

    const [card] = desk.cards();
    expect(desk.cards()).toHaveLength(1);
    expect(card).toMatchObject({
      kind: "question",
      title: "Yesterday's calls to glance at",
      question: { text: "Yesterday I sorted 2 mails and made 1 calendar change. Glance?" },
      options: [{ label: "Glance", acts: true }, { label: "Looks fine" }],
      quiet: true,
      review: { day: "2026-11-10", work: ["sorting", "calendar"] },
    });
    expect(desk.doneOn("2026-11-10")).toHaveLength(3);
    expect(desk.doneOn("2026-11-11")).toHaveLength(0);
    desk.answer(card?.id ?? "", { option: "Glance" });
    await desk.settled();
    expect(desk.cards()).toEqual([]);
    expect(store.listDone(undefined, 10).entries).toHaveLength(3);
  });

  it("shows everything again on request, in the app or in words", async () => {
    const { desk, trust } = open("reset", "2026-11-10T09:00:00.000Z");
    desk.addDone(binned("One"));
    desk.addDone({ text: "Moved the dentist", quiet: false, work: "calendar" });
    trust.hold("sorting", climbed(15, "trusted", "2026-11-01T09:00:00.000Z"));
    trust.hold("calendar", climbed(15, "trusted", "2026-11-01T09:00:00.000Z"));

    expect(trust.reset("sorting")).toMatchObject({
      ok: true,
      value: { step: "learning", line: "You asked to see everything again, so I'm showing you the mail I sort." },
    });
    expect(trust.reset("contacts")).toEqual({ ok: false, failure: "not_found" });
    const tool = trust.tools.find(({ name }) => name === "show_everything_again");
    expect(await tool?.call({})).toEqual({
      text: "Back to Learning: Sorting mail and Calendar. They'll see each call again.",
    });
    expect(trust.ladder().map(({ step }) => step)).toEqual(["learning", "learning"]);
  });

  it("finds a section of How to help you, and words a clean stretch", () => {
    const page = [
      "## Writing as you",
      "Casual, short.",
      "## Sorting mail",
      "- Keep Acme order mail in the inbox.",
      "### Newsletters",
      "- Halcyon's is worth reading.",
      "## Your calendar",
      "- Climbing is Thursdays.",
    ].join("\n");

    expect(sectionOf(page, "Sorting mail")).toBe(
      "- Keep Acme order mail in the inbox.\n### Newsletters\n- Halcyon's is worth reading.",
    );
    expect(sectionOf(page, "contacts")).toBe("");
    expect([3, 7, 14, 15, 21, 30, 90].map((days) => stretchWords(days))).toEqual([
      "3 days",
      "A week",
      "Two weeks",
      "Two weeks",
      "Three weeks",
      "A month",
      "3 months",
    ]);
  });
});
