import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { systemClock } from "#clock.ts";
import { toMessageId } from "#conversation/ids.ts";
import { demoAnswers, demoScripts, demoWork } from "#engine/scripted/demo.ts";
import { createScriptEngine } from "#engine/scripted/script-engine.ts";
import { wordEmbedder } from "#memory/embedder.ts";
import { toLevel } from "#notifications/manners.ts";
import { toChanges } from "#desk/moments.ts";
import { quoteOf } from "#desk/desk.ts";
import type { CalendarItem } from "#protocol/types.ts";
import { hashToken, tokenSetting } from "#http/auth.ts";
import { createServer } from "#server.ts";

const home = mkdtempSync(path.join(os.tmpdir(), "ito-desk-"));
const token = "ito_desk_test_not_a_real_token_00000000000000000000000";

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

const openDesk = (canWork = true) => {
  const server = createServer({
    dataDirectory: canWork ? home : path.join(home, "idle"),
    name: "desk",
    embedder: wordEmbedder,
    timeZone: "UTC",
    createEngine: ({ callTool }) =>
      createScriptEngine(
        systemClock,
        demoScripts,
        callTool,
        undefined,
        demoAnswers,
        canWork ? demoWork(callTool) : undefined,
      ),
  });
  server.store.setSetting(tokenSetting, hashToken(token));
  const say = async (text: string): Promise<void> => {
    const accepted = server.store.acceptMessage(toMessageId(randomUUID()), text);
    if (!accepted.ok) throw new Error(accepted.failure);
    server.turns.route(toMessageId(accepted.value.message.id), text);
    await vi.waitFor(
      () => {
        const { event } = server.store.snapshot("no_cursor");
        expect(event.messages.at(-1)).toMatchObject({ role: "agent", outcome: "completed" });
        expect(event.turn).toBeNull();
      },
      { timeout: 15_000, interval: 100 },
    );
  };
  const post = (url: string, payload: Readonly<Record<string, unknown>>) =>
    server.app.inject({ method: "POST", url, headers: { authorization: `Bearer ${token}` }, payload });
  const answer = async (title: string, body: Readonly<Record<string, unknown>>) => {
    const card = server.store.desk().waiting.find((waiting) => waiting.title === title);
    return server.app.inject({
      method: "POST",
      url: `/v0/desk/cards/${card?.id ?? "none"}/answer`,
      headers: { authorization: `Bearer ${token}` },
      payload: body,
    });
  };
  return { server, say, answer, post };
};

const item = (uid: string, start: string, kumo = false): CalendarItem => ({
  id: `v_${uid}`,
  uid,
  title: uid,
  start,
  end: start,
  all_day: false,
  calendar: { name: kumo ? "Kumo" : "Home", kumo },
});

describe("the Desk", () => {
  it("takes Kumo's cards, answers them through the box, and counts what Kumo handled", async () => {
    const { server, say, answer } = openDesk();
    await server.app.listen({ host: "127.0.0.1", port: 0 });
    try {
      await say("Fill the desk");
      const wrong = await answer("Binned a Revolut mail", { option: "Maybe" });
      const right = await answer("Binned a Revolut mail", { option: "Right" });
      const offered = await answer("Italian practice?", { option: "Yes" });

      expect(wrong.statusCode).toBe(400);
      expect(right.statusCode).toBe(202);
      expect(right.json()).toMatchObject({
        card: { title: "Binned a Revolut mail", state: "working", answer: { option: "Right" } },
      });
      expect(offered.statusCode).toBe(202);
      await vi.waitFor(
        () => {
          expect(server.store.desk().waiting).toEqual([]);
        },
        { timeout: 5000, interval: 50 },
      );
      expect(server.store.listDone(undefined, 10).entries.map(({ text, reason }) => [text, reason])).toEqual(
        expect.arrayContaining([
          ["You answered “Binned a Revolut mail”: Right", "Noted; nothing more was needed."],
          ["You answered “Italian practice?”: Yes", "Noted; nothing more was needed."],
        ]),
      );
      expect(server.store.desk().handled).toBe(2);
    } finally {
      await server.close();
    }
  });

  it("writes Kumo's line for the moment, which is read on the Desk and answered like a card", async () => {
    const { server, say, post } = openDesk();
    await server.app.listen({ host: "127.0.0.1", port: 0 });
    try {
      await say("Write your moment");
      const moment = server.store.desk().moment;
      const message = server.store.snapshot("no_cursor").event.messages.find(({ id }) => id === moment?.message);
      const read = await post(`/v0/desk/moment/${moment?.id ?? "none"}/read`, {});
      const wrong = await post(`/v0/desk/moment/${moment?.id ?? "none"}/answer`, { option: "Maybe" });
      const answered = await post(`/v0/desk/moment/${moment?.id ?? "none"}/answer`, { option: "Ask me tonight" });
      const gone = await post("/v0/desk/moment/o_none/read", {});

      expect(moment).toMatchObject({
        kind: "day",
        text: "Hotel Orto needs a word before Friday; the rest of today can bend around your 2 o'clock.",
        options: [{ label: "Ask me tonight" }],
        allows_text: true,
      });
      expect(message).toMatchObject({ role: "agent", kind: "moment", text: moment?.text });
      expect(read.statusCode).toBe(204);
      expect(wrong.statusCode).toBe(400);
      expect(answered.statusCode).toBe(202);
      expect(answered.json()).toMatchObject({ moment: { state: "working", answer: { option: "Ask me tonight" } } });
      expect(gone.statusCode).toBe(404);
      await vi.waitFor(
        () => {
          expect(server.store.desk().moment).toBeUndefined();
        },
        { timeout: 5000, interval: 50 },
      );
      expect(server.store.listDone(undefined, 1).entries[0]).toMatchObject({
        text: "You answered “Hotel Orto needs a word before Friday”: Ask me tonight",
        reason: "Noted; nothing more was needed.",
      });
      const work = await server.app.inject({
        method: "GET",
        url: "/v0/work",
        headers: { authorization: `Bearer ${token}` },
      });
      expect(work.json()).toMatchObject({
        handled: expect.arrayContaining([
          expect.objectContaining({ text: "You answered “Hotel Orto needs a word before Friday”: Ask me tonight" }),
        ]) as unknown,
        cleared: [],
      });
    } finally {
      await server.close();
    }
  });

  it("quotes Kumo's line in Done by its first sentence, cut at a word when it's long", () => {
    expect(quoteOf("Maya wants to hear how Monday went. Tell me, and I'll draft it.")).toBe(
      "Maya wants to hear how Monday went",
    );
    expect(quoteOf("How did the call go?")).toBe("How did the call go?");
    expect(quoteOf(`${"word ".repeat(20)}end.`)).toBe(`${"word ".repeat(11).trim()}…`);
  });

  it("notices a change to what's left of today on your own calendars", () => {
    const now = Date.parse("2026-11-11T12:00:00.000Z");
    const before = [item("Climbing", "2026-11-11T19:00:00.000Z"), item("Prep", "2026-11-11T17:00:00.000Z", true)];
    const after = [
      item("Climbing", "2026-11-11T20:00:00.000Z"),
      item("Prep", "2026-11-11T18:00:00.000Z", true),
      item("Dentist", "2026-11-12T09:00:00.000Z"),
      item("Lunch", "2026-11-11T09:00:00.000Z"),
    ];

    expect(toChanges(before, after, now, "UTC")).toEqual(["Moved: Climbing, now Wed 20:00"]);
    expect(toChanges(after, before, now, "UTC")).toEqual(["Moved: Climbing, now Wed 19:00"]);
    expect(toChanges([], [item("Call", "2026-11-11T15:00:00.000Z")], now, "UTC")).toEqual([
      "New today: Wed 15:00 Call",
    ]);
  });

  it("puts a card back, with why in Done, when Kumo couldn't act on the answer", async () => {
    const { server, say, answer } = openDesk(false);
    await server.app.listen({ host: "127.0.0.1", port: 0 });
    try {
      await say("Fill the desk");
      const card = server.store.desk().waiting.find(({ title }) => title === "Binned a Revolut mail");
      const answered = await answer("Binned a Revolut mail", { option: "Right" });

      expect(answered.statusCode).toBe(202);
      await vi.waitFor(
        () => {
          expect(server.store.desk().waiting.find(({ title }) => title === "Binned a Revolut mail")).toMatchObject({
            id: card?.id,
            at: card?.at,
            changed_at: expect.any(String) as unknown,
            kind: "question",
            options: [{ label: "Right", acts: true }, { label: "Keep it" }],
          });
          expect(server.store.listDone(undefined, 10).entries[0]).toMatchObject({
            text: "Couldn't act on your answer to “Binned a Revolut mail”; it's back on your Desk",
            reason: "The scripted engine does no background work.",
          });
        },
        { timeout: 5000, interval: 50 },
      );
      expect(server.store.desk().waiting.find(({ title }) => title === "Binned a Revolut mail")?.state).toBeUndefined();
    } finally {
      await server.close();
    }
  });

  it("keeps notifications quiet by the shared manners", () => {
    const now = Date.parse("2026-11-11T12:00:00.000Z");
    const moment = { now, lastSounded: undefined, localHour: 12, isBusy: false } as const;

    expect(toLevel({ ...moment, wanted: "active" })).toBe("active");
    expect(toLevel({ ...moment, wanted: "active", lastSounded: now - 20 * 60 * 1000 })).toBe("passive");
    expect(toLevel({ ...moment, wanted: "active", localHour: 23 })).toBe("passive");
    expect(toLevel({ ...moment, wanted: "active", isBusy: true })).toBe("passive");
    expect(toLevel({ ...moment, wanted: "time-sensitive", localHour: 3, isBusy: true })).toBe("time-sensitive");
  });
});
