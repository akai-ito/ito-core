import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { createCell } from "#cell.ts";
import type { AskFields, StepFacts } from "#engine/engine.ts";
import { randomIdentifiers } from "#identifiers.ts";
import { wordEmbedder } from "#memory/embedder.ts";
import { createMemory, type Memory } from "#memory/memory.ts";
import { createKinds } from "#motion/kinds.ts";
import { createMotions, type Motions } from "#motion/motion.ts";
import { florenceId, florenceTrip } from "#protocol/tools/florence.ts";
import { sub20Id, sub20Training } from "#protocol/tools/sub20.ts";
import { loadSchemas } from "#protocol/schemas.ts";
import { ok, type Result } from "#result.ts";
import { openDatabase } from "#store/database.ts";
import { createMemoryStore } from "#store/memory.ts";
import { createStore, type Store } from "#store/store.ts";
import { createVirtualClock, type VirtualClock } from "./support/virtual-clock.ts";

const home = mkdtempSync(path.join(os.tmpdir(), "ito-motion-"));
const memories = createCell<readonly Memory[]>([]);
const schemas = loadSchemas();
const cover = "f_0001_04217";

type Opened = {
  readonly motions: Motions;
  readonly store: Store;
  readonly memory: Memory;
  readonly thread: string;
  readonly steps: () => readonly StepFacts[];
  readonly asked: () => readonly AskFields[];
  readonly clock: VirtualClock;
};

const openMotions = async (
  answers: readonly boolean[] = [],
  complete?: (prompt: string) => Promise<Result<unknown, string>>,
): Promise<Opened> => {
  const directory = mkdtempSync(path.join(home, "home-"));
  const database = openDatabase(path.join(directory, "ito.db"));
  const clock = createVirtualClock(Date.parse("2026-10-29T12:00:00.000Z"));
  const store = createStore(database, clock, randomIdentifiers);
  const steps = createCell<readonly StepFacts[]>([]);
  const asked = createCell<readonly AskFields[]>([]);
  const remaining = createCell(answers);
  const memory = createMemory({
    directory: path.join(directory, "thread"),
    store: createMemoryStore(database),
    settings: store,
    clock,
    identifiers: randomIdentifiers,
    embedder: wordEmbedder,
    recordStep: () => true,
    approve: () => Promise.resolve(true),
    info: () => true,
    timeZone: "UTC",
  });
  memories.update((current) => [...current, memory]);
  mkdirSync(path.join(directory, "attachments"), { recursive: true });
  writeFileSync(path.join(directory, "attachments", cover), "a picture");
  const motions = createMotions({
    memory,
    store,
    kinds: createKinds(schemas),
    clock,
    picturePath: (id) => path.join(directory, "attachments", id),
    approve: (fields) => {
      asked.update((current) => [...current, fields]);
      const [answer = false, ...rest] = remaining.get();
      remaining.set(rest);
      return Promise.resolve(answer);
    },
    recordStep: (facts) => {
      steps.update((current) => [...current, facts]);
      return true;
    },
    info: () => true,
    ...(complete && { complete: (prompt: string) => complete(prompt) }),
  });
  await motions.ready;
  return {
    motions,
    store,
    memory,
    thread: path.join(directory, "thread"),
    steps: () => steps.get(),
    asked: () => asked.get(),
    clock,
  };
};

const call = async (motions: Motions, name: string, input: unknown): Promise<{ text: string; isError?: boolean }> => {
  const tool = motions.tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`No tool ${name}.`);
  return tool.call(input);
};

const startFlorence = (motions: Motions): Promise<{ text: string; isError?: boolean }> =>
  call(motions, "start_motion", {
    id: florenceId,
    kind: "trip",
    title: "Florence with Janki",
    summary: "6–9 Nov · 4 to book",
    content: florenceTrip(cover),
    note: "Started the trip",
  });

const bookUffizi = {
  id: florenceId,
  version: 1,
  changes: [
    { set: "book-uffizi", fields: { done: true } },
    { set: "uffizi", fields: { booking: { status: "booked", ref: "UF-2291" } } },
  ],
  summary: "6–9 Nov · 3 to book",
  note: "Booked the Uffizi, 8:15 Saturday",
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

describe("things in motion", () => {
  it("starts a trip as a folder in the Thread, pinned, with its pictures beside it", async () => {
    const { motions, thread, steps } = await openMotions();

    const started = await startFlorence(motions);

    expect(started).toEqual({ text: "Started Florence with Janki as florence-with-janki, at version 1." });
    expect(motions.list()).toMatchObject([
      {
        id: florenceId,
        kind: "trip",
        status: "active",
        pinned: true,
        version: 1,
        cover,
        summary: "6–9 Nov · 4 to book",
      },
    ]);
    expect(existsSync(path.join(thread, "motion", florenceId, "pictures", cover))).toBe(true);
    expect(git(thread, "log", "-1", "--format=%s")).toBe("Florence with Janki: Started the trip\n");
    expect(steps()).toMatchObject([{ action: "started", motion: florenceId, version: 1 }]);
    expect(motions.inMindText()).toContain("- Florence with Janki (florence-with-janki, trip): 6–9 Nov · 4 to book");
  });

  it("changes it by id, citing the version, and keeps what changed with each note", async () => {
    const { motions } = await openMotions();
    await startFlorence(motions);

    const changed = await call(motions, "change_motion", bookUffizi);
    const stale = await call(motions, "change_motion", { ...bookUffizi, note: "Again" });
    const detail = await motions.detail(florenceId);
    const read = await call(motions, "read_motion", { id: florenceId });

    expect(changed).toEqual({ text: "Saved Florence with Janki, now at version 2." });
    expect(stale).toEqual({
      text: "Florence with Janki has changed since you read it: it's at version 2 now. Read it again, then change it.",
      isError: true,
    });
    expect(detail).toMatchObject({
      ok: true,
      value: {
        motion: { version: 2, summary: "6–9 Nov · 3 to book" },
        changes: [
          { version: 2, note: "Booked the Uffizi, 8:15 Saturday" },
          { version: 1, note: "Started the trip" },
        ],
      },
    });
    expect(read.text).toMatch(/^florence-with-janki \(trip\), version 2, active, pinned\n/u);
    expect(read.text).toContain('"ref": "UF-2291"');
  });

  it("refuses a change that breaks the trip's shape, or empties it, and says why", async () => {
    const { motions } = await openMotions();
    await startFlorence(motions);

    const misshapen = await call(motions, "change_motion", {
      ...bookUffizi,
      changes: [{ set: "uffizi", fields: { time: "8am" } }],
    });
    const unpinned = await call(motions, "change_motion", {
      ...bookUffizi,
      changes: [{ set: florenceId, fields: { pinned: "no" } }],
    });
    const emptied = await call(motions, "change_motion", {
      ...bookUffizi,
      changes: ["fri", "sat", "sun", "book-uffizi"].map((id) => ({ remove: id })),
    });

    expect(misshapen).toEqual({
      text: 'days.1.stops.0.time must match pattern "^\\d{2}:\\d{2}$".',
      isError: true,
    });
    expect(emptied.text).toMatch(/^That would remove more than half/u);
    expect(unpinned).toEqual({
      text: "A thing's title and summary are text, and pinned is true or false.",
      isError: true,
    });
    expect(motions.list()[0]?.version).toBe(1);
  });

  it("takes your ticks as state, tells Ari of them, and drops a tick whose item goes", async () => {
    const { motions, store } = await openMotions();
    await startFlorence(motions);

    const ticked = motions.patchState(florenceId, { todo: { "book-pisa": { done: true } } });
    const stray = motions.patchState(florenceId, { todo: { nowhere: { done: true } } });
    const note = motions.tickNote();
    await call(motions, "change_motion", { ...bookUffizi, changes: [{ remove: "book-pisa" }], note: "Pisa's off" });

    expect(ticked).toEqual({ ok: true, value: { todo: { "book-pisa": { done: true } } } });
    expect(stray).toEqual({
      ok: false,
      failure: { code: "not_found", detail: "Florence with Janki has no item nowhere." },
    });
    expect(note).toBe("(Since your last reply: in Florence with Janki, you ticked Pisa train tickets.)");
    expect(store.motionState(florenceId)).toEqual({});
  });

  it("tells Ari only of ticks since its last turn", async () => {
    const { motions, store } = await openMotions();
    await startFlorence(motions);
    motions.patchState(florenceId, { todo: { "book-pisa": { done: true } } });
    store.startTurn(randomIdentifiers.turn(), []);

    motions.patchState(florenceId, { todo: { "book-duomo": { done: true } } });

    expect(motions.tickNote()).toBe(
      "(Since your last reply: in Florence with Janki, you ticked Book the Duomo climb.)",
    );
  });

  it("counts versions right after a change that drops a picture", async () => {
    const { motions, thread } = await openMotions();
    await startFlorence(motions);

    await call(motions, "change_motion", { ...bookUffizi, changes: [{ set: florenceId, fields: { cover: null } }] });
    const next = await call(motions, "change_motion", { ...bookUffizi, version: 2 });

    expect(existsSync(path.join(thread, "motion", florenceId, "pictures", cover))).toBe(false);
    expect(next).toEqual({ text: "Saved Florence with Janki, now at version 3." });
  });

  it("brings back an earlier version as a new change, and finishes the trip into Done", async () => {
    const { motions } = await openMotions();
    await startFlorence(motions);
    await call(motions, "change_motion", bookUffizi);

    const restored = await call(motions, "restore_motion", {
      id: florenceId,
      version: 1,
      note: "That booking fell through",
    });
    const finished = await call(motions, "finish_motion", { id: florenceId, note: "Home from Florence" });
    const earlier = await motions.detail(florenceId, 2);

    expect(restored).toEqual({ text: "Brought back version 1 of Florence with Janki, now at version 3." });
    expect(finished).toEqual({ text: "Finished Florence with Janki." });
    expect(motions.list()).toMatchObject([
      { status: "done", pinned: false, version: 4, summary: "6–9 Nov · 4 to book" },
    ]);
    expect(JSON.stringify(earlier.ok && earlier.value.content)).toContain("UF-2291");
  });

  it("forgets a thing only when you allow it", async () => {
    const { motions, thread, asked } = await openMotions([false, true]);
    await startFlorence(motions);

    const kept = await call(motions, "forget_motion", { id: florenceId, reason: "We're not going" });
    const forgotten = await call(motions, "forget_motion", { id: florenceId, reason: "We're not going" });

    expect(kept).toEqual({ text: "They kept Florence with Janki, so nothing was forgotten." });
    expect(forgotten).toEqual({ text: "Forgot Florence with Janki." });
    expect(asked()[0]).toMatchObject({ kind: "approval", question: "Forget Florence with Janki?" });
    expect(motions.list()).toEqual([]);
    expect(existsSync(path.join(thread, "motion", florenceId))).toBe(false);

    await startFlorence(motions);
    const changed = await call(motions, "change_motion", bookUffizi);

    expect(changed).toEqual({ text: "Saved Florence with Janki, now at version 2." });
  });

  it("keeps a training block, with ticks on sessions in any week", async () => {
    const { motions } = await openMotions();

    const started = await call(motions, "start_motion", {
      id: sub20Id,
      kind: "training",
      title: "Sub-20 5K",
      summary: "Week 6 of 10 · intervals today",
      content: sub20Training,
      note: "Started the block",
    });
    const ticked = motions.patchState(sub20Id, { sessions: { "w6-wed": { done: true } } });

    expect(started.isError).toBeUndefined();
    expect(ticked).toEqual({ ok: true, value: { sessions: { "w6-wed": { done: true } } } });
    expect(motions.tickNote()).toBe("(Since your last reply: in Sub-20 5K, you ticked Intervals.)");
  });

  it("keeps the thing up with your ticks at once, quietly, gathering ticks in quick succession", async () => {
    const prompts = createCell<readonly string[]>([]);
    const { motions, clock } = await openMotions([], (prompt) => {
      prompts.update((current) => [...current, prompt]);
      return Promise.resolve(
        ok({
          changes_json: JSON.stringify([
            { set: "pisa-train", fields: { booking: { status: "booked" } } },
            { set: "pisa-day", fields: { booking: { status: "booked" } } },
          ]),
          summary: "6–9 Nov · 2 to book",
          note: "Pisa train booked",
        }),
      );
    });
    await startFlorence(motions);

    motions.patchState(florenceId, { todo: { "book-pisa": { done: true } } });
    clock.moveTo(clock.now() + 1000);
    motions.patchState(florenceId, { todo: { "book-duomo": { done: true } } });
    clock.runNext(clock.now() + 3000);

    await vi.waitFor(() => {
      expect(motions.list()[0]).toMatchObject({ version: 2, summary: "6–9 Nov · 2 to book" });
    });
    const detail = await motions.detail(florenceId);
    expect(prompts.get()).toHaveLength(1);
    expect(prompts.get()[0]).toContain("They just ticked Pisa train tickets, ticked Book the Duomo climb in it");
    expect(detail.ok && detail.value.changes[0]).toMatchObject({ version: 2, note: "Pisa train booked" });
    expect(JSON.stringify(detail.ok && detail.value.content)).toContain('"booking":{"status":"booked"}');
  });

  it("drops a reaction to a tick when the thing changed while Ari was thinking", async () => {
    const answer = createCell<((value: Result<unknown, string>) => void) | undefined>(undefined);
    const { motions, clock } = await openMotions(
      [],
      () =>
        new Promise((resolve) => {
          answer.set(resolve);
        }),
    );
    await startFlorence(motions);
    motions.patchState(florenceId, { todo: { "book-pisa": { done: true } } });
    clock.runNext(clock.now() + 3000);
    await vi.waitFor(() => {
      expect(answer.get()).toBeDefined();
    });

    await call(motions, "change_motion", bookUffizi);
    answer.get()?.(
      ok({
        changes_json: JSON.stringify([{ set: "pisa-day", fields: { booking: { status: "booked" } } }]),
        summary: "6–9 Nov · 2 to book",
        note: "Pisa train booked",
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(motions.list()[0]).toMatchObject({ version: 2, summary: "6–9 Nov · 3 to book" });
  });

  it("lets recall find a trip by what's in it", async () => {
    const { motions, memory } = await openMotions();
    await startFlorence(motions);

    const recall = memory.tools.find((tool) => tool.name === "recall");
    const found = await recall?.call({ query: "Leaning Tower Pisa" });

    expect(found?.text).toContain("Florence with Janki (motion:florence-with-janki,");
  });
});
