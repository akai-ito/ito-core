import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCell } from "#cell.ts";
import { toTurnId, type TurnId } from "#conversation/ids.ts";
import type { Engine, EngineEvent } from "#engine/engine.ts";
import { createScriptEngine } from "#engine/scripted/script-engine.ts";
import { hashToken, tokenSetting } from "#http/auth.ts";
import { wordEmbedder } from "#memory/embedder.ts";
import type { Status } from "#protocol/types.ts";
import { createServer } from "#server.ts";
import { createVirtualClock } from "./support/virtual-clock.ts";

const minuteMs = 60_000;
const token = "ito_long_turns_test_not_a_real_token_000000000000000000";
const directory = mkdtempSync(path.join(os.tmpdir(), "ito-long-turns-"));
const clock = createVirtualClock(Date.parse("2026-11-01T04:10:00.000Z"));

// "[[quiet 30]]" thinks, then shows nothing for thirty minutes before it answers, as Codex does while a long tool
// call's arguments stream. "[[compact 30]]" compacts for thirty minutes first. "[[reconnect]]" loses the model's
// stream and gets it back. "[[stuck]]" never answers, and an engine that stopped answering ignores Stop too.
const minutesIn = (text: string, marker: string): number =>
  Number(new RegExp(String.raw`\[\[${marker} (?<minutes>\d+)\]\]`, "u").exec(text)?.groups?.minutes ?? 0);

const answering = (at: number): readonly { readonly at: number; readonly event: EngineEvent }[] => [
  { at: at + 100, event: { type: "text.started", kind: "reply" } },
  { at: at + 200, event: { type: "text", text: "Here it is." } },
  { at: at + 300, event: { type: "text.ended" } },
  { at: at + 400, event: { type: "ended" } },
];

const scriptFor = (text: string, now: number): readonly { readonly at: number; readonly event: EngineEvent }[] => {
  if (text.includes("[[stuck]]")) {
    return [{ at: now + 100, event: { type: "step.started", key: "think", kind: "thinking", facts: {} } }];
  }
  if (text.includes("[[reconnect]]")) {
    return [
      { at: now + 100, event: { type: "reconnecting", detail: "Reconnecting... 1/5" } },
      ...answering(now + 3 * minuteMs),
    ];
  }
  const compacting = minutesIn(text, "compact") * minuteMs;
  if (compacting > 0) {
    return [
      { at: now + 100, event: { type: "step.started", key: "compact", kind: "compacting", facts: {} } },
      { at: now + compacting, event: { type: "step.ended", key: "compact", outcome: "completed", facts: {} } },
      ...answering(now + compacting),
    ];
  }
  const quiet = minutesIn(text, "quiet") * minuteMs;
  return [
    { at: now + 100, event: { type: "step.started", key: "think", kind: "thinking", facts: {} } },
    { at: now + 200, event: { type: "step.ended", key: "think", outcome: "completed", facts: {} } },
    ...answering(now + quiet),
  ];
};

const isStuck = createCell(false);

const scripted = createScriptEngine(clock, (_turn, inputs, now) => {
  const text = inputs.map((input) => input.text).join(" ");
  isStuck.set(text.includes("[[stuck]]"));
  return { events: scriptFor(text, now), steer: () => ({ outcome: "refused" }), stoppedAt: (at) => at };
});

// An engine that stopped answering: interrupting it and restarting it never finish.
const never = (): Promise<void> =>
  new Promise(() => {
    // It never settles.
  });

const engine: Engine = {
  ...scripted,
  interrupt: (turn) => (isStuck.get() ? never() : scripted.interrupt(turn)),
  restart: () => (isStuck.get() ? never() : scripted.restart()),
};

const server = createServer({
  embedder: wordEmbedder,
  dataDirectory: directory,
  name: "studio",
  clock,
  createEngine: () => engine,
});

server.store.setSetting(tokenSetting, hashToken(token));

const failures = createCell<readonly string[]>([]);
const statuses = createCell<readonly Status[]>([]);
server.store.subscribe(({ event }) => {
  if (event.type === "turn.ended" && event.error) {
    failures.update((current) => [...current, event.error?.message ?? ""]);
  }
  if (event.type !== "turn.status") return;
  const { kind, label, detail } = event;
  statuses.update((current) => [...current, { kind, label, ...(detail !== undefined && { detail }) }]);
});

const settle = async (): Promise<void> => {
  await new Promise((resolve) => setImmediate(resolve));
};

// Runs the virtual clock, one timer at a time, until something is true or the clock reaches `until`, letting the
// server's own async work run in between; it gives up once nothing has happened for a while.
const runUntil = async (isDone: () => boolean, until = Number.MAX_SAFE_INTEGER, idle = 0): Promise<void> => {
  if (isDone() || idle > 20) return;
  const ran = clock.runNext(until);
  await settle();
  await runUntil(isDone, until, ran ? 0 : idle + 1);
};

const send = async (text: string): Promise<TurnId> => {
  const posted = await server.app.inject({
    method: "POST",
    url: "/v0/messages",
    headers: { authorization: `Bearer ${token}` },
    payload: { id: crypto.randomUUID(), text },
  });
  expect(posted.statusCode).toBe(201);
  await runUntil(() => server.store.runningTurn() !== undefined);
  return server.store.runningTurn()?.id ?? toTurnId("");
};

const outcomeOf = (turn: TurnId): string | undefined => server.store.findTurn(turn)?.outcome;

// Sends a message, then runs the clock until its turn ends, and gives how it ended.
const sendAndFinish = async (text: string): Promise<string | undefined> => {
  const turn = await send(text);
  await runUntil(() => outcomeOf(turn) !== undefined);
  return outcomeOf(turn);
};

describe("a long turn in the chat", () => {
  beforeAll(async () => {
    await server.app.listen({ host: "127.0.0.1", port: 0 });
  });

  afterAll(async () => {
    await server.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("is never failed for being quiet: it runs until it answers", async () => {
    expect(await sendAndFinish("[[quiet 45]] Write the whole itinerary into a document")).toBe("completed");
    expect(failures.get()).toEqual([]);
  });

  it("waits out a compaction however long it takes", async () => {
    expect(await sendAndFinish("[[compact 30]] Hi")).toBe("completed");
    expect(failures.get()).toEqual([]);
  });

  it("says it's reconnecting when the model's stream drops, and goes on", async () => {
    expect(await sendAndFinish("[[reconnect]] Plan Saturday")).toBe("completed");
    expect(statuses.get()).toContainEqual({ kind: "waiting", label: "Reconnecting to the model" });
    expect(failures.get()).toEqual([]);
  });

  it("stops when you say, even when the engine no longer answers", async () => {
    const turn = await send("[[stuck]] Sort out my pension letters");
    await runUntil(() => false, clock.now() + 20 * minuteMs);
    expect(outcomeOf(turn)).toBeUndefined();

    const stoppedAt = clock.now();
    const stopped = await server.app.inject({
      method: "POST",
      url: `/v0/turns/${turn}/stop`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(stopped.statusCode).toBe(202);
    await runUntil(() => outcomeOf(turn) !== undefined);

    expect(outcomeOf(turn)).toBe("stopped");
    expect(clock.now() - stoppedAt).toBeLessThanOrEqual(5000);
    isStuck.set(false);
    expect(await sendAndFinish("[[quiet 1]] And now?")).toBe("completed");
  });
});
