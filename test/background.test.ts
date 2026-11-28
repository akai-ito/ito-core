import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setImmediate as yieldToIo } from "node:timers/promises";
import { afterAll, describe, expect, it } from "vitest";
import { createCell } from "#cell.ts";
import type { EngineEvent, WorkFailure, WorkOptions } from "#engine/engine.ts";
import { createScriptEngine } from "#engine/scripted/script-engine.ts";
import { hashToken, tokenSetting } from "#http/auth.ts";
import { wordEmbedder } from "#memory/embedder.ts";
import { lastingMs } from "#problems/problems.ts";
import { fail, ok, type Result } from "#result.ts";
import { createServer, type Server } from "#server.ts";
import { createVirtualClock } from "./support/virtual-clock.ts";

const token = "ito_background_test_not_a_real_token_0000000000000000000";
const home = mkdtempSync(path.join(os.tmpdir(), "ito-background-"));
const minuteMs = 60_000;

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

// What the model does with one piece of background work: it can call tools, show signs of life, and answer; or
// never answer at all.
type Work = (prompt: string, run: string, options: WorkOptions, server: Server) => Promise<Result<string, WorkFailure>>;

const settle = async (rounds = 10): Promise<void> => {
  if (rounds === 0) return;
  await yieldToIo();
  await settle(rounds - 1);
};

const usageLimit: WorkFailure = { code: "usage_limit", detail: "You've hit your usage limit." };

// A turn in the chat: "[[limit]]" reaches the usage limit, anything else is answered.
const chatScript = (text: string, now: number): readonly { readonly at: number; readonly event: EngineEvent }[] =>
  text.includes("[[limit]]")
    ? [{ at: now + 100, event: { type: "failed", code: "usage_limit", detail: usageLimit.detail } }]
    : [
        { at: now + 100, event: { type: "text.started", kind: "reply" } },
        { at: now + 200, event: { type: "text", text: "Hello." } },
        { at: now + 300, event: { type: "text.ended" } },
        { at: now + 400, event: { type: "ended" } },
      ];

const start = "2026-11-02T15:00:00.000Z";

const setUp = () => {
  const clock = createVirtualClock(Date.parse(start));
  const works = createCell<readonly Work[]>([]);
  const prompts = createCell<readonly string[]>([]);
  const resetsAt = createCell<number | undefined>(undefined);
  const live = createCell<Server | undefined>(undefined);
  const server = createServer({
    embedder: wordEmbedder,
    dataDirectory: mkdtempSync(path.join(home, "server-")),
    name: "background",
    clock,
    timeZone: "Europe/London",
    createEngine: () =>
      createScriptEngine(
        clock,
        (_turn, inputs, now) => ({
          events: chatScript(inputs.map(({ text }) => text).join(" "), now),
          steer: () => ({ outcome: "refused" }),
          stoppedAt: (at) => at,
        }),
        undefined,
        undefined,
        undefined,
        async (prompt, run, options = {}) => {
          prompts.update((current) => [...current, prompt]);
          const [next] = works.get();
          works.update((current) => current.slice(1));
          const running = live.get();
          return next && running
            ? next(prompt, run, options, running)
            : fail({ code: "engine_failed", detail: "The test has Kumo do nothing here." });
        },
        () => resetsAt.get(),
      ),
  });
  live.set(server);
  server.store.setSetting(tokenSetting, hashToken(token));
  const runUntil = async (time: number): Promise<void> => {
    if (clock.runNext(time)) {
      await settle();
      await runUntil(time);
      return;
    }
    clock.moveTo(time);
    await settle();
  };
  const send = async (text: string): Promise<void> => {
    const posted = await server.app.inject({
      method: "POST",
      url: "/v0/messages",
      headers: { authorization: `Bearer ${token}` },
      payload: { id: crypto.randomUUID(), text },
    });
    expect(posted.statusCode).toBe(201);
    await runUntil(clock.now() + 1000);
  };
  const plan = (...given: readonly Work[]): void => {
    works.update((current) => [...current, ...given]);
  };
  return { server, clock, runUntil, send, plan, prompts, resetsAt };
};

const posts = (server: Server): readonly string[] =>
  server.store
    .snapshot("no_cursor")
    .event.messages.filter(({ kind }) => kind === "post")
    .map(({ text }) => text);

const technical = {
  title: "Ask how the Halcyon technical went",
  what: "Ask how the Halcyon technical went",
  why: "It ends at 15:30, and they wanted to talk it through while it's fresh.",
  at: "2026-11-02T15:30:00Z",
  asked: true,
  source: { kind: "chat", title: "“Ask me how it went after”" },
};

// Work that never answers, and never shows a sign of life; it notes when it's interrupted.
const silent =
  (interrupted: { readonly set: (value: boolean) => void }): Work =>
  (_prompt, _run, { signal }) => {
    signal?.addEventListener("abort", () => {
      interrupted.set(true);
    });
    return new Promise(() => {
      // It never answers.
    });
  };

describe("Kumo's background work", () => {
  it("is stopped after fifteen silent minutes and tried once more, saying it may have started", async () => {
    const { server, clock, runUntil, plan, prompts } = setUp();
    await server.app.listen({ host: "127.0.0.1", port: 0 });
    try {
      await server.callTool("set_wake_up", technical);
      const interrupted = createCell(false);
      plan(silent(interrupted), async (_prompt, run, _options, current) => {
        await current.callTool("post", { text: "How did the technical go?" }, run);
        return ok("Asked.");
      });

      await runUntil(Date.parse("2026-11-02T15:44:00.000Z"));
      expect(interrupted.get()).toBe(false);
      await runUntil(Date.parse("2026-11-02T15:46:00.000Z"));

      expect(interrupted.get()).toBe(true);
      expect(prompts.get()).toHaveLength(2);
      expect(prompts.get()[1]).toContain("An earlier try at this went quiet");
      expect(posts(server)).toEqual(["How did the technical go?"]);
      expect(server.store.problems()).toEqual([]);
      expect(clock.now()).toBeLessThan(Date.parse("2026-11-02T16:00:00.000Z"));
    } finally {
      await server.close();
    }
  });

  it("keeps going while the model shows signs of life, however long it takes", async () => {
    const { server, runUntil, plan } = setUp();
    await server.app.listen({ host: "127.0.0.1", port: 0 });
    try {
      await server.callTool("set_wake_up", technical);
      const answer = createCell<((done: Result<string, WorkFailure>) => void) | undefined>(undefined);
      const lively = createCell<(() => void) | undefined>(undefined);
      plan(
        (_prompt, _run, { onActivity }) =>
          new Promise((resolve) => {
            lively.set(onActivity);
            answer.set(resolve);
          }),
      );
      const beat = async (minutes: number): Promise<void> => {
        if (minutes <= 0) return;
        await runUntil(Date.parse("2026-11-02T15:30:00.000Z") + (50 - minutes) * minuteMs);
        lively.get()?.();
        await beat(minutes - 10);
      };
      await beat(50);
      answer.get()?.(ok("Nothing needed them."));
      await runUntil(Date.parse("2026-11-02T16:25:00.000Z"));

      expect(server.store.listDone(undefined, 5).entries.map(({ text }) => text)).toEqual([
        "Woke up for “Ask how the Halcyon technical went”",
      ]);
    } finally {
      await server.close();
    }
  });

  it("shows the problem when the second try goes quiet too, and the wake-up waits", async () => {
    const { server, runUntil, plan } = setUp();
    await server.app.listen({ host: "127.0.0.1", port: 0 });
    try {
      await server.callTool("set_wake_up", technical);
      const interrupted = createCell(false);
      plan(silent(interrupted), silent(interrupted));

      await runUntil(Date.parse("2026-11-02T16:00:00.000Z") + lastingMs + minuteMs);

      expect(server.store.problems()).toMatchObject([
        { id: "kumo:work", detail: expect.stringContaining("no sign of life for 15 minutes") as unknown },
      ]);
      expect(server.wakeUps.list()).toMatchObject([{ at: "2026-11-02T16:15:00.000Z" }]);
    } finally {
      await server.close();
    }
  });

  it("pauses when a turn in the chat reaches the usage limit, and catches up once a turn goes through", async () => {
    const { server, runUntil, send, plan, prompts } = setUp();
    await server.app.listen({ host: "127.0.0.1", port: 0 });
    try {
      await server.callTool("set_wake_up", technical);
      await send("[[limit]] What's on tomorrow?");

      // It didn't say when it resets: Kumo looks again in an hour.
      expect(server.store.problems()).toMatchObject([
        { id: "kumo:paused", area: "kumo", title: "Kumo's paused until about 16:00" },
      ]);
      await runUntil(Date.parse("2026-11-02T15:40:00.000Z"));
      expect(prompts.get()).toEqual([]);

      plan(() => Promise.resolve(ok("I was paused for a while and missed asking about the Halcyon technical.")));
      await send("Are you back?");
      await runUntil(Date.parse("2026-11-02T15:41:00.000Z"));

      expect(prompts.get()).toHaveLength(1);
      expect(posts(server)).toEqual(["I was paused for a while and missed asking about the Halcyon technical."]);
      expect(server.store.problems()).toEqual([]);
      expect(server.wakeUps.list()).toEqual([]);
    } finally {
      await server.close();
    }
  });

  it("ends a pause with nothing missed quietly, and pauses again if the limit's still there", async () => {
    const { server, runUntil, plan, prompts, resetsAt } = setUp();
    await server.app.listen({ host: "127.0.0.1", port: 0 });
    try {
      plan(() => {
        resetsAt.set(Date.parse("2026-11-02T17:00:00.000Z"));
        return Promise.resolve(fail(usageLimit));
      });
      await server.background.work("Look at the calendar change", { missed: "Changes on their calendars" });
      expect(server.background.paused()).toMatchObject({ until: Date.parse("2026-11-02T17:00:00.000Z") });

      // The limit turns out to last longer, until the next morning.
      plan(() => {
        resetsAt.set(Date.parse("2026-11-03T09:00:00.000Z"));
        return Promise.resolve(fail(usageLimit));
      });
      await runUntil(Date.parse("2026-11-02T17:01:00.000Z"));

      expect(prompts.get()).toHaveLength(2);
      expect(prompts.get()[1]).toContain("- Changes on their calendars");
      expect(server.store.problems()).toMatchObject([{ title: "Kumo's paused until Tue 3 Nov, 09:00" }]);
      expect(posts(server)).toEqual([]);

      plan(() => Promise.resolve(ok("While I was paused, your calendar moved; I've kept up with it.")));
      await runUntil(Date.parse("2026-11-03T09:01:00.000Z"));

      expect(posts(server)).toEqual(["While I was paused, your calendar moved; I've kept up with it."]);
      expect(server.background.paused()).toBeUndefined();
    } finally {
      await server.close();
    }
  });
});
