import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createCell } from "#cell.ts";
import { systemClock } from "#clock.ts";
import { toMessageId } from "#conversation/ids.ts";
import { createScriptEngine, type ScriptSource } from "#engine/scripted/script-engine.ts";
import { hashToken, tokenSetting } from "#http/auth.ts";
import { wordEmbedder } from "#memory/embedder.ts";
import { blocksIn, toPlan, toTickNote, withoutBlocks } from "#replies/blocks.ts";
import { fixtureDirectory } from "#protocol/tools/transcript-files.ts";
import { createServer } from "#server.ts";
import { createSentenceFeed } from "#voice/spoken.ts";

const plan = {
  title: "Florence",
  items: [
    { id: "book-flights", text: "Book flights", done: false },
    { id: "pack", text: "Pack", done: true },
  ],
};

const reply = [
  "Here's the plan.",
  "",
  "```ari:place",
  JSON.stringify({ name: "Uffizi Gallery" }),
  "```",
  "",
  "```ari:plan",
  JSON.stringify(plan),
  "```",
  "",
  "Enjoy it.",
].join("\n");

const home = mkdtempSync(path.join(os.tmpdir(), "ito-replies-"));

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("blocks in a reply", () => {
  it("finds each block and its plan, and leaves them out of what's said aloud", () => {
    const feed = createSentenceFeed();
    const halfway = reply.slice(0, reply.indexOf('"Book flights"'));

    expect(blocksIn(reply).map(({ kind }) => kind)).toEqual(["place", "plan"]);
    expect(toPlan(blocksIn(reply)[1])).toEqual(plan);
    expect(toPlan(blocksIn(reply)[0])).toBeUndefined();
    expect(withoutBlocks(reply)).toBe("Here's the plan.\n\nEnjoy it.");
    expect(withoutBlocks(halfway)).toBe("Here's the plan.");
    expect([...feed(halfway, false), ...feed(reply, true)]).toEqual(["Here's the plan.", "Enjoy it."]);
  });

  it("tells the agent what was ticked, in a line", () => {
    expect(toTickNote([])).toBe("");
    expect(
      toTickNote([
        { plan: "Florence", item: "Book flights", done: true },
        { plan: "Florence", item: "Pack", done: false },
      ]),
    ).toBe("(Since your last reply, they ticked “Book flights” in Florence and unticked “Pack” in Florence.)");
  });
});

describe("ticking a plan", () => {
  it("keeps the latest tick of each item, and tells the agent once, with the next message", async () => {
    const token = "ito_replies_test_not_a_real_token_00000000000000000000";
    const inputs = createCell<readonly string[]>([]);
    const scripts: ScriptSource = (_turn, given, now) => {
      inputs.update((current) => [...current, given.map(({ text }) => text).join("\n")]);
      return {
        events: [
          { at: now + 5, event: { type: "text.started", kind: "reply" } },
          { at: now + 10, event: { type: "text", text: reply } },
          { at: now + 15, event: { type: "text.ended" } },
          { at: now + 20, event: { type: "ended" } },
        ],
        steer: () => ({ outcome: "refused" }),
        stoppedAt: (at) => at,
      };
    };
    const server = createServer({
      dataDirectory: home,
      name: "replies",
      embedder: wordEmbedder,
      timeZone: "UTC",
      createEngine: () => createScriptEngine(systemClock, scripts),
    });
    server.store.setSetting(tokenSetting, hashToken(token));
    const send = async (text: string): Promise<void> => {
      const id = toMessageId(randomUUID());
      server.store.acceptMessage(id, text);
      server.turns.route(id, text);
      await vi.waitFor(() => {
        const { messages, turn } = server.store.snapshot("no_cursor").event;
        expect(messages.at(-1)).toMatchObject({ role: "agent", outcome: "completed" });
        expect(turn).toBeNull();
      });
    };
    const tick = async (message: string, part: number, item: string, done: boolean) =>
      server.app.inject({
        method: "PUT",
        url: `/v0/messages/${message}/parts/${String(part)}/items/${item}`,
        headers: { authorization: `Bearer ${token}` },
        payload: { done },
      });

    await send("Plan Florence");
    const { messages } = server.store.snapshot("no_cursor").event;
    const planned = messages.find((message) => message.role === "agent")?.id ?? "";
    const asked = messages.find((message) => message.role === "user")?.id ?? "";
    const ticked = await tick(planned, 1, "book-flights", true);
    const unticked = await tick(planned, 1, "pack", false);
    const again = await tick(planned, 1, "pack", false);
    const notAPlan = await tick(planned, 0, "book-flights", true);
    const yours = await tick(asked, 1, "pack", true);
    await send("Thanks");
    await send("And now?");
    await server.close();

    expect(ticked.json()).toEqual({ ticks: [{ part: 1, item: "book-flights", done: true }] });
    expect(again.json()).toEqual(unticked.json());
    expect(notAPlan.statusCode).toBe(404);
    expect(yours.statusCode).toBe(400);
    expect(inputs.get()).toEqual([
      "Plan Florence",
      "(Since your last reply, they ticked “Book flights” in Florence and unticked “Pack” in Florence.)\n\nThanks",
      "And now?",
    ]);
  });
});

describe("keeping a picture", () => {
  it("keeps a picture from the web past the sweep of unsent uploads, and refuses a page", async () => {
    const photo = readFileSync(path.join(fixtureDirectory, "riverside.jpg"));
    const server = createServer({
      dataDirectory: mkdtempSync(path.join(home, "pictures-")),
      name: "pictures",
      embedder: wordEmbedder,
      timeZone: "UTC",
      createEngine: () =>
        createScriptEngine(systemClock, () => ({
          events: [],
          steer: () => ({ outcome: "refused" }),
          stoppedAt: (at) => at,
        })),
      fetchImage: (url) =>
        Promise.resolve(
          url.endsWith(".jpg")
            ? new Response(new Uint8Array(photo), { headers: { "Content-Type": "image/jpeg" } })
            : new Response("<html></html>", { headers: { "Content-Type": "text/html; charset=utf-8" } }),
        ),
    });

    const page = await server.callTool("keep_image", { url: "https://photos.example.org/lungarno" });
    const kept = await server.callTool("keep_image", { url: "https://photos.example.org/lungarno-dusk.jpg" });
    const id = String(kept.structured?.attachment);
    server.attachments.sweep(new Date(Date.now() + 60_000).toISOString());
    const found = server.attachments.find(id);
    await server.close();

    expect(page).toEqual({ text: "That's text/html, not a JPEG, PNG, GIF or WebP picture.", isError: true });
    expect(found).toMatchObject({ kind: "image", name: "lungarno-dusk.jpg", media_type: "image/jpeg" });
  });
});
