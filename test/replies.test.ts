import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { systemClock } from "#clock.ts";
import { createScriptEngine } from "#engine/scripted/script-engine.ts";
import { wordEmbedder } from "#memory/embedder.ts";
import { withoutBlocks } from "#replies/blocks.ts";
import { fixtureDirectory } from "#protocol/tools/transcript-files.ts";
import { createServer } from "#server.ts";
import { createSentenceFeed } from "#voice/spoken.ts";

const reply = [
  "Here's the plan.",
  "",
  "```ari:place",
  JSON.stringify({ name: "Uffizi Gallery" }),
  "```",
  "",
  "```ari:choices",
  JSON.stringify({ options: ["Book it", "Find somewhere cheaper"] }),
  "```",
  "",
  "Enjoy it.",
].join("\n");

const home = mkdtempSync(path.join(os.tmpdir(), "ito-replies-"));

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("blocks in a reply", () => {
  it("leaves them out of what's said aloud, even before a block is finished", () => {
    const feed = createSentenceFeed();
    const halfway = reply.slice(0, reply.indexOf('"Book it"'));

    expect(withoutBlocks(reply)).toBe("Here's the plan.\n\nEnjoy it.");
    expect(withoutBlocks(halfway)).toBe("Here's the plan.");
    expect([...feed(halfway, false), ...feed(reply, true)]).toEqual(["Here's the plan.", "Enjoy it."]);
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
      fetch: (url) =>
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
