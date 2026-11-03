import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setImmediate as yieldToIo } from "node:timers/promises";
import { afterAll, describe, expect, it } from "vitest";
import { createCalendarSource } from "#calendar/caldav.ts";
import { createCell } from "#cell.ts";
import { createContactsSource } from "#contacts/carddav.ts";
import { createScriptEngine } from "#engine/scripted/script-engine.ts";
import { hashToken, tokenSetting } from "#http/auth.ts";
import { wordEmbedder } from "#memory/embedder.ts";
import type { CalendarItem, DoneEntry, Work } from "#protocol/types.ts";
import { fail } from "#result.ts";
import { createServer, type Server } from "#server.ts";
import { startFakeCalDav } from "./support/fake-caldav.ts";
import { startFakeCardDav } from "./support/fake-carddav.ts";
import { createFakeMail } from "./support/fake-mail.ts";
import { createVirtualClock } from "./support/virtual-clock.ts";

const home = mkdtempSync(path.join(os.tmpdir(), "ito-day-view-"));
const token = "ito_day_view_test_not_a_real_token_0000000000000000000000";

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

const settle = async (rounds = 20): Promise<void> => {
  if (rounds === 0) return;
  await yieldToIo();
  await settle(rounds - 1);
};

const dentist = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "PRODID:-//Example//Planner//EN",
  "BEGIN:VEVENT",
  "UID:dentist-1",
  "DTSTAMP:20261115T080000Z",
  "DTSTART:20261115T140000Z",
  "DTEND:20261115T143000Z",
  "SUMMARY:Dentist",
  "END:VEVENT",
  "END:VCALENDAR",
  "",
].join("\r\n");

const run = {
  kind: "plan",
  title: "Easy run",
  start: "2026-11-15T10:30:00Z",
  end: "2026-11-15T11:00:00Z",
  activity: "training",
  why: "Week 1 of the sub-20 block",
};

const working = {
  kind: "guess",
  title: "Working",
  start: "2026-11-15T15:00:00Z",
  end: "2026-11-15T18:00:00Z",
  activity: "working",
  why: "Your usual afternoon at the desk",
};

describe("Kumo's blocks in the day view", () => {
  it("move and go from Ito, only Kumo's own, with an undo, a correction where it fits, and Kumo told", async () => {
    const caldav = await startFakeCalDav();
    const carddav = await startFakeCardDav();
    caldav.seed("Home", "dentist.ics", dentist);
    const clock = createVirtualClock(Date.parse("2026-11-15T08:00:00.000Z"));
    const prompts = createCell<readonly string[]>([]);
    const inMind = createCell<() => string>(() => "");
    const server: Server = createServer({
      embedder: wordEmbedder,
      dataDirectory: mkdtempSync(path.join(home, "server-")),
      name: "day-view",
      clock,
      timeZone: "Europe/London",
      createCalendarSource: () =>
        createCalendarSource({ appleId: caldav.appleId, appPassword: caldav.appPassword, serverUrl: caldav.serverUrl }),
      createContactsSource: () =>
        createContactsSource({
          appleId: caldav.appleId,
          appPassword: caldav.appPassword,
          serverUrl: carddav.serverUrl,
        }),
      createMailSource: createFakeMail(() => new Date(clock.now()).toISOString()).create,
      createEngine: (context) => {
        inMind.set(context.inMind);
        return createScriptEngine(
          clock,
          () => {
            throw new Error("This test starts no turns.");
          },
          undefined,
          undefined,
          undefined,
          (prompt) => {
            prompts.update((current) => [...current, prompt]);
            return Promise.resolve(fail("Kumo does nothing in the background here."));
          },
        );
      },
    });
    server.store.setSetting(tokenSetting, hashToken(token));
    await server.app.listen({ host: "127.0.0.1", port: 0 });
    const call = async (method: "GET" | "PATCH" | "DELETE" | "POST", url: string, payload?: object) => {
      const response = await server.app.inject({
        method,
        url,
        headers: { authorization: `Bearer ${token}` },
        ...(payload && { payload: payload as Record<string, unknown> }),
      });
      return { status: response.statusCode, body: response.body === "" ? undefined : response.json<unknown>() };
    };
    const items = (): readonly CalendarItem[] => server.store.desk().coming_up;
    const item = (title: string): CalendarItem => {
      const found = items().find((candidate) => candidate.title.startsWith(title));
      if (!found) throw new Error(`nothing called ${title}`);
      return found;
    };
    const done = (start: string): DoneEntry | undefined =>
      server.store.listDone(undefined, 10).entries.find(({ text }) => text.startsWith(start));
    const tracks = async (): Promise<Work["tracks"]> => {
      const { body } = await call("GET", "/v0/work");
      return (body as Work).tracks;
    };
    try {
      await server.host.setUp("icloud", { apple_id: caldav.appleId, app_password: caldav.appPassword });
      await server.host.switchTo("icloud", true);
      await server.calendar.refresh();
      await settle();
      const opened = await server.callTool("open_track", { name: "Planning your days" });
      const track = /Opened (\S+):/u.exec(opened.text)?.[1] ?? "";
      expect(await server.callTool("plan_block", { ...run, track: "tr_none" })).toMatchObject({ isError: true });
      await server.callTool("plan_block", { ...run, track });
      await server.callTool("plan_block", { ...working, track });
      await settle();
      const easyRun = item("Easy run");
      const guess = item("Working");
      const theirs = item("Dentist");
      expect(guess.guess).toMatchObject({ activity: "working" });

      // Moving a block: Done keeps it with an undo, the track stands, and Kumo is told.
      const moved = await call("PATCH", `/v0/calendar/events/${easyRun.id}`, {
        start: "2026-11-15T12:00:00.000Z",
        end: "2026-11-15T12:30:00.000Z",
      });
      expect(moved).toMatchObject({
        status: 200,
        body: { event: { id: easyRun.id, start: "2026-11-15T12:00:00.000Z", end: "2026-11-15T12:30:00.000Z" } },
      });
      expect(item("Easy run")).toMatchObject({ start: "2026-11-15T12:00:00.000Z", end: "2026-11-15T12:30:00.000Z" });
      const move = done("You moved");
      expect(move).toMatchObject({ text: "You moved “Easy run” to Sun 15 Nov, 12:00–12:30", undo: true });
      expect(move?.track).toBeUndefined();
      expect(await tracks()).toMatchObject([{ id: track, stage: "learning", corrected: 0 }]);
      expect(inMind.get()()).toContain(
        "- Sun 08:00: they moved your “Easy run” from Sun 15 Nov, 10:30–11:00 to Sun 15 Nov, 12:00–12:30",
      );

      // Removing a guess: it was wrong, so it's a correction on its track.
      expect(await call("DELETE", `/v0/calendar/events/${guess.id}`)).toEqual({ status: 204, body: undefined });
      expect(items().map(({ title }) => title)).toEqual(["Easy run", "Dentist"]);
      const removal = done("You removed");
      expect(removal).toMatchObject({ text: "You removed “Working”, Sun 15 Nov, 15:00–18:00", undo: true, track });
      expect(await tracks()).toMatchObject([{ id: track, corrected: 1 }]);
      expect(inMind.get()()).toContain("they removed your guess “Working”, Sun 15 Nov, 15:00–18:00");

      // Their own events, and what isn't there, are refused.
      const refused = await call("PATCH", `/v0/calendar/events/${theirs.id}`, {
        start: "2026-11-15T15:00:00.000Z",
        end: "2026-11-15T15:30:00.000Z",
      });
      expect(refused).toMatchObject({ status: 400, body: { error: { code: "invalid_request" } } });
      expect(JSON.stringify(refused.body)).toContain("That's on your own calendar, so change it in Calendar.");
      expect(await call("DELETE", `/v0/calendar/events/${theirs.id}`)).toMatchObject({ status: 400 });
      expect(await call("DELETE", `/v0/calendar/events/${guess.id}`)).toMatchObject({
        status: 404,
        body: { error: { code: "not_found" } },
      });
      expect(
        await call("PATCH", `/v0/calendar/events/${easyRun.id}`, {
          start: "2026-11-15T13:00:00.000Z",
          end: "2026-11-15T12:00:00.000Z",
        }),
      ).toMatchObject({ status: 400, body: { error: { message: "A block ends after it starts, within 12 hours." } } });
      expect(item("Dentist")).toMatchObject({ start: "2026-11-15T14:00:00.000Z" });

      // Undo puts the guess back as it was, and Kumo is no longer told of it.
      expect(await call("POST", `/v0/done/${removal?.id ?? ""}/undo`)).toMatchObject({ status: 200 });
      await settle();
      expect(item("Working")).toMatchObject({
        uid: guess.uid,
        start: guess.start,
        end: guess.end,
        guess: { activity: "working" },
      });
      expect(inMind.get()()).not.toContain("they removed your guess");
      expect(await call("POST", `/v0/done/${move?.id ?? ""}/undo`)).toMatchObject({ status: 200 });
      await settle();
      expect(item("Easy run")).toMatchObject({ start: "2026-11-15T10:30:00.000Z", end: "2026-11-15T11:00:00.000Z" });
      expect(inMind.get()()).not.toContain("<your_blocks>");

      // Changes to Kumo's own calendar never wake it as a change to theirs.
      await server.calendar.refresh();
      await settle();
      expect(prompts.get()).toEqual([]);
    } finally {
      await server.close();
      await caldav.close();
      await carddav.close();
    }
  });
});
