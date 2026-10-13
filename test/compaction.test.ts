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

const dayMs = 24 * 60 * 60 * 1000;
const token = "ito_compaction_test_not_a_real_token_000000000000000";
const directory = mkdtempSync(path.join(os.tmpdir(), "ito-compaction-"));
const clock = createVirtualClock(Date.parse("2026-10-12T08:41:00.000Z"));
const longAgo = toTimestamp(clock.now() - 31 * dayMs);
const question = randomUUID();

const given: readonly LoggedEvent[] = [
  {
    id: "e_long_ago_1",
    type: "message.accepted",
    at: longAgo,
    message: { id: question, role: "user", text: "Fix the bike or buy a new one?", at: longAgo },
  },
  { id: "e_long_ago_2", type: "turn.started", at: longAgo, turn: "t_long_ago", inputs: [question] },
  {
    id: "e_long_ago_3",
    type: "message.started",
    at: longAgo,
    message: { id: "m_long_ago", role: "agent", kind: "reply", turn: "t_long_ago", text: "", at: longAgo },
  },
  { id: "e_long_ago_4", type: "message.delta", at: longAgo, message: "m_long_ago", offset: 0, text: "Fix it." },
  { id: "e_long_ago_5", type: "message.ended", at: longAgo, message: "m_long_ago", outcome: "completed", length: 7 },
  { id: "e_long_ago_6", type: "turn.ended", at: longAgo, turn: "t_long_ago", outcome: "completed" },
];

const openServer = (): Server =>
  createServer({
    dataDirectory: directory,
    createEngine: () =>
      createScriptEngine(clock, () => {
        throw new Error("This test starts no turns.");
      }),
    name: "studio",
    clock,
  });

describe("text compaction", () => {
  afterAll(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it("sends a snapshot to a cursor older than the compacted text, and replays newer ones", async () => {
    const seeding = openServer();
    seeding.store.importEvents(given);
    seeding.store.setSetting(tokenSetting, hashToken(token));
    await seeding.close();

    const server = openServer();
    const origin = await server.app.listen({ port: 0, host: "127.0.0.1" });
    const headers = { authorization: `Bearer ${token}` };
    try {
      const behind = await openEventStream(`${origin}/v0/events`, { ...headers, "last-event-id": "e_long_ago_2" });
      const snapshot = await behind.next(2000);
      behind.close();
      expect(snapshot).toMatchObject({ type: "snapshot", reason: "too_far_behind", id: "e_long_ago_6" });
      expect(snapshot).toHaveProperty("messages.1", expect.objectContaining({ id: "m_long_ago", text: "Fix it." }));

      const current = await openEventStream(`${origin}/v0/events`, { ...headers, "last-event-id": "e_long_ago_6" });
      const nothing = await current.next(300);
      current.close();
      expect(nothing).toBeUndefined();
    } finally {
      await server.close();
    }
  });
});
