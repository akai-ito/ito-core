import { setImmediate as yieldToIo } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { createCell } from "#cell.ts";
import { toMessageId, toTurnId } from "#conversation/ids.ts";
import type { EngineEvent } from "#engine/engine.ts";
import { demoScripts } from "#engine/scripted/demo.ts";
import { createScriptEngine } from "#engine/scripted/script-engine.ts";
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
