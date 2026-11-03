import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createCell } from "#cell.ts";
import { createScriptEngine } from "#engine/scripted/script-engine.ts";
import { hashToken, tokenSetting } from "#http/auth.ts";
import { wordEmbedder } from "#memory/embedder.ts";
import type { Track, Work } from "#protocol/types.ts";
import { ok } from "#result.ts";
import { createServer, type EngineContext } from "#server.ts";
import { createVirtualClock } from "./support/virtual-clock.ts";

const home = mkdtempSync(path.join(os.tmpdir(), "ito-tracks-"));
const token = "ito_tracks_test_not_a_real_token_00000000000000000000000";

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

const open = async () => {
  const clock = createVirtualClock(Date.parse("2026-11-12T10:00:00.000Z"));
  const context = createCell<EngineContext | undefined>(undefined);
  const prompts = createCell<readonly string[]>([]);
  const server = createServer({
    embedder: wordEmbedder,
    dataDirectory: mkdtempSync(path.join(home, "server-")),
    name: "tracks",
    clock,
    timeZone: "UTC",
    createEngine: (given) => {
      context.set(given);
      return createScriptEngine(
        clock,
        () => {
          throw new Error("This test starts no turns.");
        },
        undefined,
        undefined,
        undefined,
        (prompt) => {
          prompts.update((current) => [...current, prompt]);
          return Promise.resolve(ok("Noted on How to help you."));
        },
      );
    },
  });
  server.store.setSetting(tokenSetting, hashToken(token));
  await server.app.listen({ host: "127.0.0.1", port: 0 });
  const tracks = async (): Promise<readonly Track[]> => {
    const response = await server.app.inject({
      method: "GET",
      url: "/v0/work",
      headers: { authorization: `Bearer ${token}` },
    });
    return response.json<Work>().tracks;
  };
  const wrong = (entry: string, text: string) =>
    server.app.inject({
      method: "POST",
      url: `/v0/done/${entry}/wrong`,
      headers: { authorization: `Bearer ${token}` },
      payload: { text },
    });
  const inMind = (): string => context.get()?.inMind() ?? "";
  return { server, clock, tracks, wrong, inMind, prompts };
};

const idIn = (text: string): string => /l_\w+/u.exec(text)?.[0] ?? "";

describe("learning tracks", () => {
  it("open for any area, move by judgement, step back on every correction, and show in Kumo's work", async () => {
    const { server, clock, tracks, wrong, inMind, prompts } = await open();
    try {
      const opened = await server.callTool("open_track", { name: "Writing as you", note: "How you write." });
      const again = await server.callTool("open_track", { name: "writing as YOU" });
      const id = idIn(opened.text);
      clock.moveTo(Date.parse("2026-11-12T11:00:00.000Z"));
      const trusted = await server.callTool("move_track", { track: id, stage: "trusted", why: "A month unchanged" });
      const confirmed = await server.callTool("note_track", {
        track: id,
        kind: "confirmed",
        text: "Sent the Tess draft as I wrote it",
      });
      const unknown = await server.callTool("note_track", { track: "l_none", kind: "confirmed", text: "x" });
      const recorded = await server.callTool("done", { text: "Drafted a reply to Clara", track: id });
      const nowhere = await server.callTool("done", { text: "Drafted a reply to Leo", track: "l_none" });

      expect(opened.text).toMatch(/^Opened l_\w+: Writing as you, at Learning\.$/u);
      expect(again.text).toBe(`Writing as you is already a track, ${id}.`);
      expect(trusted.text).toBe("Writing as you is at trusted now.");
      expect(confirmed.text).toBe("Noted on Writing as you.");
      expect(unknown).toEqual({ text: "There's no such track.", isError: true });
      expect(recorded.isError).toBeUndefined();
      expect(nowhere).toEqual({ text: "There's no track l_none.", isError: true });
      expect(inMind()).toContain(`- Writing as you (${id}): trusted, 1 confirmed, 0 corrected. How you write.`);

      const [entry] = server.store.listDone(undefined, 1).entries;
      expect(entry).toMatchObject({ text: "Drafted a reply to Clara", track: id });
      clock.moveTo(Date.parse("2026-11-12T12:00:00.000Z"));
      const answered = await wrong(entry?.id ?? "", "Too formal for Clara");
      await vi.waitFor(() => {
        expect(prompts.get().at(-1)).toContain(
          "It was part of your Writing as you track, which has stepped back for it.",
        );
      });
      await server.callTool("note_track", { track: id, kind: "corrected", text: "Wrong sign-off for Mira" });
      await server.callTool("note_track", { track: id, kind: "corrected", text: "Too long for Leo" });

      expect(answered.statusCode).toBe(200);
      expect(await tracks()).toMatchObject([
        {
          id,
          name: "Writing as you",
          stage: "learning",
          since: "2026-11-12T12:00:00.000Z",
          confirmed: 1,
          corrected: 3,
          evidence: [
            { kind: "corrected", text: "Too long for Leo", stage: "learning" },
            { kind: "corrected", text: "Wrong sign-off for Mira", stage: "learning" },
            {
              kind: "corrected",
              text: "You said “Drafted a reply to Clara” was wrong: Too formal for Clara",
              stage: "spot_checks",
              done: entry?.id,
            },
            { kind: "confirmed", text: "Sent the Tess draft as I wrote it" },
            { kind: "moved", text: "A month unchanged", stage: "trusted" },
          ],
        },
      ]);
    } finally {
      await server.close();
    }
  });

  it("send a correction without a track to Kumo, to note on the right one", async () => {
    const { server, wrong, prompts, tracks } = await open();
    try {
      await server.callTool("open_track", { name: "Sorting mail" });
      await server.callTool("done", { text: "Binned a mail from Acme" });
      const [entry] = server.store.listDone(undefined, 1).entries;
      await wrong(entry?.id ?? "", "That was my order");
      await vi.waitFor(() => {
        expect(prompts.get().at(-1)).toContain(
          "If it was part of an area you're learning, note the correction on that track with note_track.",
        );
      });
      expect(await tracks()).toMatchObject([{ name: "Sorting mail", stage: "learning", corrected: 0 }]);
    } finally {
      await server.close();
    }
  });
});

describe("Kumo's line on the Desk", () => {
  it("sets a short line with a mood, changes it, and clears it, without a message", async () => {
    const { server, clock, inMind } = await open();
    try {
      const set = await server.callTool("set_desk_line", { text: "Quiet morning.", mood: "Focused" });
      const line = server.store.desk().line;
      const long = await server.callTool("set_desk_line", { text: "x".repeat(141), mood: "calm" });
      const twoWords = await server.callTool("set_desk_line", { text: "Hi.", mood: "very calm" });
      clock.moveTo(Date.parse("2026-11-12T12:30:00.000Z"));
      await server.callTool("set_desk_line", { text: "The deck is done.", mood: "proud" });
      const changed = server.store.desk().line;
      const mind = inMind();
      const cleared = await server.callTool("set_desk_line", { text: "", mood: "calm" });

      expect(set.text).toBe("It's at the top of their Desk.");
      expect(line).toEqual({ text: "Quiet morning.", mood: "focused", at: "2026-11-12T10:00:00.000Z" });
      expect(long.isError).toBe(true);
      expect(twoWords.isError).toBe(true);
      expect(changed).toEqual({ text: "The deck is done.", mood: "proud", at: "2026-11-12T12:30:00.000Z" });
      expect(mind).toContain("Your line on their Desk, set 2026-11-12T12:30:00.000Z: “The deck is done.” (proud)");
      expect(cleared.text).toBe("Cleared your line.");
      expect(server.store.desk().line).toBeUndefined();
      expect(server.store.snapshot("no_cursor").event.messages).toEqual([]);
    } finally {
      await server.close();
    }
  });
});
