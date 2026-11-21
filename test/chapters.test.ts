import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterAll, describe, expect, it } from "vitest";
import { createCell } from "#cell.ts";
import { createScriptEngine } from "#engine/scripted/script-engine.ts";
import { hashToken, tokenSetting } from "#http/auth.ts";
import { randomIdentifiers } from "#identifiers.ts";
import { wordEmbedder } from "#memory/embedder.ts";
import { createMemory, type Memory } from "#memory/memory.ts";
import { createServer, type Server } from "#server.ts";
import { openDatabase } from "#store/database.ts";
import { createMemoryStore } from "#store/memory.ts";
import { createStore } from "#store/store.ts";
import { createVirtualClock, type VirtualClock } from "./support/virtual-clock.ts";

const home = mkdtempSync(path.join(os.tmpdir(), "ito-chapters-"));
const token = "ito_chapters_test_not_a_real_token_00000000000000000000";
const authorization = `Bearer ${token}`;
const servers = createCell<readonly Server[]>([]);
const memories = createCell<readonly Memory[]>([]);

afterAll(async () => {
  await Promise.all([...servers.get(), ...memories.get()].map((opened) => opened.close()));
  rmSync(home, { recursive: true, force: true });
});

type Opened = { readonly server: Server; readonly directory: string; readonly clock: VirtualClock };

// 9 November 2026, in the evening in London.
const open = (): Opened => {
  const directory = mkdtempSync(path.join(home, "server-"));
  const clock = createVirtualClock(Date.parse("2026-11-09T19:30:00.000Z"));
  const server = createServer({
    embedder: wordEmbedder,
    dataDirectory: directory,
    name: "chapters",
    clock,
    timeZone: "Europe/London",
    createEngine: () =>
      createScriptEngine(clock, () => {
        throw new Error("This test starts no turns.");
      }),
  });
  server.store.setSetting(tokenSetting, hashToken(token));
  servers.update((current) => [...current, server]);
  return { server, directory, clock };
};

const get = async (server: Server, url: string): Promise<unknown> => {
  const answer = await server.app.inject({ method: "GET", url, headers: { authorization } });
  return answer.json();
};

const upload = async (directory: string, name: string): Promise<void> => {
  mkdirSync(path.join(directory, "workspace", "uploads"), { recursive: true });
  const photo = await sharp({ create: { width: 800, height: 600, channels: 3, background: { r: 90, g: 80, b: 60 } } })
    .jpeg()
    .toBuffer();
  writeFileSync(path.join(directory, "workspace", "uploads", name), photo);
};

const versionOf = async (server: Server, address: string): Promise<string> => {
  const read = await server.callTool("read_page", { address });
  return /version (?<version>\w+)/u.exec(read.text)?.groups?.version ?? "";
};

const git = (directory: string, ...arguments_: readonly string[]): string =>
  execFileSync("git", ["-C", path.join(directory, "thread"), ...arguments_], { encoding: "utf8" });

const florence = "memory:chapters/florence-with-mira";

describe("chapters", () => {
  it("are pages Kumo writes, noticed the day it writes them, with what they drew on", async () => {
    const { server, directory } = open();
    await upload(directory, "bookshop.jpg");
    await server.callTool("journal", {
      text: "Rain all day, so a bookshop café near Santo Spirito instead.\n\n![Mira in the café](uploads/bookshop.jpg)",
      gist: "Florence: the rainy day",
      note: "The rainy day",
    });
    const day = server.memory.page("memory:journal/2026-11-09");
    const photo = day.ok ? day.value.photos?.[0] : undefined;

    const written = await server.callTool("write_page", {
      address: florence,
      title: "Florence with Mira",
      gist: "Six days in Florence for Mira's birthday",
      note: "Noticed the Florence trip",
      began: "2026-11-04",
      ended: "2026-11-09",
      links: ["memory:journal/2026-11-09", "memory:journal/2026-11-08"],
      body:
        "You'd been promising Mira Florence since spring. Tuesday's rain cancelled everything, and the " +
        `bookshop café turned out the best day.\n\n![Mira in the café](${photo?.source ?? ""})\n\n` +
        "## What changed\n\n- You plan trips with an empty day in them now.\n",
    });
    const chapters = await get(server, "/v0/memory/chapters");
    const page = await get(server, `/v0/memory/page?address=${florence}`);
    const shelves = await get(server, "/v0/memory/shelves");

    expect(written.text).toMatch(/^Saved Florence with Mira, at version \w+\.$/u);
    expect(chapters).toEqual({
      chapters: [
        {
          address: florence,
          title: "Florence with Mira",
          gist: "Six days in Florence for Mira's birthday",
          began: "2026-11-04",
          ended: "2026-11-09",
          cover: photo,
          changed_at: "2026-11-09T19:30:00.000Z",
        },
      ],
    });
    // The 8th was never written, so only the 9th counts, with its one photo, which the chapter shows too.
    expect(page).toMatchObject({
      shelf: "chapters",
      chapter: { began: "2026-11-04", ended: "2026-11-09", noticed: "2026-11-09" },
      photos: [photo],
    });
    expect((page as { chapter: unknown }).chapter).toMatchObject({ drawn_from: { journal_days: 1, photos: 1 } });
    expect(shelves).toEqual({
      shelves: expect.not.arrayContaining([expect.objectContaining({ shelf: "chapters" })]) as unknown,
    });
    expect(git(directory, "show", "HEAD:chapters/florence-with-mira.md")).toContain(
      "  began: 2026-11-04,\n  ended: 2026-11-09,\n  noticed: 2026-11-09,\n",
    );
  });

  it("put those still going first, close when they end and reopen, keeping the day Kumo noticed them", async () => {
    const { server, clock } = open();
    const chapter = (address: string, title: string, dates: Readonly<Record<string, string>>) =>
      server.callTool("write_page", {
        address,
        title,
        gist: title,
        note: title,
        body: `${title}, as a story.`,
        ...dates,
      });
    await chapter("memory:chapters/moving-to-hackney", "Moving to Hackney", {
      began: "2026-06-01",
      ended: "2026-07-31",
    });
    await chapter(florence, "Florence with Mira", { began: "2026-10-04", ended: "2026-10-09" });
    await chapter("memory:chapters/the-november-job-hunt", "The November job hunt", { began: "2026-11-03" });
    clock.moveTo(clock.now() + 60_000);
    await chapter("memory:chapters/back-to-training", "Back to training", { began: "2026-11-09" });
    const titles = async (): Promise<readonly string[]> =>
      ((await get(server, "/v0/memory/chapters")) as { chapters: { title: string }[] }).chapters.map(
        ({ title }) => title,
      );
    const before = await titles();

    clock.moveTo(clock.now() + 2 * 24 * 60 * 60 * 1000);
    const hunt = "memory:chapters/the-november-job-hunt";
    const closed = await server.callTool("edit_page", {
      address: hunt,
      version: await versionOf(server, hunt),
      ended: "2026-11-11",
      note: "The job hunt is over",
    });
    const afterClosing = await titles();
    const reopened = await server.callTool("edit_page", {
      address: hunt,
      version: await versionOf(server, hunt),
      ended: "open",
      note: "Still hunting after all",
    });
    const page = server.memory.page(hunt);

    expect(before).toEqual(["Back to training", "The November job hunt", "Florence with Mira", "Moving to Hackney"]);
    expect(closed.isError).toBeUndefined();
    expect(afterClosing).toEqual([
      "Back to training",
      "The November job hunt",
      "Florence with Mira",
      "Moving to Hackney",
    ]);
    expect(reopened.isError).toBeUndefined();
    expect(page.ok && page.value.chapter).toEqual({
      began: "2026-11-03",
      noticed: "2026-11-09",
      drawn_from: { journal_days: 0, photos: 0 },
    });
  });

  it("need sensible days, and only chapters have them", async () => {
    const { server } = open();
    const write = (input: Readonly<Record<string, string>>) =>
      server.callTool("write_page", { gist: "A page", note: "A page", body: "A story.", title: "A page", ...input });

    expect(await write({ address: florence })).toEqual({
      text: "A chapter needs the day it began, as began: YYYY-MM-DD.",
      isError: true,
    });
    expect(await write({ address: florence, began: "next week" })).toEqual({
      text: "next week isn't a day: give began as YYYY-MM-DD.",
      isError: true,
    });
    expect(await write({ address: florence, began: "2026-02-30" })).toEqual({
      text: "2026-02-30 isn't a day: give began as YYYY-MM-DD.",
      isError: true,
    });
    expect(await write({ address: florence, began: "2026-13-45" })).toEqual({
      text: "2026-13-45 isn't a day: give began as YYYY-MM-DD.",
      isError: true,
    });
    expect(await write({ address: florence, began: "2026-11-20" })).toEqual({
      text: "A chapter is something that's begun: began can't be after today.",
      isError: true,
    });
    expect(await write({ address: florence, began: "2026-11-04", ended: "2026-11-01" })).toEqual({
      text: "A chapter can't end before it began.",
      isError: true,
    });
    expect(await write({ address: "memory:projects/florence", began: "2026-11-04" })).toEqual({
      text: "Only a chapter has began and ended dates: its page is on memory:chapters/….",
      isError: true,
    });
    expect(await get(server, "/v0/memory/chapters")).toEqual({ chapters: [] });
  });
});

describe("what Kumo learnt", () => {
  it("is the lines given with writes, newest first and only a few, never housekeeping, and in the Thread", async () => {
    const { server, directory, clock } = open();
    await server.callTool("write_page", {
      address: "memory:goals/half-marathon",
      title: "Half marathon",
      gist: "A half in March",
      note: "The March half",
      body: "A half marathon in March (as of 9 Nov).",
      learnt: "Half marathons suit you more than 5Ks.",
    });
    for (const [index, learnt] of ["One.", "Two.", "Three.", "Four."].entries()) {
      clock.moveTo(clock.now() + 60_000);
      await server.callTool("journal", { text: `Entry ${String(index)}.`, gist: "A day", note: "An entry", learnt });
    }
    clock.moveTo(clock.now() + 60_000);
    const tidied = await server.callTool("edit_page", {
      address: "memory:goals/half-marathon",
      version: await versionOf(server, "memory:goals/half-marathon"),
      old_text: "(as of 9 Nov)",
      new_text: "(as of 9 November)",
      note: "Reconciled the date format",
    });
    clock.moveTo(clock.now() + 60_000);
    await server.callTool("edit_page", {
      address: "memory:goals/half-marathon",
      version: await versionOf(server, "memory:goals/half-marathon"),
      old_text: "A half marathon in March",
      new_text: "A half marathon in March, paced by feel",
      note: "Pacing by feel",
      learnt: "  You pace best by feel,\nnot by the watch.  ",
    });
    const learnt = (await get(server, "/v0/memory/learnt")) as { lines: { text: string; at: string }[] };

    expect(tidied.isError).toBeUndefined();
    expect(learnt.lines.map(({ text }) => text)).toEqual([
      "You pace best by feel, not by the watch.",
      "Four.",
      "Three.",
      "Two.",
      "One.",
    ]);
    expect(learnt.lines[0]).toEqual({
      text: "You pace best by feel, not by the watch.",
      at: "2026-11-09T19:36:00.000Z",
      address: "memory:goals/half-marathon",
      change: expect.any(String) as unknown,
    });
    expect(git(directory, "log", "-1", "--format=%B")).toBe(
      "Update Half marathon\n\nPacing by feel\n\nLearnt: You pace best by feel, not by the watch.\n\n",
    );
    expect(git(directory, "log", "-1", "--skip=1", "--format=%B")).toBe(
      "Update Half marathon\n\nReconciled the date format\n\n",
    );
  });

  it("never takes a reading of them for something learnt", async () => {
    const { server } = open();

    const reading = await server.callTool("journal", {
      text: "They seemed tired of the job hunt.",
      reading: true,
      gist: "A long day",
      note: "How they seemed",
      learnt: "You're tired of the job hunt.",
    });
    const marked = await server.callTool("journal", {
      text: "A long day of interviews.",
      gist: "A long day",
      note: "Interviews",
      learnt: "My reading: you're tired of it.",
    });

    expect(reading).toEqual({
      text:
        "That's your reading of them, not something you learnt: keep it in the journal with reading: true, and " +
        "leave learnt out.",
      isError: true,
    });
    expect(marked.isError).toBe(true);
    expect(await get(server, "/v0/memory/learnt")).toEqual({ lines: [] });
  });

  it("can be found and taken back, and leaves with a page that's forgotten", async () => {
    const directory = mkdtempSync(path.join(home, "memory-"));
    const database = openDatabase(path.join(directory, "ito.db"));
    const clock = createVirtualClock(Date.parse("2026-11-09T19:30:00.000Z"));
    const memory = createMemory({
      directory: path.join(directory, "thread"),
      store: createMemoryStore(database),
      settings: createStore(database, clock, randomIdentifiers),
      clock,
      identifiers: randomIdentifiers,
      embedder: wordEmbedder,
      recordStep: () => true,
      approve: () => Promise.resolve(true),
      info: () => true,
      timeZone: () => "UTC",
    });
    memories.update((current) => [...current, memory]);
    await memory.ready;
    const call = (name: string, input: unknown) => {
      const tool = memory.tools.find((candidate) => candidate.name === name);
      if (!tool) throw new Error(`No tool ${name}.`);
      return tool.call(input);
    };
    await call("write_page", {
      address: "memory:places/kiln",
      title: "Kiln",
      gist: "Thai in Soho",
      note: "Kiln",
      body: "Thai grill in Soho, your favourite.",
      learnt: "You'd pick Kiln over anywhere for a birthday.",
    });
    clock.moveTo(clock.now() + 60_000);
    await call("write_page", {
      address: "memory:goals/half-marathon",
      title: "Half marathon",
      gist: "A half in March",
      note: "The March half",
      body: "A half marathon in March.",
      learnt: "Half marathons suit you more than 5Ks.",
    });

    const found = await call("find_in_memory", { words: ["half marathons suit"] });
    const nothing = await call("unlearn", { words: ["sourdough"] });
    const taken = await call("unlearn", { words: ["half marathons suit"] });
    const afterTaking = memory.learnt().map(({ text }) => text);
    await call("forget_page", { address: "memory:places/kiln", reason: "Not a favourite after all" });

    expect(found.text).toContain(
      "What you learnt lately says it too; if it's wrong, take it back with unlearn:\n" +
        "  2026-11-09  “Half marathons suit you more than 5Ks.”",
    );
    expect(nothing).toEqual({ text: "Nothing you learnt lately says that." });
    expect(taken).toEqual({ text: "Took back “Half marathons suit you more than 5Ks.”" });
    expect(afterTaking).toEqual(["You'd pick Kiln over anywhere for a birthday."]);
    expect(memory.learnt()).toEqual([]);
  });
});
