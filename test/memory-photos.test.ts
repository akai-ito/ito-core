import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterAll, describe, expect, it } from "vitest";
import { createCell } from "#cell.ts";
import { createScriptEngine } from "#engine/scripted/script-engine.ts";
import { hashToken, tokenSetting } from "#http/auth.ts";
import { wordEmbedder } from "#memory/embedder.ts";
import { createServer, type Server } from "#server.ts";
import { createVirtualClock } from "./support/virtual-clock.ts";

const home = mkdtempSync(path.join(os.tmpdir(), "ito-memory-photos-"));
const token = "ito_memory_photos_test_not_a_real_token_0000000000000000";
const authorization = `Bearer ${token}`;
const servers = createCell<readonly Server[]>([]);

afterAll(async () => {
  await Promise.all(servers.get().map((server) => server.close()));
  rmSync(home, { recursive: true, force: true });
});

type Opened = { readonly server: Server; readonly directory: string };

const open = (): Opened => {
  const directory = mkdtempSync(path.join(home, "server-"));
  const clock = createVirtualClock(Date.parse("2026-11-03T18:30:00.000Z"));
  const server = createServer({
    embedder: wordEmbedder,
    dataDirectory: directory,
    name: "photos",
    clock,
    timeZone: "Europe/London",
    createEngine: () =>
      createScriptEngine(clock, () => {
        throw new Error("This test starts no turns.");
      }),
  });
  server.store.setSetting(tokenSetting, hashToken(token));
  servers.update((current) => [...current, server]);
  return { server, directory };
};

// A made-up photo, taken sideways: 3000 by 2000 as stored, upright only once its orientation is applied.
const sidewaysPhoto = async (): Promise<Buffer> =>
  sharp({ create: { width: 3000, height: 2000, channels: 3, background: { r: 40, g: 90, b: 140 } } })
    .jpeg()
    .withMetadata({ orientation: 6 })
    .withExif({ IFD0: { Artist: "Mira Example" } })
    .toBuffer();

const upload = (directory: string, name: string, bytes: Buffer | string): void => {
  mkdirSync(path.join(directory, "workspace", "uploads"), { recursive: true });
  writeFileSync(path.join(directory, "workspace", "uploads", name), bytes);
};

const get = (server: Server, url: string) => server.app.inject({ method: "GET", url, headers: { authorization } });

const git = (directory: string, ...arguments_: readonly string[]): string =>
  execFileSync("git", ["-C", path.join(directory, "thread"), ...arguments_], { encoding: "utf8" });

const today = "memory:journal/2026-11-03";

describe("photos in memory", () => {
  it("keep a shared photo with today's journal entry, upright, scaled down and without its metadata", async () => {
    const { server, directory } = open();
    upload(directory, "photo.jpg", await sidewaysPhoto());

    const added = await server.callTool("journal", {
      text: "A long walk by the river.\n\n![Mira by the river at dusk](uploads/photo.jpg)",
      gist: "A walk by the river",
      note: "The river walk",
    });
    const page = server.memory.page(today);
    const name = /\.\.\/media\/(?<name>[\da-f]{16}\.jpg)/u.exec(page.ok ? page.value.markdown : "")?.groups?.name;
    const kept = readFileSync(path.join(directory, "thread", "media", name ?? "missing"));
    const metadata = await sharp(kept).metadata();
    const answer = await get(server, `/v0/memory/page?address=${today}`);
    const media = await get(server, `/v0/memory/media/${name ?? ""}`);

    expect(added).toEqual({ text: "Added to today's journal, with its photo." });
    expect(page.ok && page.value.markdown).toContain(
      `A long walk by the river.\n\n![Mira by the river at dusk](../media/${name ?? ""})`,
    );
    expect(page.ok && page.value.photos).toEqual([
      { source: `../media/${name ?? ""}`, name, width: 1333, height: 2000 },
    ]);
    expect(metadata).toMatchObject({ format: "jpeg", width: 1333, height: 2000 });
    expect(metadata.exif).toBeUndefined();
    expect(metadata.orientation).toBeUndefined();
    expect(git(directory, "ls-files", "media")).toBe(`media/${name ?? ""}\n`);
    expect(git(directory, "show", "--stat", "--format=%s", "HEAD")).toContain("journal/2026-11-03.md");
    expect(answer.json()).toMatchObject({ photos: [{ name, width: 1333, height: 2000 }] });
    expect(media.statusCode).toBe(200);
    expect(media.headers).toMatchObject({
      "content-type": "image/jpeg",
      "cache-control": "private, max-age=31536000, immutable",
    });
    expect(media.rawPayload.equals(kept)).toBe(true);
  });

  it("keep one copy of a photo put on a page and on an earlier day", async () => {
    const { server, directory } = open();
    upload(directory, "photo.jpg", await sidewaysPhoto());
    await server.callTool("journal", { text: "Home early.", gist: "Home early", note: "Home early" });
    const read = await server.callTool("read_page", { address: today });
    const version = /version (?<version>\w+)/u.exec(read.text)?.groups?.version;

    const written = await server.callTool("write_page", {
      address: "memory:people/mira",
      title: "Mira",
      gist: "Your oldest friend",
      circle: "friends",
      note: "Oldest friend",
      body: "Your oldest friend (as of 3 Nov).\n\n![Mira by the river](<uploads/photo.jpg>)",
    });
    const edited = await server.callTool("edit_page", {
      address: today,
      version,
      old_text: "Home early.",
      new_text: "Home early, after the river.\n\n![Mira by the river](uploads/photo.jpg)",
      note: "The river photo",
    });
    const mira = server.memory.page("memory:people/mira");
    const day = server.memory.page(today);

    expect(written.text).toMatch(/^Saved Mira, with its photo, at version \w+\.$/u);
    expect(edited.text).toMatch(/^Saved 3 November 2026, with its photo, now at version \w+\.$/u);
    expect(git(directory, "ls-files", "media").trim().split("\n")).toHaveLength(1);
    expect(mira.ok && mira.value.photos?.map(({ name }) => name)).toEqual(
      day.ok && day.value.photos?.map(({ name }) => name),
    );
    expect(mira.ok && mira.value.markdown).toMatch(/!\[Mira by the river\]\(\.\.\/media\/[\da-f]{16}\.jpg\)/u);
  });

  it("refuse what they can't keep, and save nothing", async () => {
    const { server, directory } = open();
    upload(directory, "notes.txt", "Not a photo.");
    const journal = (text: string) => server.callTool("journal", { text, gist: "A day", note: "A note" });

    const missing = await journal("![Leo](uploads/missing.jpg)");
    const outside = await journal("![The Thread](../thread/.git/HEAD)");
    const text = await journal("![Notes](uploads/notes.txt)");
    const absent = await journal("![Leo](../media/0123456789abcdef.jpg)");

    expect(missing).toEqual({ text: "There's no uploads/missing.jpg in your workspace.", isError: true });
    expect(outside).toEqual({
      text: "../thread/.git/HEAD isn't in your workspace, so it can't go on a page.",
      isError: true,
    });
    expect(text.isError).toBe(true);
    expect(text.text).toMatch(/^uploads\/notes\.txt couldn't be read as a photo, so nothing was saved: /u);
    expect(absent).toEqual({ text: "There's no photo ../media/0123456789abcdef.jpg in memory.", isError: true });
    expect(server.memory.page(today).ok).toBe(false);
  });

  it("leave a picture on the web as it is, and keep sources out of recall", async () => {
    const { server, directory } = open();
    upload(directory, "photo.jpg", await sidewaysPhoto());

    await server.callTool("journal", {
      text: "![The harbour at Piran](https://example.com/piran.jpg)\n\n![Mira on the harbour wall](uploads/photo.jpg)",
      gist: "Piran",
      note: "Piran",
    });
    const page = server.memory.page(today);
    const recalled = await server.callTool("recall", { query: "harbour wall" });

    expect(page.ok && page.value.markdown).toContain("![The harbour at Piran](https://example.com/piran.jpg)");
    expect(page.ok && page.value.photos).toHaveLength(1);
    expect(recalled.text).toContain("Mira on the harbour wall");
    expect(recalled.text).not.toContain("media/");
  });

  it("serve only photos in memory", async () => {
    const { server } = open();
    await server.memory.ready;

    const unknown = await get(server, "/v0/memory/media/0123456789abcdef.jpg");
    const page = await get(server, "/v0/memory/media/portrait.md");
    const climbing = await get(server, "/v0/memory/media/..%2Fportrait.jpg");
    const unauthorized = await server.app.inject({ method: "GET", url: "/v0/memory/media/0123456789abcdef.jpg" });

    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toMatchObject({ error: { code: "not_found" } });
    expect(page.statusCode).toBe(400);
    expect(climbing.statusCode).toBe(400);
    expect(unauthorized.statusCode).toBe(401);
  });
});
