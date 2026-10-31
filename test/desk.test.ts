import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { systemClock } from "#clock.ts";
import { toMessageId } from "#conversation/ids.ts";
import { demoAnswers, demoScripts } from "#engine/scripted/demo.ts";
import { createScriptEngine } from "#engine/scripted/script-engine.ts";
import { wordEmbedder } from "#memory/embedder.ts";
import { toLevel } from "#notifications/manners.ts";
import { hashToken, tokenSetting } from "#http/auth.ts";
import { createServer } from "#server.ts";

const home = mkdtempSync(path.join(os.tmpdir(), "ito-desk-"));
const token = "ito_desk_test_not_a_real_token_00000000000000000000000";

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

const openDesk = () => {
  const server = createServer({
    dataDirectory: home,
    name: "desk",
    embedder: wordEmbedder,
    timeZone: "UTC",
    createEngine: ({ callTool }) => createScriptEngine(systemClock, demoScripts, callTool, undefined, demoAnswers),
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
  const answer = async (title: string, body: Readonly<Record<string, unknown>>) => {
    const card = server.store.desk().waiting.find((waiting) => waiting.title === title);
    return server.app.inject({
      method: "POST",
      url: `/v0/desk/cards/${card?.id ?? "none"}/answer`,
      headers: { authorization: `Bearer ${token}` },
      payload: body,
    });
  };
  return { server, say, answer };
};

describe("the Desk", () => {
  it("takes Kumo's cards, answers them through the box, and writes the briefing", async () => {
    const { server, say, answer } = openDesk();
    await server.app.listen({ host: "127.0.0.1", port: 0 });
    try {
      await say("Fill the desk");
      const wrong = await answer("Binned a Revolut mail", { option: "Maybe" });
      const right = await answer("Binned a Revolut mail", { option: "Right" });
      const offered = await answer("Italian practice?", { option: "Yes" });
      await say("Write my briefing");

      expect(wrong.statusCode).toBe(400);
      expect(right.statusCode).toBe(202);
      expect(right.json()).toMatchObject({ card: { title: "Binned a Revolut mail", state: "working" } });
      expect(offered.statusCode).toBe(202);
      await vi.waitFor(
        () => {
          expect(server.store.desk().waiting).toEqual([]);
        },
        { timeout: 5000, interval: 50 },
      );
      expect(server.store.desk().briefing).toMatchObject({
        kind: "morning",
        handled: 9,
        lines: [
          { text: "Poppy sent the Teams link for Thursday; it's on the event." },
          { text: "Body: easy 30 minutes or rest; big afternoon." },
        ],
      });
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
