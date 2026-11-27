import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setImmediate as yieldToIo } from "node:timers/promises";
import { afterAll, describe, expect, it } from "vitest";
import { createCalendarSource } from "#calendar/caldav.ts";
import { createCell } from "#cell.ts";
import { createScriptEngine } from "#engine/scripted/script-engine.ts";
import { pausedDetail, type WorkFailure } from "#engine/engine.ts";
import { hashToken, tokenSetting } from "#http/auth.ts";
import { wordEmbedder } from "#memory/embedder.ts";
import type { Repeat, WakeUp, WakeUpList } from "#protocol/types.ts";
import { fail, ok, type Result } from "#result.ts";
import { createServer, type Server } from "#server.ts";
import { lastingMs } from "#problems/problems.ts";
import { toChanges } from "#calendar/changes.ts";
import type { AgendaEntry } from "#calendar/calendar.ts";
import { nextOf } from "#wakeups/wakeups.ts";
import { createContactsSource } from "#contacts/carddav.ts";
import { startFakeCalDav, type FakeCalDav } from "./support/fake-caldav.ts";
import { startFakeCardDav, type FakeCardDav } from "./support/fake-carddav.ts";
import { createFakeMail } from "./support/fake-mail.ts";
import { createVirtualClock } from "./support/virtual-clock.ts";
import { randomUUID } from "node:crypto";
import { toMessageId } from "#conversation/ids.ts";

const home = mkdtempSync(path.join(os.tmpdir(), "ito-wakeups-"));
const token = "ito_wakeups_test_not_a_real_token_0000000000000000000000";

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

// What Kumo does in the background when it wakes: given each prompt and its run, it may call tools and answers.
// A failure in words is the model not answering; one with a code is as the engine reports it, such as a usage limit.
type Act = (prompt: string, run: string, server: Server) => Promise<Result<string, string | WorkFailure>>;

const toWorkFailure = (failure: string | WorkFailure): WorkFailure =>
  typeof failure === "string" ? { code: "model_unavailable", detail: failure } : failure;

const settle = async (rounds = 10): Promise<void> => {
  if (rounds === 0) return;
  await yieldToIo();
  await settle(rounds - 1);
};

type Dav = { readonly caldav: FakeCalDav; readonly carddav: FakeCardDav };

const setUp = (start = "2026-11-02T10:00:00.000Z", dav?: Dav) => {
  const dataDirectory = mkdtempSync(path.join(home, "server-"));
  const clock = createVirtualClock(Date.parse(start));
  const prompts = createCell<readonly string[]>([]);
  const acts = createCell<readonly Act[]>([]);
  // When the provider says its usage limit resets.
  const resetsAt = createCell<number | undefined>(undefined);
  const live = createCell<Server | undefined>(undefined);
  const open = async (): Promise<Server> => {
    const server = createServer({
      embedder: wordEmbedder,
      dataDirectory,
      name: "wake-ups",
      clock,
      timeZone: "Europe/London",
      ...(dav && {
        createCalendarSource: () =>
          createCalendarSource({
            appleId: dav.caldav.appleId,
            appPassword: dav.caldav.appPassword,
            serverUrl: dav.caldav.serverUrl,
          }),
        createContactsSource: () =>
          createContactsSource({
            appleId: dav.caldav.appleId,
            appPassword: dav.caldav.appPassword,
            serverUrl: dav.carddav.serverUrl,
          }),
        createMailSource: createFakeMail(() => new Date(clock.now()).toISOString()).create,
      }),
      createEngine: () =>
        createScriptEngine(
          clock,
          () => {
            throw new Error("This test starts no turns.");
          },
          undefined,
          undefined,
          undefined,
          async (prompt, run) => {
            prompts.update((current) => [...current, prompt]);
            const [act] = acts.get();
            acts.update((current) => current.slice(1));
            const running = live.get();
            const done = act && running ? await act(prompt, run, running) : fail("The test has Kumo do nothing here.");
            return done.ok ? done : fail(toWorkFailure(done.failure));
          },
          () => resetsAt.get(),
        ),
    });
    server.store.setSetting(tokenSetting, hashToken(token));
    await server.app.listen({ host: "127.0.0.1", port: 0 });
    live.set(server);
    return server;
  };
  const runUntil = async (time: string): Promise<void> => {
    if (clock.runNext(Date.parse(time))) {
      await settle();
      await runUntil(time);
      return;
    }
    clock.moveTo(Date.parse(time));
    await settle();
  };
  const plan = (...given: readonly Act[]): void => {
    acts.update((current) => [...current, ...given]);
  };
  return { open, runUntil, plan, prompts, clock, resetsAt };
};

const request = async (server: Server, method: "GET" | "PATCH" | "DELETE", url: string, payload?: unknown) => {
  const response = await server.app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${token}` },
    ...(payload !== undefined && { payload: payload as Record<string, unknown> }),
  });
  return { status: response.statusCode, body: response.body === "" ? undefined : response.json<unknown>() };
};

const listed = async (server: Server): Promise<readonly WakeUp[]> => {
  const { body } = await request(server, "GET", "/v0/wakeups");
  return (body as WakeUpList).wake_ups;
};

const posts = (server: Server): readonly string[] =>
  server.store
    .snapshot("no_cursor")
    .event.messages.filter(({ kind }) => kind === "post")
    .map(({ text }) => text);

const done = (server: Server): readonly (readonly [string, string | undefined, boolean])[] =>
  server.store.listDone(undefined, 20).entries.map(({ text, reason, quiet }) => [text, reason, quiet] as const);

const interview = {
  what: "Ask how the Halcyon technical went",
  why: "It ends at 15:30, and they wanted to talk it through while it's fresh.",
  at: "2026-11-02T15:30:00Z",
  asked: false,
  source: { kind: "calendar", title: "Halcyon technical, Mon 14:00", event_uid: "halcyon-1" },
};

const weekdayRun = {
  what: "Plan the day with them if it's unplanned",
  why: "Their days shift a lot; a quick shape early keeps the mornings for focus.",
  repeat: { days: ["mon", "tue", "wed", "thu", "fri"], time: "09:00" },
  asked: true,
  source: { kind: "chat", title: "“Look at my day each weekday morning”" },
};

describe("wake-ups", () => {
  it("are refused with spaces squeezed out next to their numbers, so Kumo never reads them back that way", async () => {
    const { open } = setUp();
    const server = await open();
    try {
      const glued = await server.callTool("set_wake_up", { ...interview, why: "It's a week until9January now." });
      const set = await server.callTool("set_wake_up", interview);
      const id = /^Set (?<id>w_\w+)/u.exec(set.text)?.groups?.id ?? "";
      const changed = await server.callTool("move_wake_up", { id, what: "Booked9Jan14:00–15:00 GMT" });

      expect(glued.isError).toBe(true);
      expect(glued.text).toMatch(/^Not saved: spaces are missing next to numbers in “until9”, “9January”\./u);
      expect(changed.isError).toBe(true);
      expect(changed.text).toMatch(/^Not saved: spaces are missing next to numbers in “9Jan”\./u);
      const plans = await listed(server);
      expect(plans.map(({ what }) => what)).toEqual([interview.what]);
    } finally {
      await server.close();
    }
  });

  it("look with what's in Kumo's mind and the end of the conversation, which background work doesn't see", async () => {
    const { open, runUntil, plan, prompts } = setUp("2026-11-02T23:30:00.000Z");
    const server = await open();
    try {
      const now = await server.callTool("write_page", {
        address: "memory:now",
        title: "Now",
        gist: "Building Ito late this week",
        note: "Bed by 1 this week",
        body: "As of 2 Nov, you're building Ito late into the night and aiming for bed by 1.",
      });
      expect(now.isError).toBeUndefined();
      const said = server.store.acceptMessage(toMessageId(randomUUID()), "one more bug and then bed");
      expect(said.ok).toBe(true);
      server.store.postMessage("Night. I'll keep your 9:00 run unless you say.");
      await server.callTool("set_wake_up", {
        what: "See whether they made it to bed",
        why: "They chose bed by 1 this week.",
        at: "2026-11-03T00:45:00Z",
        asked: false,
        source: { kind: "chat", title: "“Bed by 1 this week”" },
      });

      plan(() => Promise.resolve(ok("Their last word was goodnight; nothing to say.")));
      await runUntil("2026-11-03T01:00:00.000Z");

      const [prompt = ""] = prompts.get();
      expect(prompt).toContain("You're working for the person in the background");
      expect(prompt).toContain("It's Tuesday 3 November at 00:45 where they are (Europe/London).");
      expect(prompt).toContain("As of 2 Nov, you're building Ito late into the night and aiming for bed by 1.");
      expect(prompt).toContain("“See whether they made it to bed” at Tue 3 Nov, 00:45");
      expect(prompt).toContain("- Monday 2 November at 23:30, they: one more bug and then bed");
      expect(prompt).toContain("- Monday 2 November at 23:30, you: Night. I'll keep your 9:00 run unless you say.");
      expect(prompt.indexOf("<lately>")).toBeLessThan(prompt.indexOf("A wake-up you set has come due"));
      expect(posts(server)).toEqual(["Night. I'll keep your 9:00 run unless you say."]);
    } finally {
      await server.close();
    }
  });

  it("are set quietly, wake on time, look first, say in Done what they did, and repeat across a restart", async () => {
    const { open, runUntil, plan, prompts } = setUp();
    const first = await open();

    const once = await first.callTool("set_wake_up", interview);
    const weekly = await first.callTool("set_wake_up", weekdayRun);
    const past = await first.callTool("set_wake_up", { ...interview, at: "2026-11-01T18:00:00Z" });
    const local = await first.callTool("set_wake_up", { ...interview, at: "2026-11-02T18:00" });
    const whenless = await first.callTool("set_wake_up", { ...interview, at: undefined });

    expect(once.text).toMatch(/^Set w_\w+ for Mon 2 Nov, 15:30\.$/u);
    expect(weekly.text).toMatch(/^Set w_\w+ for Tue 3 Nov, 09:00\.$/u);
    expect(past).toEqual({ text: "2026-11-01T18:00:00Z has already passed: give a time to come.", isError: true });
    expect(local.isError).toBe(true);
    expect(whenless).toEqual({ text: "Say when: at, or a repeat.", isError: true });
    expect(first.store.desk().plans).toMatchObject([
      { what: interview.what, at: "2026-11-02T15:30:00.000Z", by: "kumo", source: { event: { uid: "halcyon-1" } } },
      { what: weekdayRun.what, at: "2026-11-03T09:00:00.000Z", by: "you", repeat: weekdayRun.repeat },
    ]);
    expect(posts(first)).toEqual([]);
    expect(done(first)).toEqual([]);

    plan(async (_prompt, run, server) => {
      await server.callTool("post", { text: "How did the technical go?" }, run);
      return ok("Asked how it went.");
    });
    await runUntil("2026-11-02T16:00:00.000Z");

    expect(prompts.get()[0]).toContain("A wake-up you set has come due: “Ask how the Halcyon technical went”.");
    expect(prompts.get()[0]).toContain("That event is no longer on their calendar.");
    expect(posts(first)).toEqual(["How did the technical go?"]);
    expect(done(first)).toEqual([
      ["Woke up for “Ask how the Halcyon technical went” and messaged you", "Asked how it went.", false],
    ]);
    const left = await listed(first);
    expect(left.map(({ what }) => what)).toEqual([weekdayRun.what]);

    plan(() => Promise.resolve(ok("Tuesday's already shaped; nothing to say.")));
    await runUntil("2026-11-03T09:30:00.000Z");

    expect(prompts.get()[1]).toContain("It repeats weekdays at 09:00 and comes back by itself");
    expect(done(first)[0]).toEqual([
      "Woke up for “Plan the day with them if it's unplanned”",
      "Tuesday's already shaped; nothing to say.",
      true,
    ]);
    // A new day counts afresh, and a quiet look isn't counted.
    expect(first.store.desk().handled).toBe(0);
    await first.close();

    const second = await open();
    try {
      expect(await listed(second)).toMatchObject([{ what: weekdayRun.what, at: "2026-11-04T09:00:00.000Z" }]);
    } finally {
      await second.close();
    }
  });

  it("are moved or dropped by Kumo's judgement, and moved or cancelled from the app", async () => {
    const { open, runUntil, plan } = setUp();
    const server = await open();
    try {
      await server.callTool("set_wake_up", interview);
      await server.callTool("set_wake_up", { ...interview, what: "Chase Clara's reply", at: "2026-11-02T17:00:00Z" });
      await server.callTool("set_wake_up", weekdayRun);
      const [technical, clara, weekdays] = await listed(server);
      plan(
        async (_prompt, run, current) => {
          await current.callTool("move_wake_up", { id: technical?.id, at: "2026-11-02T18:30:00Z" }, run);
          return ok("It ran late, so later.");
        },
        async (_prompt, run, current) => {
          await current.callTool("drop_wake_up", { id: clara?.id, reason: "She replied this afternoon." }, run);
          return ok("She replied already.");
        },
      );
      await runUntil("2026-11-02T17:10:00.000Z");

      expect(done(server)).toEqual([
        ["Dropped “Chase Clara's reply”", "She replied already.", false],
        ["Moved “Ask how the Halcyon technical went” to Mon 2 Nov, 18:30", "It ran late, so later.", false],
      ]);

      const moved = await request(server, "PATCH", `/v0/wakeups/${technical?.id ?? ""}`, {
        at: "2026-11-02T19:00:00.000Z",
        what: "Ask how the technical went",
      });
      const oneOff = await request(server, "PATCH", `/v0/wakeups/${weekdays?.id ?? ""}`, { repeat: null });
      const passed = await request(server, "PATCH", `/v0/wakeups/${technical?.id ?? ""}`, {
        at: "2026-11-01T19:00:00.000Z",
      });
      const unknown = await request(server, "PATCH", "/v0/wakeups/w_none", { at: "2026-11-03T19:00:00.000Z" });
      const cancelled = await request(server, "DELETE", `/v0/wakeups/${technical?.id ?? ""}`);
      const again = await request(server, "DELETE", `/v0/wakeups/${technical?.id ?? ""}`);

      expect(moved).toMatchObject({
        status: 200,
        body: { wake_up: { at: "2026-11-02T19:00:00.000Z", what: "Ask how the technical went" } },
      });
      expect(oneOff.body).not.toHaveProperty("wake_up.repeat");
      expect(passed.status).toBe(400);
      expect(unknown.status).toBe(404);
      expect(cancelled.status).toBe(204);
      expect(again.status).toBe(404);
      expect(server.store.desk().plans).toMatchObject([{ what: weekdayRun.what, at: "2026-11-03T09:00:00.000Z" }]);
      expect(server.store.desk().plans[0]?.repeat).toBeUndefined();
    } finally {
      await server.close();
    }
  });

  it("wait through a usage limit without retrying, then catch up once, in one message", async () => {
    const { open, runUntil, plan, prompts, resetsAt } = setUp();
    const evening = {
      what: "Ask what's left for tomorrow",
      why: "They like the evening to close the day's loose ends.",
      repeat: { days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"], time: "16:00" },
      asked: true,
      source: { kind: "chat", title: "“Check in with me at four”" },
    };
    const mailLine = "Mail they got or sent: look through their inboxes and Sent";
    const caughtUp =
      "While I was paused by your plan's usage limit I missed the Halcyon debrief and today's check-in. " +
      "How did the technical go?";
    const first = await open();
    await first.callTool("set_wake_up", interview);
    await first.callTool("set_wake_up", evening);
    plan(() => {
      resetsAt.set(Date.parse("2026-11-02T18:00:00.000Z"));
      return Promise.resolve(fail({ code: "usage_limit", detail: "You've hit your usage limit." }));
    });

    await runUntil("2026-11-02T15:31:00.000Z");

    expect(first.store.problems()).toMatchObject([
      { id: "kumo:paused", area: "kumo", title: "Kumo's paused until 18:00" },
    ]);
    expect(posts(first)).toEqual([]);
    const waiting = await listed(first);
    expect(waiting.map(({ at }) => at)).toEqual(["2026-11-02T15:30:00.000Z", "2026-11-02T16:00:00.000Z"]);
    expect(await first.background.work("Look at a new mail", { missed: mailLine })).toEqual({
      ok: false,
      failure: pausedDetail,
    });

    // The repeating one comes due and waits too, and a restart keeps the pause.
    await runUntil("2026-11-02T16:30:00.000Z");
    await first.close();
    const server = await open();
    try {
      expect(server.store.problems()).toMatchObject([{ id: "kumo:paused", title: "Kumo's paused until 18:00" }]);
      await runUntil("2026-11-02T17:59:00.000Z");
      expect(prompts.get()).toHaveLength(1);

      const asked = createCell("");
      plan((prompt) => {
        asked.set(prompt);
        return Promise.resolve(ok(caughtUp));
      });
      await runUntil("2026-11-02T18:01:00.000Z");

      expect(prompts.get()).toHaveLength(2);
      expect(asked.get()).toContain(interview.what);
      expect(asked.get()).toContain(evening.what);
      expect(asked.get()).toContain(`- ${mailLine}`);
      expect(asked.get()).toContain("Don't message them with post as you go");
      expect(posts(server)).toEqual([caughtUp]);
      expect(server.store.problems()).toEqual([]);
      expect(await listed(server)).toMatchObject([{ what: evening.what, at: "2026-11-03T16:00:00.000Z" }]);
      expect(done(server)).toEqual(
        expect.arrayContaining([
          [`Woke up late for “${interview.what}”`, "Caught up after Kumo's pause", true],
          [`Woke up late for “${evening.what}”`, "Caught up after Kumo's pause", true],
        ]),
      );
    } finally {
      await server.close();
    }
    // Over is over, across a restart too.
    const after = await open();
    try {
      expect(after.background.paused()).toBeUndefined();
      expect(after.background.isHolding()).toBe(false);
      expect(after.store.problems()).toEqual([]);
    } finally {
      await after.close();
    }
  });

  it("wait while Kumo's model can't act, show it as a problem, and catch up after", async () => {
    const { open, runUntil, plan } = setUp();
    const server = await open();
    try {
      await server.callTool("set_wake_up", interview);
      plan(
        () => Promise.resolve(fail("The model service answered 503.")),
        async (_prompt, run, current) => {
          await current.callTool("post", { text: "How did it go?" }, run);
          return ok("Asked.");
        },
      );
      await runUntil(new Date(Date.parse("2026-11-02T15:30:00.000Z") + lastingMs + 60_000).toISOString());

      expect(posts(server)).toEqual([]);
      expect(done(server)).toEqual([]);
      expect(server.store.problems()).toMatchObject([
        { id: "kumo:work", area: "kumo", title: "Kumo can't work in the background" },
      ]);
      expect(await listed(server)).toMatchObject([{ at: "2026-11-02T15:45:00.000Z" }]);

      await runUntil("2026-11-02T15:50:00.000Z");

      expect(posts(server)).toEqual(["How did it go?"]);
      expect(server.store.problems()).toEqual([]);
      expect(await listed(server)).toEqual([]);
    } finally {
      await server.close();
    }
  });

  it("repeat at their local time, whatever the change of clock", () => {
    const repeat: Repeat = { days: ["mon", "tue", "wed", "thu", "fri"], time: "09:00" };
    const next = (given: Repeat, after: string, timeZone: string): string =>
      new Date(nextOf(given, Date.parse(after), timeZone)).toISOString();
    // Friday evening in London: the next weekday morning is Monday.
    expect(next(repeat, "2026-11-06T18:00:00.000Z", "Europe/London")).toBe("2026-11-09T09:00:00.000Z");
    // The Sunday the clocks go back: Monday 09:00 is GMT again.
    expect(next(repeat, "2026-10-25T12:00:00.000Z", "Europe/London")).toBe("2026-10-26T09:00:00.000Z");
    expect(next({ days: ["sat"], time: "07:30" }, "2026-11-02T08:00:00.000Z", "Asia/Tokyo")).toBe(
      "2026-11-06T22:30:00.000Z",
    );
  });
});

const entry = (id: string, start: string, fields: Partial<AgendaEntry> = {}): AgendaEntry => ({
  id,
  uid: id,
  title: id,
  start,
  end: new Date(Date.parse(start) + 60 * 60 * 1000).toISOString(),
  allDay: false,
  state: "confirmed",
  ...fields,
});

describe("changes to their calendar", () => {
  it("are what's new, moved, changed or gone in the week ahead, never time passing", () => {
    const now = Date.parse("2026-11-02T08:00:00.000Z");
    const seen = {
      at: now - 2 * 60 * 1000,
      entries: [
        entry("dentist", "2026-11-03T09:00:00.000Z"),
        entry("climbing", "2026-11-04T19:00:00.000Z"),
        entry("dinner", "2026-11-05T19:30:00.000Z"),
        entry("lunch", "2026-11-06T12:00:00.000Z"),
        entry("standup", "2026-11-02T07:00:00.000Z"),
        entry("far", "2026-11-11T09:00:00.000Z"),
      ],
    };
    const changes = toChanges(seen, now, [
      entry("dentist", "2026-11-03T10:00:00.000Z"),
      entry("climbing", "2026-11-04T19:00:00.000Z", { location: "The Castle" }),
      entry("dinner", "2026-11-05T19:30:00.000Z", { state: "cancelled" }),
      entry("halcyon", "2026-11-05T14:00:00.000Z", { state: "invited" }),
      entry("standup", "2026-11-02T07:00:00.000Z", { title: "Stand-up" }),
      entry("far", "2026-11-11T09:00:00.000Z"),
      entry("further", "2026-11-09T07:59:00.000Z"),
    ]);

    expect(changes.map(({ kind, entry: { id } }) => [kind, id])).toEqual([
      ["moved", "dentist"],
      ["changed", "climbing"],
      ["gone", "dinner"],
      ["new", "halcyon"],
      ["new", "further"],
      ["gone", "lunch"],
    ]);
  });
});

const event = (uid: string, title: string, start: string, end: string, status = "CONFIRMED"): string =>
  [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Example//Planner//EN",
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `DTSTAMP:${start}`,
    `DTSTART:${start}`,
    `DTEND:${end}`,
    `SUMMARY:${title}`,
    `STATUS:${status}`,
    "END:VEVENT",
    "END:VCALENDAR",
    "",
  ].join("\r\n");

describe("waking on a change to their calendar", () => {
  it("looks once at each change, keeps its wake-ups current, and isn't told of its own changes", async () => {
    const caldav = await startFakeCalDav();
    const carddav = await startFakeCardDav();
    const { open, plan, prompts, runUntil } = setUp("2026-11-02T08:00:00.000Z", { caldav, carddav });
    caldav.seed("Home", "halcyon.ics", event("halcyon-1", "Halcyon technical", "20261102T140000Z", "20261102T153000Z"));
    caldav.seed("Home", "dinner.ics", event("dinner-1", "Dinner with Mira", "20261104T193000Z", "20261104T213000Z"));
    const server = await open();
    try {
      await server.host.setUp("icloud", { apple_id: caldav.appleId, app_password: caldav.appPassword });
      await server.host.switchTo("icloud", true);
      await server.calendar.refresh();
      await settle();
      await server.callTool("set_wake_up", interview);
      await server.callTool("add_event", {
        title: "Flights to Valencia",
        start: "2026-11-06T07:15:00Z",
        end: "2026-11-06T09:40:00Z",
      });
      await settle();
      expect(prompts.get()).toEqual([]);

      const [wakeUp] = await listed(server);
      plan(async (_prompt, run, current) => {
        await current.callTool("move_wake_up", { id: wakeUp?.id, at: "2026-11-02T17:30:00Z" }, run);
        await current.callTool("post", { text: "Tess moved your technical to 4, so I'll ask after." }, run);
        return ok("Moved the follow-up with it.");
      });
      caldav.seed(
        "Home",
        "halcyon.ics",
        event("halcyon-1", "Halcyon technical", "20261102T160000Z", "20261102T173000Z"),
      );
      caldav.seed(
        "Home",
        "dinner.ics",
        event("dinner-1", "Dinner with Mira", "20261104T193000Z", "20261104T213000Z", "CANCELLED"),
      );
      await server.calendar.refresh();
      await settle(20);
      await server.calendar.refresh();
      await settle(20);

      expect(prompts.get()).toHaveLength(1);
      expect(prompts.get()[0]).toContain("- Moved: Halcyon technical, now Mon 2 Nov, 16:00, was Mon 2 Nov, 14:00");
      expect(prompts.get()[0]).toContain("- Cancelled or removed: Dinner with Mira, Wed 4 Nov, 19:30");
      expect(prompts.get()[0]).toContain("Your wake-ups from these events:");
      expect(prompts.get()[0]).not.toContain("Valencia");
      expect(posts(server)).toEqual(["Tess moved your technical to 4, so I'll ask after."]);
      expect(server.store.desk().plans).toMatchObject([{ at: "2026-11-02T17:30:00.000Z" }]);
      await runUntil("2026-11-02T08:10:00.000Z");
      expect(prompts.get()).toHaveLength(1);
    } finally {
      await server.close();
      await caldav.close();
      await carddav.close();
    }
  });
});
