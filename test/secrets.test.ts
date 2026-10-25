import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setImmediate as yieldToIo } from "node:timers/promises";
import { afterAll, describe, expect, it } from "vitest";
import { redaction } from "#conversation/secrets.ts";
import { toTurnId } from "#conversation/ids.ts";
import type { EngineEvent } from "#engine/engine.ts";
import { createScriptEngine, type TimedEvent } from "#engine/scripted/script-engine.ts";
import { hashToken, tokenSetting } from "#http/auth.ts";
import { createServer } from "#server.ts";
import { createVirtualClock } from "./support/virtual-clock.ts";
import { wordEmbedder } from "#memory/embedder.ts";

const token = "ito_secrets_test_not_a_real_token_0000000000000000000";
const directory = mkdtempSync(path.join(os.tmpdir(), "ito-secrets-"));
const clock = createVirtualClock(Date.parse("2026-10-15T16:00:00.000Z"));

const echo = (now: number, text: string): readonly TimedEvent[] => {
  const middle = Math.floor(text.length / 2);
  const events: readonly EngineEvent[] = [
    { type: "step.started", key: "search", kind: "web_search", facts: { query: text } },
    { type: "step.ended", key: "search", outcome: "completed", facts: { query: text } },
    { type: "text.started", kind: "reply" },
    { type: "text", text: `Your code ${text.slice(0, middle)}` },
    { type: "text", text: `${text.slice(middle)} is set.` },
    { type: "text.ended" },
    { type: "ended" },
  ];
  return events.map((event, index) => ({ at: now + (index + 1) * 100, event }));
};

const server = createServer({
  embedder: wordEmbedder,
  dataDirectory: directory,
  createEngine: () =>
    createScriptEngine(clock, (_turn, inputs, now) => ({
      events: echo(now, inputs.map((input) => input.text).join(" ")),
      steer: () => ({ outcome: "refused" }),
      stoppedAt: (requestedAt) => requestedAt,
    })),
  name: "studio",
  clock,
});

const runTimers = async (until: number): Promise<void> => {
  if (!clock.runNext(until)) return;
  await yieldToIo();
  await runTimers(until);
};

describe("a secret answer", () => {
  afterAll(async () => {
    await server.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("never reaches the log, even when the agent repeats it in a step or a reply split across pieces", async () => {
    server.store.setSetting(tokenSetting, hashToken(token));
    const ask = server.store.startAsk(toTurnId("t_earlier"), {
      kind: "question",
      question: "Juno texted you a 6-digit code. What is it?",
      options: [],
      allows_text: true,
      secret: true,
    });
    const sent = await server.app.inject({
      method: "POST",
      url: "/v0/messages",
      headers: { authorization: `Bearer ${token}` },
      payload: { id: randomUUID(), text: "481516", answers: ask.id },
    });
    expect(sent.statusCode).toBe(201);
    await yieldToIo();
    await runTimers(clock.now() + 10_000);
    const everything = JSON.stringify(server.store.snapshot("no_cursor"));
    expect(everything).not.toContain("481516");
    expect(everything).toContain(`Your code ${redaction} is set.`);
    expect(everything).toContain(`Searched the web for ${redaction}`);
  });
});
