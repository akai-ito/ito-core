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
import { createMemory, type Memory } from "#memory/memory.ts";
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

const openMemory = async (): Promise<Opened> => {
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

    const refused = await call(memory, "remember", { address: "memory:now", body: "a".repeat(2001) });
    const saved = await call(memory, "remember", {
      address: "memory:now",
      body: "Training for Valencia (as of 22 Oct).",
    });

    expect(refused).toEqual({
      text:
        "Now is 2002 characters, over the 2000 it can hold. Keep it to what matters on every turn, and move " +
        "the detail to a page on a shelf.",
      isError: true,
    });
    expect(saved).toEqual({ text: "Saved Now." });
    expect(memory.inMindText()).toContain("## Now (memory:now)\n\nTraining for Valencia (as of 22 Oct).");
  });

  it("deletes a page given an empty body, and the change still shows what it said", async () => {
    const { memory, steps } = await openMemory();
    await call(memory, "remember", { address: "memory:places/dishoom", title: "Dishoom", body: "Our first date." });

    await call(memory, "remember", { address: "memory:places/dishoom", body: "" });
    const change = steps().at(-1)?.change ?? "";

    expect(memory.page("memory:places/dishoom")).toMatchObject({ ok: false, failure: { code: "not_found" } });
    expect(await memory.change(change)).toMatchObject({ title: "Dishoom", before: "Our first date.\n" });
    expect(await memory.change(change)).not.toHaveProperty("after");
  });

  it("recalls pages by their words, and never the pages already in mind", async () => {
    const { memory, steps } = await openMemory();
    await call(memory, "remember", { address: "memory:now", body: "Lisbon is coming up." });
    await call(memory, "remember", {
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

    await call(memory, "remember", { address: "memory:people/sam", title: "Sam", body: "A friend from running." });
    clock.runNext(clock.now() + 30_000);
    await vi.waitFor(() => {
      expect(git(remote, "log", "--format=%s", "main")).toContain("Add Sam");
    });
    expect(memory.isBackedUp()).toBe(true);

    rmSync(remote, { recursive: true, force: true });
    await call(memory, "remember", { address: "memory:people/sam", title: "Sam", body: "A friend from the club." });
    clock.runNext(clock.now() + 30_000);
    await delay(500);
    clock.moveTo(clock.now() + 25 * 60 * 60 * 1000);

    expect(memory.isBackedUp()).toBe(false);
  });

  it("catches up with pages that arrive in the Thread from outside, and drops deleted ones", async () => {
    const { memory, directory } = await openMemory();
    const thread = path.join(directory, "thread");
    await call(memory, "remember", { address: "memory:places/dishoom", title: "Dishoom", body: "Our first date." });

    mkdirSync(path.join(thread, "people"), { recursive: true });
    writeFileSync(path.join(thread, "people", "sam.md"), "---\ntitle: Sam\n---\n\nYou run with Sam on Sundays.\n");
    git(thread, "rm", "--quiet", "places/dishoom.md");
    git(thread, "add", "people/sam.md");
    git(thread, "commit", "--quiet", "--message", "Imported from Ariadne");

    const sam = await call(memory, "recall", { query: "Sunday runs with Sam" });
    const dishoom = await call(memory, "recall", { query: "Dishoom" });

    expect(sam.text).toContain("Sam (memory:people/sam");
    expect(dishoom.text).not.toContain("Dishoom");
    expect(memory.recent().map(({ address }) => address)).toEqual(["memory:people/sam"]);
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
});
