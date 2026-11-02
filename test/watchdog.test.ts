import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCell } from "#cell.ts";
import type { EngineEvent } from "#engine/engine.ts";
import { createScriptEngine } from "#engine/scripted/script-engine.ts";
import { hashToken, tokenSetting } from "#http/auth.ts";
import { wordEmbedder } from "#memory/embedder.ts";
import { createServer } from "#server.ts";
import { createVirtualClock } from "./support/virtual-clock.ts";

const minuteMs = 60_000;
const token = "ito_watchdog_test_not_a_real_token_00000000000000000000";
const directory = mkdtempSync(path.join(os.tmpdir(), "ito-watchdog-"));
const clock = createVirtualClock(Date.parse("2026-11-01T04:10:00.000Z"));

// "[[compact 4]]" compacts for four minutes, with nothing to show, before it answers.
const compactingFor = (text: string): number => Number(/\[\[compact (?<minutes>\d+)\]\]/u.exec(text)?.groups?.minutes);

const server = createServer({
  embedder: wordEmbedder,
  dataDirectory: directory,
  name: "studio",
  clock,
  createEngine: () =>
    createScriptEngine(clock, (_turn, inputs, now) => {
      const doneAt = now + compactingFor(inputs.map(({ text }) => text).join(" ")) * minuteMs;
      const events: readonly { readonly at: number; readonly event: EngineEvent }[] = [
        { at: now + 100, event: { type: "step.started", key: "compact", kind: "compacting", facts: {} } },
        { at: doneAt, event: { type: "step.ended", key: "compact", outcome: "completed", facts: {} } },
        { at: doneAt + 100, event: { type: "text.started", kind: "reply" } },
        { at: doneAt + 200, event: { type: "text", text: "Hi." } },
        { at: doneAt + 300, event: { type: "text.ended" } },
        { at: doneAt + 400, event: { type: "ended" } },
      ];
      return { events, steer: () => ({ outcome: "refused" }), stoppedAt: (at) => at };
    }),
});

server.store.setSetting(tokenSetting, hashToken(token));

// What the last turn to fail said went wrong.
const failures = createCell<readonly string[]>([]);
server.store.subscribe(({ event }) => {
  if (event.type === "turn.ended" && event.error)
    failures.update((current) => [...current, event.error?.message ?? ""]);
});

const settle = async (): Promise<void> => {
  await new Promise((resolve) => setImmediate(resolve));
};

// Runs the virtual clock, one timer at a time, until something is true, letting the server's own
// async work run in between; it gives up once nothing has happened for a while.
const runUntil = async (isDone: () => boolean, idle = 0): Promise<void> => {
  if (isDone() || idle > 20) return;
  const ran = clock.runNext(Number.MAX_SAFE_INTEGER);
  await settle();
  await runUntil(isDone, ran ? 0 : idle + 1);
};

// Sends a message, then runs the clock until its turn ends, and gives how it ended.
const send = async (text: string): Promise<string | undefined> => {
  const posted = await server.app.inject({
    method: "POST",
    url: "/v0/messages",
    headers: { authorization: `Bearer ${token}` },
    payload: { id: crypto.randomUUID(), text },
  });
  expect(posted.statusCode).toBe(201);
  await runUntil(() => server.store.runningTurn() !== undefined);
  const turn = server.store.runningTurn()?.id;
  if (turn === undefined) return undefined;
  await runUntil(() => server.store.findTurn(turn)?.outcome !== undefined);
  return server.store.findTurn(turn)?.outcome;
};

describe("the turn watchdog", () => {
  beforeAll(async () => {
    await server.app.listen({ host: "127.0.0.1", port: 0 });
  });

  afterAll(async () => {
    await server.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("waits out a long compaction, which has no progress to show", async () => {
    expect(await send("[[compact 4]] Hi")).toBe("completed");
  });

  it("still fails a compaction that never ends, saying how long it waited", async () => {
    expect(await send("[[compact 30]] Hi")).toBe("failed");
    expect(failures.get().at(-1)).toBe("The model didn't respond for 10 minutes.");
  });
});
