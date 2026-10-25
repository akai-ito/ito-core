import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
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
});
