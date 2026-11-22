import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setImmediate as yieldToIo } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { createCell } from "#cell.ts";
import { toMessageId, toTurnId } from "#conversation/ids.ts";
import type { EngineEvent } from "#engine/engine.ts";
import { demoScripts, withDemoPictures } from "#engine/scripted/demo.ts";
import { createScriptEngine } from "#engine/scripted/script-engine.ts";
import { systemClock } from "#clock.ts";
import { wordEmbedder } from "#memory/embedder.ts";
import type { Step } from "#protocol/types.ts";
import { createServer } from "#server.ts";
import { createVirtualClock } from "./support/virtual-clock.ts";

const turn = toTurnId("t_demo");

const runToEnd = async (
  text: string,
  steers: readonly { readonly at: number; readonly text: string }[] = [],
): Promise<readonly EngineEvent[]> => {
  const clock = createVirtualClock(0);
  const engine = createScriptEngine(clock, demoScripts);
  const seen = createCell<readonly EngineEvent[]>([]);
  const events = engine.start(turn, [{ messageId: toMessageId("u_demo"), text }]);
  const consumed = (async () => {
    for await (const event of events) seen.set([...seen.get(), event]);
  })();
  for (const steer of steers) {
    clock.moveTo(steer.at);
    await engine.steer(turn, { messageId: toMessageId(`u_${steer.text}`), text: steer.text });
  }
  const advance = async (): Promise<void> => {
    if (!clock.runNext(Number.MAX_SAFE_INTEGER)) return;
    await yieldToIo();
    await advance();
  };
  await advance();
  await consumed;
  return seen.get();
};

const replies = (events: readonly EngineEvent[]): readonly string[] =>
  events.reduce<readonly string[]>((texts, event) => {
    if (event.type === "text.started") return [...texts, ""];
    return event.type === "text" ? [...texts.slice(0, -1), `${texts.at(-1) ?? ""}${event.text}`] : texts;
  }, []);

type StepStarted = Extract<EngineEvent, { readonly type: "step.started" }>;

describe("the demo engine", () => {
  it("answers two quick steers one after the other, never interleaved", async () => {
    const events = await runToEnd("Plan my Saturday", [
      { at: 3000, text: "Stop" },
      { at: 3100, text: "Or don't" },
    ]);
    expect(replies(events).slice(-2)).toEqual(["Got it: Stop", "Got it: Or don't"]);
    expect(events.at(-1)).toEqual({ type: "ended" });
  });

  it("leaves a steered word that does something to a turn of its own, and takes anything else", () => {
    const script = demoScripts(turn, [{ messageId: toMessageId("u_demo"), text: "hello" }], 0);

    expect(script.steer({ messageId: toMessageId("u_trip"), text: "Start a trip" }, 100)).toEqual({
      outcome: "refused",
    });
    expect(script.steer({ messageId: toMessageId("u_more"), text: "make it shorter" }, 200).outcome).toBe("taken");
  });

  it("asks a question or an approval on its keywords, then ends the turn", async () => {
    const asked = await runToEnd("Please ask me something");
    expect(asked.slice(-2)).toMatchObject([
      { type: "ask", fields: { kind: "question", question: "Which Juno did you mean?" } },
      { type: "ended" },
    ]);
    const approval = await runToEnd("approve this");
    expect(approval.at(-2)).toMatchObject({ type: "ask", fields: { kind: "approval" } });
    const busy = await runToEnd("a busy task");
    expect(busy.some((event) => event.type === "ask")).toBe(false);
  });

  it("says which photos and files it was sent", async () => {
    const clock = createVirtualClock(0);
    const engine = createScriptEngine(clock, demoScripts);
    const events = engine.start(turn, [
      {
        messageId: toMessageId("u_photo"),
        text: "",
        attachments: [
          { kind: "image", name: "riverside.jpg", source: "/tmp/riverside.jpg" },
          { kind: "file", name: "running-log.csv", source: "/tmp/running-log.csv" },
        ],
      },
    ]);
    const seen = createCell<readonly EngineEvent[]>([]);
    const consumed = (async () => {
      for await (const event of events) seen.set([...seen.get(), event]);
    })();
    const advance = async (): Promise<void> => {
      if (!clock.runNext(Number.MAX_SAFE_INTEGER)) return;
      await yieldToIo();
      await advance();
    };
    await advance();
    await consumed;
    expect(replies(seen.get()).at(-1)).toMatch(
      /^I can see riverside\.jpg \(a photo\) and running-log\.csv \(a file\)\./u,
    );
  });

  it("walks a trail of steps when asked to be busy", async () => {
    const events = await runToEnd("Be busy for me");
    const kinds = events
      .filter((event): event is StepStarted => event.type === "step.started")
      .map((event) => event.kind);
    expect(kinds).toEqual(["thinking", "web_search", "plan", "command", "command", "tool", "wait", "file_change"]);
    expect(events).toContainEqual(
      expect.objectContaining({ type: "step.ended", key: "search", outcome: "completed", facts: { exit_code: 1 } }),
    );
  });
});

const openDemo = async (): Promise<{
  readonly server: ReturnType<typeof createServer>;
  readonly send: (text: string) => Promise<readonly Step[]>;
  readonly close: () => Promise<void>;
}> => {
  const home = mkdtempSync(path.join(os.tmpdir(), "ito-demo-"));
  const server = createServer({
    dataDirectory: home,
    name: "demo",
    embedder: wordEmbedder,
    timeZone: "UTC",
    fetch: withDemoPictures(fetch),
    createEngine: ({ callTool }) => createScriptEngine(systemClock, demoScripts, callTool),
  });
  await server.memory.ready;
  const send = async (text: string): Promise<readonly Step[]> => {
    const before = new Set(server.store.snapshot("no_cursor").event.steps.map(({ id }) => id));
    const accepted = server.store.acceptMessage(toMessageId(randomUUID()), text);
    if (!accepted.ok) throw new Error(accepted.failure);
    server.turns.route(toMessageId(accepted.value.message.id), text);
    await vi.waitFor(
      () => {
        const { messages, turn } = server.store.snapshot("no_cursor").event;
        expect(messages.at(-1)).toMatchObject({ role: "agent", outcome: "completed" });
        expect(turn).toBeNull();
      },
      { timeout: 15_000, interval: 100 },
    );
    return server.store.snapshot("no_cursor").event.steps.filter(({ id }) => !before.has(id));
  };
  return {
    server,
    send,
    close: async () => {
      await server.close();
      rmSync(home, { recursive: true, force: true });
    },
  };
};

describe("the demo engine's memory", () => {
  it("writes Alex's page, moves the old state to Earlier the second time, and recalls it", async () => {
    const { server, send, close } = await openDemo();
    const memorySteps = async (text: string): Promise<readonly Step[]> => {
      const steps = await send(text);
      return steps.filter(({ kind }) => kind === "memory");
    };

    try {
      const first = await memorySteps("remember Alex");
      const second = await memorySteps("remember Alex again");
      const recalled = await memorySteps("recall Alex");
      const change = await server.memory.change(second.find(({ action }) => action === "updated")?.change ?? "");

      expect(first.map(({ title }) => title)).toEqual(["Updated Alex", "Added to today's journal"]);
      expect(second.map(({ title }) => title)).toEqual(["Used Alex", "Updated Alex", "Added to today's journal"]);
      expect(recalled).toMatchObject([
        {
          action: "used",
          pages: expect.arrayContaining([{ address: "memory:people/alex", title: "Alex" }]) as unknown,
        },
      ]);
      expect(change?.after).toContain("## Earlier");
    } finally {
      await close();
    }
  });
});

describe("the demo engine's things in motion", () => {
  it("starts the Florence trip and the training block, and books the Uffizi", async () => {
    const { server, send, close } = await openDemo();

    try {
      await send("start a trip");
      await send("start my training");
      await send("I booked it");

      // The act can outlast the reply on a busy machine.
      await vi.waitFor(
        () => {
          expect(
            server.store.listMotions().map(({ id, version, status, summary }) => ({ id, version, status, summary })),
          ).toEqual([
            {
              id: "florence-with-mira",
              version: 2,
              status: "active",
              summary: expect.stringMatching(/^\d+(?: \w+)?–\d+ \w+ · 3 to book$/u) as unknown,
            },
            { id: "sub-20-5k", version: 1, status: "active", summary: "Week 6 of 10 · intervals today" },
          ]);
        },
        { timeout: 15_000, interval: 100 },
      );
      expect(server.store.findMotion("florence-with-mira")?.cover).toMatch(/^f_/u);
      // A week or two from now, so it's still to come rather than over and in History.
      const detail = await server.motions.detail("florence-with-mira");
      if (!detail.ok) throw new Error(detail.failure.detail);
      const starts = Date.parse((detail.value.content.dates as { readonly start: string }).start);
      expect(starts).toBeGreaterThan(Date.now());
      expect(starts).toBeLessThan(Date.now() + 15 * 24 * 60 * 60 * 1000);
      expect(new Date(starts).getUTCDay()).toBe(5);
    } finally {
      await close();
    }
  });

  it("starts the trip from a word sent while another turn is still going, as a turn of its own", async () => {
    const { server, close } = await openDemo();

    try {
      for (const text of ["show me motion", "Start a trip page for Florence with Mira"]) {
        const accepted = server.store.acceptMessage(toMessageId(randomUUID()), text);
        if (!accepted.ok) throw new Error(accepted.failure);
        server.turns.route(toMessageId(accepted.value.message.id), text);
      }

      await vi.waitFor(
        () => {
          expect(server.store.findMotion("florence-with-mira")?.status).toBe("active");
        },
        { timeout: 30_000, interval: 100 },
      );
      const replies = server.store
        .latestMessages(20)
        .filter(({ role }) => role === "agent")
        .map(({ text }) => text);
      expect(replies.some((text) => text.startsWith("Got it"))).toBe(false);
    } finally {
      await close();
    }
  });

  it("fills In motion with every kind, loudest first, and a goal that ended unmet", async () => {
    const { server, send, close } = await openDemo();

    try {
      await send("show me motion");
      // The act outlasts the reply: seven tool calls, each a commit.
      await vi.waitFor(
        () => {
          expect(server.store.findMotion("spring-5k")?.status).toBe("done");
        },
        { timeout: 20_000, interval: 100 },
      );

      expect(
        server.store
          .listMotions()
          .map(({ id, kind, status, salience, outcome }) => ({ id, kind, status, salience, outcome }))
          .toSorted((a, b) => a.id.localeCompare(b.id)),
      ).toEqual([
        { id: "halcyon-labs", kind: "career", status: "active", salience: "quiet", outcome: undefined },
        { id: "hybrid-restart", kind: "body", status: "active", salience: "loud", outcome: undefined },
        { id: "ito-lived-in", kind: "project", status: "active", salience: "normal", outcome: undefined },
        { id: "northwind", kind: "career", status: "active", salience: "loud", outcome: undefined },
        { id: "quillmoor", kind: "career", status: "active", salience: "normal", outcome: undefined },
        { id: "spring-5k", kind: "body", status: "done", salience: "normal", outcome: "not_met" },
      ]);
    } finally {
      await close();
    }
  });
});

describe("the demo engine's replies that show", () => {
  it("answers a menu with shape, makes a guide page, and shows action cards", async () => {
    const { server, send, close } = await openDemo();

    try {
      await send("what's good on this menu?");
      await send("make me a guide for the gallery");
      await send("show me the cards");

      const posts = server.store
        .latestMessages(20)
        .filter(({ role }) => role === "agent")
        .map(({ text }) => text);
      expect(posts.some((text) => text.includes("```ari:picks") && text.includes("```ari:table"))).toBe(true);
      expect(posts.some((text) => text.includes('```ari:made\n{"made":"gallery-guide"}'))).toBe(true);
      const cards = posts.flatMap((text) => text.matchAll(/```ari:desk\n\{"card":"(?<card>[^"]*)"\}/gu).toArray());
      expect(cards.map((match) => match.groups?.card)).toEqual([
        expect.stringMatching(/^k_/u),
        expect.stringMatching(/^k_/u),
      ]);
      expect(server.store.findMade("gallery-guide")).toMatchObject({
        version: 1,
        summary: "3 rooms · 4 things to spot",
      });
    } finally {
      await close();
    }
  });
});
