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
import { florenceId, florencePictures, florenceTrip, type FlorencePictures } from "#protocol/tools/florence.ts";
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

const photo = "f_0002_04218";

const pictures = Object.fromEntries(
  florencePictures.map((name) => [name, name === "cover" ? cover : photo]),
) as FlorencePictures;

type Opened = {
  readonly motions: Motions;
  readonly store: Store;
  readonly memory: Memory;
  readonly thread: string;
  readonly steps: () => readonly StepFacts[];
  readonly asked: () => readonly AskFields[];
  readonly clock: VirtualClock;
};

// A thing kept as 0.18 kept it: a kind of then, and no salience or outcome.
type Legacy = { readonly id: string; readonly kind: string; readonly title: string; readonly content: object };

const openMotions = async (
  answers: readonly boolean[] = [],
  complete?: (prompt: string) => Promise<Result<unknown, string>>,
  legacy: readonly Legacy[] = [],
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
    timeZone: () => "UTC",
  });
  memories.update((current) => [...current, memory]);
  mkdirSync(path.join(directory, "attachments"), { recursive: true });
  writeFileSync(path.join(directory, "attachments", cover), "a picture");
  await memory.ready;
  for (const { id, kind, title, content } of legacy) {
    const card = { kind, title, summary: "As 0.18 kept it", pinned: true, status: "active" };
    await memory.withThread((thread) =>
      thread.writeFiles(
        [
          { file: `motion/${id}/motion.json`, text: JSON.stringify(card) },
          { file: `motion/${id}/content.json`, text: JSON.stringify(content) },
        ],
        `${title}: Started it`,
      ),
    );
    const { status, summary, pinned } = card;
    const at = "2026-10-01T09:00:00.000Z";
    // As the 0.19 migration leaves it: the store's copy normal, the Thread's as 0.18 wrote it.
    const motion = {
      id,
      kind,
      title,
      summary,
      pinned,
      salience: "normal",
      status,
      version: 1,
      started_at: at,
      changed_at: at,
    };
    store.recordMotion("motion.started", motion as Parameters<Store["recordMotion"]>[1], "Started it");
  }
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
    title: "Florence with Mira",
    summary: "6–9 Nov · 4 to book",
    salience: "loud",
    content: florenceTrip(pictures),
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

const jobSearch = {
  after: "A senior AI role in London that ships to real users, by January.",
  play: ["No firms that only want dashboards", "Never below £140k base"],
  options: [
    {
      id: "halcyon",
      name: "Senior AI Engineer",
      org: "Halcyon",
      stage: "Screened",
      people: [{ name: "Tess", role: "recruiter", page: "memory:people/tess" }],
      next: { text: "First round with the team lead", at: "2026-11-04T14:00" },
      waiting_on: { who: "Tess", since: "2026-10-30" },
    },
    { id: "helsing", name: "ML Engineer", org: "Helsing", stage: "Applied", people: [] },
  ],
};

const northwind = {
  org: "Northwind",
  role: "Software Engineer, Agents",
  where: "London",
  stage: "talking",
  stages: { lead: "2026-10-20" },
  next: {
    text: "Virtual 1 · Python PR review",
    at: "2026-11-09T14:00",
    link: { label: "The invite", url: "message://%3Cinvite-1%40northwind.example%3E" },
  },
  rounds: [
    { id: "recruiter", title: "Recruiter", status: "done" },
    { id: "virtual-1", title: "Virtual 1", status: "next", at: "2026-11-09T14:00" },
  ],
  facts: [{ id: "where", label: "Where", value: "London, three days in the office" }],
  notes: [
    { id: "pay-source", tag: "source", text: "The pay range is from the recruiter's call.", at: "2026-10-28" },
    { id: "ids", tag: "ids", text: "calendar 7c1e9b2a@northwind.example" },
  ],
};

const visa = {
  about: "Renewing the visa before March.",
  status: "Forms in, waiting on the biometrics slot",
  timeline: [{ id: "forms-in", at: "2026-10-27", text: "Sent the forms." }],
  todo: [
    { id: "book-biometrics", text: "Book the biometrics slot", done: false },
    { id: "photos", text: "Get two passport photos", done: false },
  ],
};

const startRole = (motions: Motions): Promise<{ text: string; isError?: boolean }> =>
  call(motions, "start_motion", {
    id: "northwind",
    kind: "career",
    title: "Northwind",
    summary: "Virtual 1 · Python PR review",
    salience: "loud",
    content: northwind,
    note: "Added Northwind to the pipeline",
  });

const story = {
  happened: "Four days, the Uffizi at opening and Pisa on the Sunday.",
  learnt: ["Booking the Uffizi first made the rest easy."],
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

    expect(started).toEqual({ text: "Started Florence with Mira as florence-with-mira, at version 1." });
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
    expect(git(thread, "log", "-1", "--format=%s")).toBe("Florence with Mira: Started the trip\n");
    expect(steps()).toMatchObject([{ action: "started", motion: florenceId, version: 1 }]);
    expect(motions.inMindText()).toContain(
      "- Florence with Mira (florence-with-mira, trip, loud): 6–9 Nov · 4 to book",
    );
  });

  it("changes it by id, citing the version, and keeps what changed with each note", async () => {
    const { motions } = await openMotions();
    await startFlorence(motions);

    const changed = await call(motions, "change_motion", bookUffizi);
    const stale = await call(motions, "change_motion", { ...bookUffizi, note: "Again" });
    const detail = await motions.detail(florenceId);
    const read = await call(motions, "read_motion", { id: florenceId });

    expect(changed).toEqual({ text: "Saved Florence with Mira, now at version 2." });
    expect(stale).toEqual({
      text: "Florence with Mira has changed since you read it: it's at version 2 now. Read it again, then change it.",
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
    expect(read.text).toMatch(/^florence-with-mira \(trip\), version 2, active, pinned, loud\n/u);
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
      changes: ["fri", "sat", "sun", "book-uffizi", "book-duomo", "book-pisa"].map((id) => ({ remove: id })),
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

  it("refuses a trip that isn't made properly, naming what's missing", async () => {
    const { motions } = await openMotions();
    const uncovered = Object.fromEntries(Object.entries(florenceTrip(pictures)).filter(([field]) => field !== "cover"));

    const started = await call(motions, "start_motion", {
      id: florenceId,
      kind: "trip",
      title: "Florence with Mira",
      summary: "6–9 Nov · 4 to book",
      salience: "loud",
      content: uncovered,
      note: "Started the trip",
    });
    await startFlorence(motions);
    const changed = await call(motions, "change_motion", {
      ...bookUffizi,
      changes: [
        { set: florenceId, fields: { title: "Florence (a test; nothing booked)" } },
        { set: "boboli", fields: { photo: null } },
        { set: "tower", fields: { place: null } },
      ],
    });

    expect(started.text).toMatch(/^Florence with Mira isn't made properly yet: it needs a cover\. /u);
    expect(changed).toEqual({
      text:
        "Florence (a test; nothing booked) isn't made properly yet: it needs a title of 28 characters or fewer, " +
        "with the rest in the summary; a photo for the places boboli; a place for the stops tower. Every trip " +
        "gets these, even a small or test one: find photos with keep_image, add the places, and try again.",
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
      failure: { code: "not_found", detail: "Florence with Mira has no item nowhere." },
    });
    expect(note).toBe("(Since your last reply: in Florence with Mira, you ticked Pisa train tickets.)");
    expect(store.motionState(florenceId)).toEqual({});
  });

  it("lets a newer done win over an older untick, and says how what it set shows them", async () => {
    const { motions, store } = await openMotions();
    await startFlorence(motions);
    await call(motions, "change_motion", { ...bookUffizi, changes: [{ set: "book-duomo", fields: { done: true } }] });
    motions.patchState(florenceId, {
      todo: { "book-duomo": { done: false } },
      places: { boboli: { status: "passed" } },
    });
    const masked = await call(motions, "read_motion", { id: florenceId });

    const done = await call(motions, "change_motion", {
      id: florenceId,
      version: 2,
      changes: [
        { set: "book-duomo", fields: { done: true } },
        { set: "boboli", fields: { status: "picked" } },
      ],
      note: "You booked the Duomo after all",
    });
    const shown = await call(motions, "read_motion", { id: florenceId });

    expect(masked.text).toContain(
      "- book-duomo “Book the Duomo climb” (todo): shows not done, by their untick; your content says done.",
    );
    expect(done.text).toBe(
      "Saved Florence with Mira, now at version 3. Your done on “Book the Duomo climb” is newer than their " +
        "untick, so it shows done. “Boboli Gardens” still shows passed: their choice wins over yours for a " +
        "place until it's booked; ask them, or book it.",
    );
    expect(store.motionState(florenceId)).toEqual({ places: { boboli: { status: "passed" } } });
    expect(shown.text).not.toContain("book-duomo “Book the Duomo climb” (todo)");
    expect(shown.text).toContain(
      "- boboli “Boboli Gardens” (places): shows passed, by their choice; your content says picked.",
    );
  });

  it("keeps their tick when Ari keeps the thing up with it", async () => {
    const { motions, store } = await openMotions();
    await startFlorence(motions);
    motions.patchState(florenceId, { todo: { "book-pisa": { done: true } } });

    const kept = await call(motions, "change_motion", {
      id: florenceId,
      version: 1,
      changes: [{ set: "book-pisa", fields: { text: "Pisa train tickets, 9:12" } }],
      note: "Noted the train",
    });

    const read = await call(motions, "read_motion", { id: florenceId });

    expect(kept.text).toBe("Saved Florence with Mira, now at version 2.");
    expect(store.motionState(florenceId)).toEqual({ todo: { "book-pisa": { done: true } } });
    expect(read.text).toContain(
      "- book-pisa “Pisa train tickets, 9:12” (todo): shows done, by their tick; your content says not done.",
    );
  });

  it("tells Ari only of ticks since its last turn", async () => {
    const { motions, store } = await openMotions();
    await startFlorence(motions);
    motions.patchState(florenceId, { todo: { "book-pisa": { done: true } } });
    store.startTurn(randomIdentifiers.turn(), []);

    motions.patchState(florenceId, { todo: { "book-duomo": { done: true } } });

    expect(motions.tickNote()).toBe("(Since your last reply: in Florence with Mira, you ticked Book the Duomo climb.)");
  });

  it("counts versions right after a change that drops a picture", async () => {
    const { motions, thread } = await openMotions();
    await startFlorence(motions);

    const bridge = {
      attachment: photo,
      alt: "The Ponte Vecchio at dusk",
      source_url: "https://commons.wikimedia.org/wiki/File:Ponte_Vecchio.jpg",
      credit: "Wikimedia Commons, CC BY-SA 4.0",
    };
    await call(motions, "change_motion", { ...bookUffizi, changes: [{ set: florenceId, fields: { cover: bridge } }] });
    const next = await call(motions, "change_motion", { ...bookUffizi, version: 2 });

    expect(existsSync(path.join(thread, "motion", florenceId, "pictures", cover))).toBe(false);
    expect(next).toEqual({ text: "Saved Florence with Mira, now at version 3." });
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
    const finished = await call(motions, "finish_motion", {
      id: florenceId,
      outcome: "achieved",
      story,
      note: "Home from Florence",
    });
    const earlier = await motions.detail(florenceId, 2);

    expect(restored).toEqual({ text: "Brought back version 1 of Florence with Mira, now at version 3." });
    expect(finished).toEqual({ text: "Finished Florence with Mira: achieved." });
    expect(motions.list()).toMatchObject([
      { status: "done", pinned: false, version: 4, summary: "6–9 Nov · 4 to book", outcome: "achieved" },
    ]);
    expect(JSON.stringify(earlier.ok && earlier.value.content)).toContain("UF-2291");
  });

  it("forgets a thing only when you allow it", async () => {
    const { motions, thread, asked } = await openMotions([false, true]);
    await startFlorence(motions);

    const kept = await call(motions, "forget_motion", { id: florenceId, reason: "We're not going" });
    const forgotten = await call(motions, "forget_motion", { id: florenceId, reason: "We're not going" });

    expect(kept).toEqual({ text: "They kept Florence with Mira, so nothing was forgotten." });
    expect(forgotten).toEqual({ text: "Forgot Florence with Mira." });
    expect(asked()[0]).toMatchObject({ kind: "approval", question: "Forget Florence with Mira?" });
    expect(motions.list()).toEqual([]);
    expect(existsSync(path.join(thread, "motion", florenceId))).toBe(false);

    await startFlorence(motions);
    const changed = await call(motions, "change_motion", bookUffizi);

    expect(changed).toEqual({ text: "Saved Florence with Mira, now at version 2." });
  });

  it("keeps a training block in Body, with ticks on sessions in any week", async () => {
    const { motions } = await openMotions();

    const started = await call(motions, "start_motion", {
      id: sub20Id,
      kind: "body",
      title: "Sub-20 5K",
      summary: "Week 6 of 10 · intervals today",
      salience: "normal",
      content: sub20Training,
      note: "Started the block",
    });
    const ticked = motions.patchState(sub20Id, { sessions: { "w6-wed": { done: true } } });

    expect(started.isError).toBeUndefined();
    expect(ticked).toEqual({ ok: true, value: { sessions: { "w6-wed": { done: true } } } });
    expect(motions.tickNote()).toBe("(Since your last reply: in Sub-20 5K, you ticked Intervals.)");
  });

  it("keeps each role once in the career pipeline, dating its stages as it moves", async () => {
    const { motions } = await openMotions();

    const started = await startRole(motions);
    const twice = await call(motions, "start_motion", {
      id: "northwind-again",
      kind: "career",
      title: "Northwind",
      summary: "A lead",
      salience: "normal",
      content: { ...northwind, org: "northwind ", stage: "lead" },
      note: "Added Northwind",
    });
    const moved = await call(motions, "change_motion", {
      id: "northwind",
      version: 1,
      changes: [{ set: "northwind", fields: { stage: "interviewing", salience: "quiet" } }],
      note: "Northwind moved you to interviews",
    });
    const detail = await motions.detail("northwind");
    const read = await call(motions, "read_motion", { id: "northwind" });

    expect(started).toEqual({ text: "Started Northwind as northwind, at version 1." });
    expect(twice).toEqual({
      text:
        "Software Engineer, Agents at northwind  is already in the pipeline as northwind: move its stage with " +
        "change_motion, so a role is only ever in one place.",
      isError: true,
    });
    expect(moved).toEqual({ text: "Saved Northwind, now at version 2." });
    expect(detail).toMatchObject({
      ok: true,
      value: {
        motion: { kind: "career", salience: "quiet", summary: "Virtual 1 · Python PR review" },
        content: {
          stage: "interviewing",
          stages: { lead: "2026-10-20", talking: "2026-10-29", interviewing: "2026-10-29" },
          notes: [
            { id: "pay-source", tag: "source" },
            { id: "ids", tag: "ids" },
          ],
        },
      },
    });
    expect(read.text).toContain("northwind (career), version 2, active, pinned, quiet");
    expect(motions.inMindText()).toContain("- Northwind (northwind, career, quiet): Virtual 1 · Python PR review");
  });

  it("starts things only in the new kinds, each with a salience Kumo judged", async () => {
    const { motions } = await openMotions();
    const pursuit = { id: "job-search", kind: "pursuit", title: "Job search", summary: "2 live" };

    const old = await call(motions, "start_motion", { ...pursuit, salience: "loud", content: jobSearch, note: "Go" });
    const unjudged = await call(motions, "start_motion", {
      id: "northwind",
      kind: "career",
      title: "Northwind",
      summary: "A lead",
      content: northwind,
      note: "Added Northwind",
    });

    expect(old).toEqual({
      text: "pursuit is 0.18's kind, kept only to read: use career, body, trip, project, learning or other.",
      isError: true,
    });
    expect(unjudged).toEqual({
      text: "Give it a salience: loud, normal or quiet, by how much it matters now.",
      isError: true,
    });
    expect(motions.list()).toEqual([]);
  });

  it("ends a thing honestly: an outcome apart from ending, a story, and copies kept out of sight", async () => {
    const { motions } = await openMotions();
    await startRole(motions);
    await call(motions, "start_motion", {
      id: sub20Id,
      kind: "body",
      title: "Sub-20 5K",
      summary: "Week 6 of 10",
      salience: "normal",
      content: sub20Training,
      note: "Started the block",
    });
    await call(motions, "start_motion", {
      id: "northwind-copy",
      kind: "career",
      title: "Northwind",
      summary: "A lead",
      salience: "quiet",
      content: { ...northwind, role: "Agents engineer" },
      note: "Added Northwind",
    });

    const untold = await call(motions, "finish_motion", { id: sub20Id, outcome: "not_met", note: "Ended it" });
    const missed = await call(motions, "finish_motion", {
      id: sub20Id,
      outcome: "not_met",
      summary: "Training incomplete, race not booked",
      story: { happened: "You trained five of the eight weeks.", learnt: ["A booked race makes the date real."] },
      note: "Ended the block",
    });
    const corrected = await call(motions, "finish_motion", {
      id: sub20Id,
      outcome: "let_go",
      story: { happened: "You stopped to make room for interviews." },
      note: "It was a choice",
    });
    const intoNothing = await call(motions, "finish_motion", {
      id: "northwind-copy",
      outcome: "duplicate",
      note: "A copy",
    });
    const copy = await call(motions, "finish_motion", {
      id: "northwind-copy",
      outcome: "duplicate",
      merged_into: "northwind",
      note: "A copy of Northwind",
    });
    const ended = await call(motions, "finish_motion", {
      id: "northwind",
      outcome: "not_met",
      summary: "No offer after the final round",
      story: { happened: "Three rounds, then a no.", followed_by: sub20Id },
      note: "Northwind said no",
    });
    const block = await motions.detail(sub20Id);
    const role = await motions.detail("northwind");

    expect(untold).toEqual({
      text: "Give its story, for History: what happened, what was learnt, and what followed.",
      isError: true,
    });
    expect(missed).toEqual({ text: "Finished Sub-20 5K: not met." });
    expect(corrected).toEqual({ text: "Sub-20 5K ended as let go now." });
    expect(intoNothing).toEqual({ text: "Give merged_into: the thing it went into, by its id.", isError: true });
    expect(copy).toEqual({ text: "Finished Northwind: duplicate." });
    expect(ended).toEqual({ text: "Finished Northwind: not met." });
    expect(block).toMatchObject({
      ok: true,
      value: {
        motion: { status: "done", outcome: "let_go", summary: "Training incomplete, race not booked", version: 3 },
        content: { story: { happened: "You stopped to make room for interviews." } },
      },
    });
    expect(role).toMatchObject({
      ok: true,
      value: { content: { stage: "ended", stages: { ended: "2026-10-29" } } },
    });
    expect(motions.list().find(({ id }) => id === "northwind-copy")).toMatchObject({
      status: "done",
      outcome: "duplicate",
      merged_into: "northwind",
    });
    expect(motions.inMindText()).toBe("");
  });

  it("reads a thing from 0.18 as normal, keeps changing it, and reshapes it, keeping its history", async () => {
    const { motions } = await openMotions([], undefined, [
      { id: "back-to-rhythm", kind: "training", title: "Back to rhythm", content: sub20Training },
      { id: "job-search", kind: "pursuit", title: "Job search", content: jobSearch },
    ]);
    motions.patchState("back-to-rhythm", { sessions: { "w6-wed": { done: true } } });

    const read = await call(motions, "read_motion", { id: "back-to-rhythm" });
    const before = motions.inMindText();
    const moved = await call(motions, "change_motion", {
      id: "job-search",
      version: 1,
      changes: [{ set: "halcyon", fields: { stage: "Interviews" } }],
      note: "Halcyon moved you to interviews",
    });
    const stale = await call(motions, "reshape_motion", {
      id: "back-to-rhythm",
      version: 2,
      kind: "body",
      content: sub20Training,
      note: "Reshaped",
    });
    const reshaped = await call(motions, "reshape_motion", {
      id: "back-to-rhythm",
      version: 1,
      kind: "body",
      content: { ...sub20Training, plan: "Four runs a week" },
      salience: "quiet",
      note: "Reshaped into a body block",
    });
    const detail = await motions.detail("back-to-rhythm");

    expect(read.text).toContain("back-to-rhythm (training), version 1, active, pinned, normal");
    expect(read.text).toContain("training is 0.18's kind: reshape it with reshape_motion.");
    expect(before).toContain("- Back to rhythm (back-to-rhythm, training, normal): As 0.18 kept it");
    expect(before).toContain("back-to-rhythm, job-search are in 0.18's kinds");
    expect(moved).toEqual({ text: "Saved Job search, now at version 2." });
    expect(stale.isError).toBe(true);
    expect(reshaped).toEqual({ text: "Reshaped Back to rhythm into a body, now at version 2." });
    expect(detail).toMatchObject({
      ok: true,
      value: {
        motion: { id: "back-to-rhythm", kind: "body", salience: "quiet", version: 2 },
        content: { plan: "Four runs a week" },
        state: { sessions: { "w6-wed": { done: true } } },
      },
    });
    expect(motions.inMindText()).toContain("job-search is in 0.18's kinds");
  });

  it("keeps something with no shape yet in Other, with your ticks on its to-dos, and keeps it up with them", async () => {
    const prompts = createCell<readonly string[]>([]);
    const { motions, clock } = await openMotions([], (prompt) => {
      prompts.update((current) => [...current, prompt]);
      return Promise.resolve(ok({ changes_json: "[]", summary: "Biometrics booked · 1 to do", note: "Slot booked" }));
    });

    const started = await call(motions, "start_motion", {
      id: "visa-renewal",
      kind: "other",
      title: "Visa renewal",
      summary: "Forms in · 2 to do",
      salience: "normal",
      content: visa,
      note: "Started the renewal",
    });
    const ticked = motions.patchState("visa-renewal", { todo: { "book-biometrics": { done: true } } });
    clock.runNext(clock.now() + 3000);

    expect(started.isError).toBeUndefined();
    expect(ticked).toEqual({ ok: true, value: { todo: { "book-biometrics": { done: true } } } });
    expect(motions.tickNote()).toBe("(Since your last reply: in Visa renewal, you ticked Book the biometrics slot.)");
    await vi.waitFor(() => {
      expect(motions.list()[0]).toMatchObject({ version: 2, summary: "Biometrics booked · 1 to do" });
    });
    expect(prompts.get()[0]).toContain(
      'You keep "Visa renewal" (visa-renewal, an other) in motion for the person. On their phone, they just ticked ' +
        "Book the biometrics slot.",
    );
  });

  it("takes your choice for a place, but leaves booking to Ari", async () => {
    const { motions } = await openMotions();
    await startFlorence(motions);

    const picked = motions.patchState(florenceId, { places: { boboli: { status: "picked" } } });
    const booked = motions.patchState(florenceId, { places: { mario: { status: "booked" } } });
    const passed = motions.patchState(florenceId, { places: { "pitti-place": { status: "passed" } } });

    expect(picked).toEqual({ ok: true, value: { places: { boboli: { status: "picked" } } } });
    expect(booked).toMatchObject({ ok: false, failure: { code: "invalid" } });
    expect(passed.ok).toBe(true);
    expect(motions.tickNote()).toBe(
      "(Since your last reply: in Florence with Mira, you put Boboli Gardens in the plan, passed on Pitti Palace.)",
    );
  });

  it("keeps the thing up with your taps at once, quietly, gathering taps in quick succession", async () => {
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
    motions.patchState(florenceId, { places: { boboli: { status: "picked" } } });
    clock.runNext(clock.now() + 3000);

    await vi.waitFor(() => {
      expect(motions.list()[0]).toMatchObject({ version: 2, summary: "6–9 Nov · 2 to book" });
    });
    const detail = await motions.detail(florenceId);
    expect(prompts.get()).toHaveLength(1);
    expect(prompts.get()[0]).toContain("they just ticked Pisa train tickets, put Boboli Gardens in the plan.");
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

    expect(found?.text).toContain("Florence with Mira (motion:florence-with-mira,");
  });
});
