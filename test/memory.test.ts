import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { createCell } from "#cell.ts";
import type { StepFacts } from "#engine/engine.ts";
import { randomIdentifiers } from "#identifiers.ts";
import { wordEmbedder } from "#memory/embedder.ts";
import { createMemory, type Memory, type MemoryOptions } from "#memory/memory.ts";
import { openThread } from "#memory/thread.ts";
import { openDatabase } from "#store/database.ts";
import { createMemoryStore } from "#store/memory.ts";
import { createStore } from "#store/store.ts";
import { createVirtualClock, type VirtualClock } from "./support/virtual-clock.ts";

const home = mkdtempSync(path.join(os.tmpdir(), "ito-memory-"));
const memories = createCell<readonly Memory[]>([]);

type Opened = {
  readonly memory: Memory;
  readonly clock: VirtualClock;
  readonly directory: string;
  readonly steps: () => readonly StepFacts[];
};

const openMemory = async (approve: MemoryOptions["approve"] = () => Promise.resolve(true)): Promise<Opened> => {
  const directory = mkdtempSync(path.join(home, "home-"));
  const database = openDatabase(path.join(directory, "ito.db"));
  const clock = createVirtualClock(Date.parse("2026-10-26T19:00:00.000Z"));
  const steps = createCell<readonly StepFacts[]>([]);
  const memory = createMemory({
    directory: path.join(directory, "thread"),
    store: createMemoryStore(database),
    settings: createStore(database, clock, randomIdentifiers),
    clock,
    identifiers: randomIdentifiers,
    embedder: wordEmbedder,
    recordStep: (facts) => {
      steps.update((current) => [...current, facts]);
      return true;
    },
    approve,
    info: () => true,
    timeZone: "UTC",
  });
  memories.update((current) => [...current, memory]);
  await memory.ready;
  return { memory, clock, directory, steps: () => steps.get() };
};

const call = async (memory: Memory, name: string, input: unknown): Promise<{ text: string; isError?: boolean }> => {
  const tool = memory.tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`No tool ${name}.`);
  return tool.call(input);
};

const write = async (memory: Memory, input: Readonly<Record<string, unknown>>): Promise<{ text: string }> =>
  call(memory, "write_page", {
    gist: "A page",
    note: "A change",
    ...(String(input.address).startsWith("memory:people/") && { circle: "friends" }),
    ...input,
  });

const versionOf = async (memory: Memory, address: string): Promise<string> => {
  const read = await call(memory, "read_page", { address });
  return /version (?<version>\w+)/u.exec(read.text)?.groups?.version ?? "";
};

const edit = async (
  memory: Memory,
  input: Readonly<Record<string, unknown>> & { readonly address: string },
): Promise<{ text: string; isError?: boolean }> =>
  call(memory, "edit_page", { version: await versionOf(memory, input.address), note: "A change", ...input });

const git = (directory: string, ...arguments_: readonly string[]): string =>
  execFileSync("git", ["-C", directory, ...arguments_], { encoding: "utf8" });

afterEach(async () => {
  await Promise.all(memories.get().map((memory) => memory.close()));
  memories.set([]);
});

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("memory", () => {
  it("keeps the pages in mind short, and says where the detail goes", async () => {
    const { memory } = await openMemory();

    const refused = await write(memory, { address: "memory:now", body: "a".repeat(2001) });
    const saved = await write(memory, {
      address: "memory:now",
      body: "Training for Valencia (as of 22 Oct).",
    });

    expect(refused).toEqual({
      text:
        "Now is 2002 characters, over the 2000 it can hold. Keep it to what matters on every turn, and move " +
        "the detail to a page on a shelf.",
      isError: true,
    });
    expect(saved.text).toMatch(/^Saved Now, at version \w{10}\.$/u);
    expect(memory.inMindText()).toContain("## Now (memory:now)\n\nTraining for Valencia (as of 22 Oct).");
  });

  it("reads a page with numbered lines and edits an exact passage or a range of lines", async () => {
    const { memory } = await openMemory();
    await write(memory, {
      address: "memory:people/janki",
      title: "Janki",
      body: "Your partner (as of 28 Oct).\nFlorence together 6–9 Nov.\n\n## Earlier\n\n- 2025: met in London.",
    });

    const read = await call(memory, "read_page", { address: "memory:people/janki" });
    const byPassage = await edit(memory, {
      address: "memory:people/janki",
      old_text: "6–9 Nov",
      new_text: "6–10 Nov",
    });
    const byLines = await edit(memory, {
      address: "memory:people/janki",
      start_line: 6,
      end_line: 6,
      new_text: "- 2025: met in London, at a friend's party.",
      gist: "Your partner",
    });

    expect(read.text).toMatch(
      /^memory:people\/janki, version \w{10}\n---\n\{title: Janki, gist: A page, circle: friends\}\n---\n/u,
    );
    expect(read.text).toContain(
      "1  Your partner (as of 28 Oct).\n2  Florence together 6–9 Nov.\n3\n4  ## Earlier\n5\n6  - 2025: met in London.",
    );
    expect(byPassage.text).toMatch(/^Saved Janki, now at version \w{10}\.$/u);
    expect(byLines.text).toMatch(/^Saved Janki, now at version \w{10}\.$/u);
    expect(memory.page("memory:people/janki")).toMatchObject({
      ok: true,
      value: {
        gist: "Your partner",
        markdown:
          "Your partner (as of 28 Oct).\nFlorence together 6–10 Nov.\n\n## Earlier\n\n- 2025: met in London, at a " +
          "friend's party.\n",
      },
    });
  });

  it("refuses an edit to a page that changed since it was read, or a passage that isn't there once", async () => {
    const { memory } = await openMemory();
    await write(memory, { address: "memory:people/sam", title: "Sam", body: "A friend.\nA friend from running." });
    const read = await versionOf(memory, "memory:people/sam");
    await edit(memory, { address: "memory:people/sam", old_text: "running", new_text: "the club" });

    const stale = await call(memory, "edit_page", {
      address: "memory:people/sam",
      version: read,
      old_text: "the club",
      new_text: "the track",
      note: "Moved clubs",
    });
    const twice = await edit(memory, { address: "memory:people/sam", old_text: "A friend", new_text: "A mate" });
    const missing = await edit(memory, { address: "memory:people/sam", old_text: "a neighbour", new_text: "x" });

    expect(stale).toEqual({
      text: expect.stringMatching(/^Sam has changed since you read it: it's at version \w{10} now\./u) as unknown,
      isError: true,
    });
    expect(twice).toEqual({
      text: "That passage is on the page 2 times. Include more of what's around it, so it's there once.",
      isError: true,
    });
    expect(missing.isError).toBe(true);
  });

  it("never empties or halves a page by editing, and writes whole pages only when they're new", async () => {
    const { memory } = await openMemory();
    await write(memory, {
      address: "memory:people/janki",
      title: "Janki",
      body: "Your partner.\n" + "Detail. ".repeat(40),
    });

    const halved = await edit(memory, {
      address: "memory:people/janki",
      old_text: "Detail. ".repeat(30),
      new_text: "",
    });
    const rewritten = await write(memory, { address: "memory:people/janki", title: "Janki", body: "" });

    expect(halved).toEqual({
      text:
        "That would remove more than half of Janki. Edit it a part at a time, or forget the page with " +
        "forget_page if it should go.",
      isError: true,
    });
    expect(rewritten).toEqual({
      text: "Janki is already a page. Read it with read_page, then change it with edit_page.",
      isError: true,
    });
  });

  it("forgets a page only when the person allows it, and restores it from its history", async () => {
    const asked = createCell<readonly string[]>([]);
    const answers = createCell<readonly boolean[]>([false, true]);
    const { memory, steps } = await openMemory((fields) => {
      asked.update((current) => [...current, `${fields.question} ${fields.preview ?? ""}`]);
      const [answer = false, ...rest] = answers.get();
      answers.set(rest);
      return Promise.resolve(answer);
    });
    await write(memory, { address: "memory:places/dishoom", title: "Dishoom", body: "Our first date." });

    const kept = await call(memory, "forget_page", { address: "memory:places/dishoom", reason: "Duplicate page" });
    const forgotten = await call(memory, "forget_page", { address: "memory:places/dishoom", reason: "Duplicate page" });
    const change = steps().at(-1)?.change ?? "";
    const history = await call(memory, "page_history", { address: "memory:places/dishoom" });
    const [, version = ""] = /\n(\w{10}) .*Add Dishoom: A change/u.exec(history.text) ?? [];
    const restored = await call(memory, "restore_page", {
      address: "memory:places/dishoom",
      version,
      note: "Forgot it by mistake",
    });

    expect(asked.get()).toEqual([
      "Forget Dishoom? Dishoom (memory:places/dishoom): Duplicate page",
      "Forget Dishoom? Dishoom (memory:places/dishoom): Duplicate page",
    ]);
    expect(kept).toEqual({ text: "They kept Dishoom, so nothing was forgotten." });
    expect(forgotten).toEqual({ text: "Forgot Dishoom." });
    expect(await memory.change(change)).toMatchObject({ title: "Dishoom", before: "Our first date.\n" });
    expect(history.text).toMatch(/^\w{10} {2}\S+ \S+ {2}Forget Dishoom: Duplicate page \(gone after this\)\n/u);
    expect(restored.text).toMatch(/^Restored Dishoom, now at version \w{10}\.$/u);
    expect(memory.page("memory:places/dishoom")).toMatchObject({ ok: true, value: { markdown: "Our first date.\n" } });
  });

  it("recalls pages by their words, and never the pages already in mind", async () => {
    const { memory, steps } = await openMemory();
    await write(memory, { address: "memory:now", body: "Lisbon is coming up." });
    await write(memory, {
      address: "memory:projects/lisbon",
      title: "Lisbon trip",
      body: "Four nights in Lisbon.",
    });

    const recalled = await call(memory, "recall", { query: "Lisbon" });

    expect(recalled.text).toContain("Lisbon trip (memory:projects/lisbon");
    expect(steps().at(-1)).toEqual({
      action: "used",
      pages: [{ address: "memory:projects/lisbon", title: "Lisbon trip" }],
    });
  });

  it("pushes to its remote after a change, and stops calling itself backed up after a day of failures", async () => {
    const { memory, clock, directory } = await openMemory();
    const remote = path.join(directory, "remote.git");
    git(directory, "init", "--quiet", "--bare", remote);
    expect(memory.isBackedUp()).toBe(false);
    const thread = await openThread(path.join(directory, "thread"));
    await thread.setRemote(remote);

    await write(memory, { address: "memory:people/sam", title: "Sam", body: "A friend from running." });
    clock.runNext(clock.now() + 30_000);
    await vi.waitFor(() => {
      expect(git(remote, "log", "--format=%s", "main")).toContain("Add Sam");
    });
    expect(memory.isBackedUp()).toBe(true);

    rmSync(remote, { recursive: true, force: true });
    await edit(memory, { address: "memory:people/sam", old_text: "running", new_text: "the club" });
    clock.runNext(clock.now() + 30_000);
    await delay(500);
    clock.moveTo(clock.now() + 25 * 60 * 60 * 1000);

    expect(memory.isBackedUp()).toBe(false);
  });

  it("catches up with pages that arrive in the Thread from outside, and drops deleted ones", async () => {
    const { memory, directory } = await openMemory();
    const thread = path.join(directory, "thread");
    await write(memory, { address: "memory:places/dishoom", title: "Dishoom", body: "Our first date." });

    mkdirSync(path.join(thread, "people"), { recursive: true });
    writeFileSync(path.join(thread, "people", "sam.md"), "---\ntitle: Sam\n---\n\nYou run with Sam on Sundays.\n");
    git(thread, "rm", "--quiet", "places/dishoom.md");
    git(thread, "add", "people/sam.md");
    git(thread, "commit", "--quiet", "--message", "Imported from Ariadne");

    const sam = await call(memory, "recall", { query: "Sunday runs with Sam" });
    const dishoom = await call(memory, "recall", { query: "Dishoom" });

    expect(sam.text).toContain("Sam (memory:people/sam");
    expect(dishoom.text).not.toContain("Dishoom");
    expect(memory.recent()).toMatchObject([
      { address: "memory:people/sam", title: "Sam" },
      { address: "memory:places/dishoom", title: "Dishoom", note: "A change" },
    ]);
    expect(memory.recent()[0]).not.toHaveProperty("note");
  });

  it("asks for a gist and a note with every new page, and a note with every edit", async () => {
    const { memory } = await openMemory();
    const gist = "Give the page a gist: what it is now, in one line.";
    const note = "Give a note: what this change does, in a few words.";
    const circle = "Give them a circle: who they are to the person, such as family, friends or work.";

    const bare = await call(memory, "write_page", { address: "memory:people/sam", title: "Sam", body: "A friend." });
    await write(memory, { address: "memory:people/sam", title: "Sam", body: "A friend." });
    const unnoted = await edit(memory, { address: "memory:people/sam", old_text: "A", new_text: "An old", note: "" });
    const journal = await call(memory, "journal", { text: "Ran with Sam." });

    expect(bare).toEqual({ text: `${gist} ${circle} ${note}`, isError: true });
    expect(unnoted).toEqual({ text: note, isError: true });
    expect(journal).toEqual({ text: `${gist} ${note}`, isError: true });
  });

  it("pulls only when it can fast-forward, and refuses when both sides changed", async () => {
    const { directory } = await openMemory();
    const remote = path.join(directory, "remote.git");
    const elsewhere = path.join(directory, "elsewhere");
    const thread = await openThread(path.join(directory, "thread"));
    git(directory, "init", "--quiet", "--bare", "--initial-branch=main", remote);
    await thread.setRemote(remote);
    expect(await thread.push()).toEqual({ ok: true, value: undefined });
    git(directory, "clone", "--quiet", remote, elsewhere);
    const commitElsewhere = (file: string): void => {
      writeFileSync(path.join(elsewhere, file), "From elsewhere.\n");
      git(elsewhere, "add", file);
      git(elsewhere, "-c", "user.name=Divy", "-c", "user.email=divy@example.com", "commit", "--quiet", "-m", file);
      git(elsewhere, "push", "--quiet", "origin", "HEAD:main");
    };

    commitElsewhere("now.md");
    const pulled = await thread.pull();
    commitElsewhere("portrait.md");
    await thread.write("helping-you.md", "From the box.\n", "Add How to help you");
    const refused = await thread.pull();

    expect(pulled).toEqual({ ok: true, value: "pulled" });
    expect(thread.read("now.md")).toBe("From elsewhere.\n");
    expect(refused).toMatchObject({
      ok: false,
      failure: expect.stringContaining("changed both here and on the remote") as unknown,
    });
  });

  it("boosts only names Ari wrote about lately, or that are in mind or in your recent messages", async () => {
    const { memory, directory } = await openMemory();
    const thread = path.join(directory, "thread");
    mkdirSync(path.join(thread, "people"), { recursive: true });
    mkdirSync(path.join(thread, "places"), { recursive: true });
    writeFileSync(path.join(thread, "people", "ivona.md"), "---\ntitle: Ivona\n---\n\nA friend from Zagreb.\n");
    writeFileSync(path.join(thread, "places", "ljubljana.md"), "---\ntitle: Ljubljana\n---\n\nWhere you run.\n");
    git(thread, "add", "people", "places");
    git(thread, "commit", "--quiet", "--message", "Imported from Ariadne");
    await write(memory, { address: "memory:people/bora", title: "Bora", body: "You run with Bora." });
    await write(memory, { address: "memory:projects/job-search", title: "Job search", body: "QRT next." });
    await write(memory, { address: "memory:now", body: "Back from Ljubljana (as of 27 Oct)." });

    expect(await memory.boostedNames()).toEqual(["Bora", "Ljubljana"]);
  });
});
