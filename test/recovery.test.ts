import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { toTimestamp } from "#clock.ts";
import { createScriptEngine } from "#engine/scripted/script-engine.ts";
import { hashToken, tokenSetting } from "#http/auth.ts";
import { createServer, type Server } from "#server.ts";
import type { LoggedEvent } from "#store/projection.ts";
import { openEventStream } from "./support/event-stream.ts";
import { createVirtualClock } from "./support/virtual-clock.ts";
import { wordEmbedder } from "#memory/embedder.ts";

const token = "ito_recovery_test_not_a_real_token_00000000000000000";
const directory = mkdtempSync(path.join(os.tmpdir(), "ito-recovery-"));
const clock = createVirtualClock(Date.parse("2026-10-12T08:41:00.000Z"));
const asked = toTimestamp(clock.now() - 4000);
const question = randomUUID();

const given: readonly LoggedEvent[] = [
  {
    id: "e_cut_off_1",
    type: "message.accepted",
    at: asked,
    message: { id: question, role: "user", text: "Plan my Saturday.", at: asked, position: 1 },
  },
  { id: "e_cut_off_2", type: "turn.started", at: asked, turn: "t_cut_off", inputs: [question] },
  {
    id: "e_cut_off_3",
    type: "step.started",
    at: asked,
    step: {
      id: "s_cut_off",
      turn: "t_cut_off",
      kind: "thinking",
      title: "Thinking it through",
      at: asked,
      position: 3,
    },
  },
  {
    id: "e_cut_off_4",
    type: "turn.status",
    at: asked,
    turn: "t_cut_off",
    kind: "thinking",
    label: "Thinking it through",
  },
];

const openServer = (): Server =>
  createServer({
    embedder: wordEmbedder,
    dataDirectory: directory,
    createEngine: () =>
      createScriptEngine(clock, () => {
        throw new Error("This test starts no turns.");
      }),
    name: "studio",
    clock,
  });

describe("restarting after a turn was cut off before it wrote a reply", () => {
  afterAll(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it("ends its running step and leaves an empty reply, all marked interrupted", async () => {
    const seeding = openServer();
    seeding.store.importEvents(given);
    seeding.store.setSetting(tokenSetting, hashToken(token));
    await seeding.close();

    const server = openServer();
    const origin = await server.app.listen({ port: 0, host: "127.0.0.1" });
    try {
      const stream = await openEventStream(`${origin}/v0/events`, {
        authorization: `Bearer ${token}`,
        "last-event-id": "e_cut_off_4",
      });
      const events = [
        await stream.next(2000),
        await stream.next(2000),
        await stream.next(2000),
        await stream.next(2000),
      ];
      stream.close();
      const at = toTimestamp(clock.now());
      expect(events).toMatchObject([
        {
          type: "step.ended",
          step: {
            id: "s_cut_off",
            title: "Thinking it through",
            outcome: "interrupted",
            ended_at: at,
            duration_ms: 4000,
          },
        },
        { type: "message.started", message: { role: "agent", kind: "reply", turn: "t_cut_off", text: "", at } },
        { type: "message.ended", outcome: "interrupted", length: 0 },
        { type: "turn.ended", turn: "t_cut_off", outcome: "interrupted" },
      ]);
    } finally {
      await server.close();
    }
  });
});
