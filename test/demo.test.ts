import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setImmediate as yieldToIo } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { createCell } from "#cell.ts";
import { toMessageId, toTurnId } from "#conversation/ids.ts";
import type { EngineEvent } from "#engine/engine.ts";
import { demoScripts } from "#engine/scripted/demo.ts";
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

  it("asks a question, an approval or a secret on its keywords, then ends the turn", async () => {
    const asked = await runToEnd("Please ask me something");
    expect(asked.slice(-2)).toMatchObject([
      { type: "ask", fields: { kind: "question", question: "Which Juno did you mean?" } },
      { type: "ended" },
    ]);
    const approval = await runToEnd("approve this");
    expect(approval.at(-2)).toMatchObject({ type: "ask", fields: { kind: "approval" } });
    const secret = await runToEnd("a secret");
    expect(secret.at(-2)).toMatchObject({ type: "ask", fields: { secret: true } });
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

describe("the demo engine's memory", () => {
  it("writes Alex's page, moves the old state to Earlier the second time, and recalls it", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "ito-demo-memory-"));
    const server = createServer({
      dataDirectory: home,
      name: "demo",
      embedder: wordEmbedder,
      timeZone: "UTC",
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
      return server.store
        .snapshot("no_cursor")
        .event.steps.filter(({ id, kind }) => kind === "memory" && !before.has(id));
    };

    try {
      const first = await send("remember Alex");
      const second = await send("remember Alex again");
      const recalled = await send("recall Alex");
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
      await server.close();
      rmSync(home, { recursive: true, force: true });
    }
  });
});
