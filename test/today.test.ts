import { describe, expect, it } from "vitest";
import { toThreadId } from "#conversation/ids.ts";
import { createToday, dayStartOf, room } from "#day/today.ts";
import type { CalendarItem, DoneEntry, Message, Thread, WakeUp } from "#protocol/types.ts";
import { createVirtualClock } from "./support/virtual-clock.ts";

type Said = { readonly at: string; readonly who: "they" | "you" | "posted"; readonly text: string };

const thread = (id: string, title: string, extra: Partial<Thread> = {}): Thread => ({
  id,
  title,
  by: "you",
  state: "open",
  started_at: "2026-11-24T09:00:00.000Z",
  position: 1,
  replies: 2,
  last_at: "2026-11-24T09:00:00.000Z",
  ...extra,
});

const toMessages = (said: readonly (Said & { readonly thread?: string })[]): readonly Message[] =>
  said.map(({ at, who, text, thread: inThread }, index) => ({
    id: `m_${String(index)}`,
    role: who === "they" ? "user" : "agent",
    ...(who !== "they" && { kind: who === "posted" ? "post" : "reply" }),
    text,
    at,
    position: index + 1,
    ...(inThread !== undefined && { thread: inThread }),
  }));

const doneAt = (at: string, text: string, extra: Partial<DoneEntry> = {}): DoneEntry => ({
  id: `d_${at}`,
  at,
  text,
  undo: false,
  quiet: false,
  ...extra,
});

const kumo = { name: "Kumo", kumo: true };

const block = (title: string, start: string, end: string, extra: Partial<CalendarItem> = {}): CalendarItem => ({
  id: `v_${title}`,
  uid: `block-${title}`,
  title,
  start,
  end,
  all_day: false,
  calendar: kumo,
  ...extra,
});

const wakeUp = (title: string, at: string): WakeUp => ({
  id: `w_${title}`,
  at,
  title,
  what: title,
  why: "Because.",
  by: "kumo",
  source: { kind: "chat", title: "Chat" },
  set_at: "2026-11-24T09:00:00.000Z",
});

const setUp = (
  now: string,
  given: {
    readonly said?: readonly (Said & { readonly thread?: string })[];
    readonly threads?: readonly Thread[];
    readonly done?: readonly DoneEntry[];
    readonly wakeUps?: readonly WakeUp[];
    readonly calendar?: readonly CalendarItem[];
  },
) => {
  const messages = toMessages(given.said ?? []);
  return createToday({
    store: {
      messagesSince: (at, limit) =>
        messages
          .filter((message) => message.at >= at)
          .toReversed()
          .slice(0, limit),
      findThread: (id) => given.threads?.find((found) => found.id === id),
      doneSince: (at) => (given.done ?? []).filter((entry) => entry.at >= at).toReversed(),
      latestMessages: (limit) => messages.filter(({ thread: inThread }) => inThread === undefined).slice(-limit),
    },
    clock: createVirtualClock(Date.parse(now)),
    timeZone: () => "Europe/London",
    wakeUps: () => given.wakeUps ?? [],
    calendar: () => given.calendar ?? [],
  });
};

const slides = thread("h_slides", "Thursday's demo", { result: "First pass moved to today, 14:00" });
const handover = thread("h_handover", "Handover", { state: "done", result: "Handed over to Omar" });

const day: Parameters<typeof setUp>[1] = {
  said: [
    { at: "2026-11-23T22:10:00.000Z", who: "they", text: "Night!" },
    { at: "2026-11-24T08:30:00.000Z", who: "they", text: "Change of plan: I'm working from Leeds this week." },
    { at: "2026-11-24T08:31:00.000Z", who: "you", text: "Leeds it is. Your runs can follow the canal." },
    {
      at: "2026-11-24T09:10:00.000Z",
      who: "they",
      text: "The Northwind demo is Thursday at 14:00 and the slides aren't started.",
      thread: "h_slides",
    },
    {
      at: "2026-11-24T09:11:00.000Z",
      who: "you",
      text: "Two hours tomorrow morning for a first pass, as a plan on my calendar.\n\n```ari:choices\n{}\n```",
      thread: "h_slides",
    },
    { at: "2026-11-24T11:40:00.000Z", who: "they", text: "Handover to Omar is done.", thread: "h_handover" },
    {
      at: "2026-11-24T11:41:00.000Z",
      who: "you",
      text: "That frees this afternoon, so the slides' first pass moves to 14:00 today, and my check-in with it.",
      thread: "h_handover",
    },
  ],
  threads: [slides, handover],
  done: [
    doneAt("2026-11-24T06:00:00.000Z", "Read 4 mails", { quiet: true }),
    doneAt("2026-11-24T09:00:00.000Z", "Woke up for “Look at the day with you”", { reason: "Nothing to add." }),
    doneAt("2026-11-24T10:05:00.000Z", "Binned “20% off” from Acme", { corrected_at: "2026-11-24T10:30:00.000Z" }),
  ],
  wakeUps: [
    wakeUp("Check in on the slides", "2026-11-24T17:00:00.000Z"),
    wakeUp("Weekly look", "2026-11-30T09:00:00Z"),
  ],
  calendar: [
    block("Slides, first pass", "2026-11-24T14:00:00.000Z", "2026-11-24T16:00:00.000Z"),
    block("Working", "2026-11-24T11:00:00.000Z", "2026-11-24T12:30:00.000Z", {
      guess: { activity: "working", why: "A weekday" },
    }),
    block("Dinner with Mira", "2026-11-24T19:00:00.000Z", "2026-11-24T21:00:00.000Z", {
      calendar: { name: "Home", kumo: false },
      status: "tentative",
    }),
    block("Northwind demo", "2026-11-26T14:00:00.000Z", "2026-11-26T15:00:00.000Z", {
      calendar: { name: "Work", kumo: false },
    }),
  ],
};

const startOf = (now: string): string => new Date(dayStartOf(Date.parse(now), "Europe/London")).toISOString();

describe("today so far", () => {
  it("starts the day at 04:00 where they are, so a late night belongs to the day it began in", () => {
    expect(startOf("2026-11-24T12:00:00.000Z")).toBe("2026-11-24T04:00:00.000Z");
    expect(startOf("2026-11-24T01:30:00.000Z")).toBe("2026-11-23T04:00:00.000Z");
    expect(startOf("2026-07-01T12:00:00.000Z")).toBe("2026-07-01T03:00:00.000Z");
  });

  it("joins up every thread, what Kumo did and what's next, for background work", () => {
    const today = setUp("2026-11-24T12:00:00.000Z", day);

    expect(today.text()).toBe(
      [
        "<today>",
        "Today so far, since 04:00, across the main chat and their threads, the latest first. It's one day and one " +
          "plan: join up what's said anywhere before you act, keep your blocks and wake-ups to it, and don't ask " +
          "again or check in twice about what's here.",
        "",
        "“Handover” (h_handover), a thread, marked done (Handed over to Omar):",
        "- 11:40 they: Handover to Omar is done.",
        "- 11:41 you: That frees this afternoon, so the slides' first pass moves to 14:00 today, and my check-in with it.",
        "“Thursday's demo” (h_slides), a thread (First pass moved to today, 14:00):",
        "- 09:10 they: The Northwind demo is Thursday at 14:00 and the slides aren't started.",
        "- 09:11 you: Two hours tomorrow morning for a first pass, as a plan on my calendar.",
        "The main chat:",
        "- 08:30 they: Change of plan: I'm working from Leeds this week.",
        "- 08:31 you: Leeds it is. Your runs can follow the canal.",
        "",
        "What you did today, from your Done list (written to them), newest first:",
        "- 10:05 Binned “20% off” from Acme (they said this was wrong)",
        "- 09:00 Woke up for “Look at the day with you”: Nothing to add.",
        "  (and 1 mail read with nothing needed)",
        "",
        "Still to come today, soonest first:",
        "- now–12:30 Working · your guess",
        "- 14:00–16:00 Slides, first pass · your block",
        "- 17:00 wake-up: Check in on the slides",
        "- 19:00–21:00 Dinner with Mira · tentative",
        "</today>",
      ].join("\n"),
    );
  });

  it("leaves out a turn's own conversation, which it has already", () => {
    const today = setUp("2026-11-24T12:00:00.000Z", day);
    const inSlides = today.text({ thread: toThreadId("h_slides") });
    const inMain = today.text({ thread: undefined });

    expect(inSlides).toContain("This conversation's own messages are left out: you have them.");
    expect(inSlides).not.toContain("The Northwind demo is Thursday");
    expect(inSlides).toContain("- 08:30 they: Change of plan: I'm working from Leeds this week.");
    expect(inSlides).toContain("- 11:40 they: Handover to Omar is done.");
    expect(inMain).not.toContain("The main chat:");
    expect(inMain).toContain("“Thursday's demo” (h_slides)");
  });

  it("counts a late night in the day it began, and says where the chat left off when nothing's been said", () => {
    const lateNight = setUp("2026-11-24T01:30:00.000Z", day);
    const quietMorning = setUp("2026-11-24T05:00:00.000Z", { said: day.said?.slice(0, 1) ?? [] });

    expect(lateNight.text()).toContain("since 04:00");
    expect(lateNight.text()).toContain("- Mon 22:10 they: Night!");
    expect(quietMorning.text()).toContain(
      "Nothing said yet today. Where the main chat left off:\n- Mon 22:10 they: Night!",
    );
    expect(quietMorning.text({ thread: undefined })).toBe("");
  });

  it("stays within its room on a busy day, the newest first, and names what didn't fit", () => {
    const busy = Array.from({ length: 80 }, (_, index): Said & { readonly thread?: string } => ({
      at: new Date(Date.parse("2026-11-24T06:00:00.000Z") + index * 6 * 60_000).toISOString(),
      who: index % 2 === 0 ? "they" : "you",
      text: `Message ${String(index)}: ${"a fairly ordinary sentence about the day, ".repeat(6)}`,
      ...(index < 20 && { thread: "h_handover" }),
      ...(index >= 20 && index < 40 && { thread: "h_slides" }),
    }));
    const done = Array.from({ length: 30 }, (_, index) =>
      doneAt(
        new Date(Date.parse("2026-11-24T06:00:00.000Z") + index * 10 * 60_000).toISOString(),
        `Did thing ${String(index)} for you, carefully and with a reason`,
        { reason: "Because it needed doing before the afternoon." },
      ),
    );
    const today = setUp("2026-11-24T15:00:00.000Z", { ...day, said: busy, done });
    const text = today.text();

    expect(text.length).toBeLessThan(room.said + room.done + room.next + 600);
    expect(text).toContain("Message 79:");
    expect(text).not.toContain("Message 50:");
    expect(text).toContain("The main chat:\n  (");
    expect(text).toContain(
      "Earlier today, also: “Thursday's demo” (h_slides), 20 messages; “Handover” (h_handover), 20 messages.",
    );
    expect(text).toMatch(/\(and \d+ more\)/u);
  });
});
