import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { createCell } from "#cell.ts";
import { toTimestamp, type Clock } from "#clock.ts";
import type { AskFields, StepFacts } from "#engine/engine.ts";
import type { Memory } from "#memory/memory.ts";
import type { Thread } from "#memory/thread.ts";
import {
  applyChanges,
  danglingIds,
  itemsByField,
  listsOf,
  mergePatch,
  pruneState,
  strayIds,
  type Card,
  type Change,
  type Fields,
} from "#motion/changes.ts";
import type { Kind, Kinds } from "#motion/kinds.ts";
import type { Motion, MotionChange } from "#protocol/types.ts";
import { fail, ok, type Result } from "#result.ts";
import type { Store } from "#store/store.ts";
import type { Tool, ToolResult } from "#tools/mcp.ts";
import type { Info } from "#turns/turns.ts";

export type MotionDetail = {
  readonly motion: Motion;
  readonly content: Fields;
  readonly state: Fields;
  readonly changes: readonly MotionChange[];
};

export type MotionFailure = { readonly code: "not_found" | "invalid"; readonly detail: string };

export type Motions = {
  readonly ready: Promise<void>;
  readonly tools: readonly Tool[];
  readonly list: () => readonly Motion[];
  readonly detail: (id: string, version?: number) => Promise<Result<MotionDetail, MotionFailure>>;
  readonly patchState: (id: string, patch: unknown) => Result<Fields, MotionFailure>;
  readonly inMindText: () => string;
  readonly tickNote: () => string;
};

export type MotionOptions = {
  readonly memory: Pick<Memory, "ready" | "withThread" | "indexText">;
  readonly store: Store;
  readonly kinds: Kinds;
  readonly clock: Clock;
  readonly picturePath: (attachment: string) => string;
  readonly approve: (fields: AskFields) => Promise<boolean>;
  readonly recordStep: (facts: StepFacts) => boolean;
  readonly info: Info;
};

type Saved = { readonly kind: Kind; readonly card: Card; readonly status: "active" | "done"; readonly content: Fields };

const idPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

const recentNotes = 5;

const changesShown = 20;

const fieldOf = (value: unknown, field: string): unknown =>
  value && typeof value === "object" ? Reflect.get(value, field) : undefined;

const textOf = (value: unknown, field: string): string => {
  const text = fieldOf(value, field);
  return typeof text === "string" ? text.replaceAll(/\s+/gu, " ").trim() : "";
};

const failed = (text: string): ToolResult => ({ text, isError: true });

const isObject = (value: unknown): value is Fields =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const folderOf = (id: string): string => `motion/${id}`;

const pictureFile = (id: string, attachment: string): string => `${folderOf(id)}/pictures/${attachment}`;

const allIds = (content: Fields): readonly string[] =>
  listsOf(content)
    .values()
    .flatMap((items) => items.map((item) => item.id))
    .toArray();

const duplicateOf = (id: string, content: Fields): string | undefined => {
  const lists = listsOf(content);
  const ids = [id, ...Object.keys(content).filter((field) => lists.has(field)), ...allIds(content)];
  return ids.find((candidate, index) => ids.indexOf(candidate) !== index);
};

const photosIn = (value: unknown): readonly string[] => {
  if (Array.isArray(value)) return value.flatMap((item) => photosIn(item));
  if (!isObject(value)) return [];
  const own = typeof value.attachment === "string" && typeof value.credit === "string" ? [value.attachment] : [];
  return [...own, ...Object.values(value).flatMap((child) => photosIn(child))];
};

const wordsIn = (value: unknown, field = ""): readonly string[] => {
  if (typeof value === "string") {
    return ["id", "attachment", "url", "source_url", "place", "timezone"].includes(field) ? [] : [value];
  }
  if (Array.isArray(value)) return value.flatMap((item) => wordsIn(item, field));
  return isObject(value) ? Object.entries(value).flatMap(([key, child]) => wordsIn(child, key)) : [];
};

const nameOfItem = (item: Fields | undefined, id: string): string =>
  [item?.text, item?.title, item?.name].find((name): name is string => typeof name === "string") ?? id;

const commitsOf = async (thread: Thread, id: string): Promise<readonly string[]> => {
  const history = await thread.history(folderOf(id));
  const forgotten = history.findIndex(({ isDeleted }) => isDeleted);
  return (forgotten === -1 ? history : history.slice(0, forgotten)).map(({ commit }) => commit).toReversed();
};

const versionOf = async (thread: Thread, id: string): Promise<number> => {
  const commits = await commitsOf(thread, id);
  return commits.length;
};

const answer = (result: Result<string, string>): ToolResult =>
  result.ok ? { text: result.value } : failed(result.failure);

const doneIn = (state: Fields, list: string, item: string): unknown => {
  const entries = state[list];
  return isObject(entries) ? fieldOf(entries[item], "done") : undefined;
};

const tickedIn = (content: Fields, before: Fields, after: Fields): readonly string[] => {
  const lists = itemsByField(content);
  return Object.entries(after)
    .flatMap(([list, entries]) => Object.keys(isObject(entries) ? entries : {}).map((item) => ({ list, item })))
    .filter(({ list, item }) => typeof doneIn(after, list, item) === "boolean")
    .filter(({ list, item }) => doneIn(after, list, item) !== doneIn(before, list, item))
    .map(({ list, item }) => {
      const written = lists.get(list)?.find((candidate) => candidate.id === item);
      return `${doneIn(after, list, item) === true ? "ticked" : "unticked"} ${nameOfItem(written, item)}`;
    });
};

const toChanges = (given: unknown): readonly Change[] => (Array.isArray(given) ? (given as readonly Change[]) : []);

export const createMotions = ({
  memory,
  store,
  kinds,
  clock,
  picturePath,
  approve,
  recordStep,
  info,
}: MotionOptions): Motions => {
  const saved = createCell<ReadonlyMap<string, Saved>>(new Map());
  const indexing = createCell<Promise<void>>(Promise.resolve());

  const remember = (id: string, thing: Saved | undefined): void => {
    saved.update(
      (current) => new Map(thing ? [...current, [id, thing]] : [...current].filter(([other]) => other !== id)),
    );
  };

  const readSaved = (text: { readonly card?: string; readonly content?: string }): Saved | undefined => {
    if (text.card === undefined || text.content === undefined) return undefined;
    const card = JSON.parse(text.card) as Fields;
    const kind = String(card.kind);
    if (!kinds.isKind(kind)) return undefined;
    return {
      kind,
      card: { title: String(card.title), summary: String(card.summary), pinned: card.pinned === true },
      status: card.status === "done" ? "done" : "active",
      content: JSON.parse(text.content) as Fields,
    };
  };

  const readNow = (thread: Thread, id: string): Saved | undefined =>
    readSaved({
      card: thread.read(`${folderOf(id)}/motion.json`),
      content: thread.read(`${folderOf(id)}/content.json`),
    });

  const readAt = async (thread: Thread, id: string, version: number): Promise<Saved | undefined> => {
    const commits = await commitsOf(thread, id);
    const commit = commits[version - 1];
    if (commit === undefined) return undefined;
    return readSaved({
      card: await thread.readAt(commit, `${folderOf(id)}/motion.json`),
      content: await thread.readAt(commit, `${folderOf(id)}/content.json`),
    });
  };

  const index = async (id: string, thing: Saved | undefined): Promise<void> => {
    try {
      await memory.indexText(
        `motion:${id}`,
        thing?.card.title ?? id,
        thing && [thing.card.title, thing.card.summary, ...wordsIn(thing.content)].join("\n\n"),
      );
    } catch (error) {
      info("A thing in motion couldn't be added to memory's search", { motion: id, error: String(error) });
    }
  };

  const write = async (
    thread: Thread,
    id: string,
    thing: Saved,
    message: string,
  ): Promise<Result<undefined, string>> => {
    const used = new Set(photosIn(thing.content));
    const pictures = [...used]
      .filter((attachment) => !existsSync(path.join(thread.directory, pictureFile(id, attachment))))
      .filter((attachment) => existsSync(picturePath(attachment)))
      .map((attachment) => ({ file: pictureFile(id, attachment), text: readFileSync(picturePath(attachment)) }));
    const before = readNow(thread, id);
    const dropped = before ? photosIn(before.content).filter((attachment) => !used.has(attachment)) : [];
    const card = { kind: thing.kind, ...thing.card, status: thing.status };
    const written = await thread.writeFiles(
      [
        { file: `${folderOf(id)}/motion.json`, text: `${JSON.stringify(card, undefined, 2)}\n` },
        { file: `${folderOf(id)}/content.json`, text: `${JSON.stringify(thing.content, undefined, 2)}\n` },
        ...pictures,
      ],
      message,
      [...new Set(dropped)].map((attachment) => pictureFile(id, attachment)),
    );
    return written.ok ? ok(undefined) : fail(written.failure);
  };

  const toMotion = (
    id: string,
    thing: Saved,
    version: number,
    existing: Motion | undefined,
  ): Omit<Motion, "position"> => {
    const at = toTimestamp(clock.now());
    const cover = fieldOf(thing.content.cover, "attachment");
    const doneAt = thing.status === "done" ? (existing?.done_at ?? at) : undefined;
    return {
      id,
      kind: thing.kind,
      title: thing.card.title,
      summary: thing.card.summary,
      status: thing.status,
      pinned: thing.card.pinned,
      ...(typeof cover === "string" && { cover }),
      version,
      started_at: existing?.started_at ?? at,
      changed_at: at,
      ...(doneAt !== undefined && { done_at: doneAt }),
      ...(existing && { position: existing.position }),
    };
  };

  const queueIndex = (id: string, thing: Saved | undefined): void => {
    void indexing.update(async (previous) => {
      await previous;
      await index(id, thing);
    });
  };

  const readVersion = async (id: string, version: number): Promise<Saved | undefined> => {
    try {
      return await memory.withThread((thread) => readAt(thread, id, version));
    } catch (error) {
      info("An earlier version of a thing in motion couldn't be read", { motion: id, error: String(error) });
      return undefined;
    }
  };

  const record = (
    type: "motion.started" | "motion.changed" | "motion.finished",
    id: string,
    thing: Saved,
    version: number,
    note: string,
  ): Motion => {
    const { motion } = store.recordMotion(type, toMotion(id, thing, version, store.findMotion(id)), note);
    remember(id, thing);
    const state = store.motionState(id);
    const pruned = pruneState(state, thing.content);
    if (JSON.stringify(pruned) !== JSON.stringify(state)) store.setMotionState(id, pruned);
    queueIndex(id, thing);
    return motion;
  };

  const step = (action: StepFacts["action"], motion: Motion, note?: string): void => {
    recordStep({
      action,
      motion: motion.id,
      version: motion.version,
      pages: [{ address: `motion:${motion.id}`, title: motion.title }],
      ...(note !== undefined && { note }),
    });
  };

  const checked = (kind: Kind, id: string, content: Fields): Result<undefined, string> => {
    const shape = kinds.checkContent(kind, content);
    if (!shape.ok) return shape;
    const twice = duplicateOf(id, content);
    if (twice !== undefined) return fail(`${twice} is used twice: every id in a thing is its own.`);
    const dangling = danglingIds(content);
    return dangling.length === 0
      ? ok(undefined)
      : fail(`It names ${dangling.join(", ")}, which isn't in this thing: add it, or name one that is.`);
  };

  const start = (input: unknown): Promise<Result<Motion, string>> =>
    memory.withThread(async (thread) => {
      const id = textOf(input, "id");
      if (!idPattern.test(id)) return fail("Give it an id of lowercase words joined by dashes, such as florence-trip.");
      const kind = textOf(input, "kind");
      if (!kinds.isKind(kind)) return fail(`${kind || "That"} isn't a kind of thing yet: use trip or training.`);
      const title = textOf(input, "title");
      const note = textOf(input, "note");
      if (title === "" || note === "") return fail("Give it a title and a note.");
      if (store.findMotion(id) || readNow(thread, id)) {
        return fail(`${id} is already a thing in motion: read it with read_motion and change it, or pick another id.`);
      }
      const content = fieldOf(input, "content");
      if (!isObject(content)) return fail("Give the whole content, as its kind describes.");
      const valid = checked(kind, id, content);
      if (!valid.ok) return valid;
      const thing: Saved = {
        kind,
        card: { title, summary: textOf(input, "summary"), pinned: true },
        status: "active",
        content,
      };
      const written = await write(thread, id, thing, `${title}: ${note}`);
      return written.ok ? ok(record("motion.started", id, thing, 1, note)) : written;
    });

  const change = (input: unknown): Promise<Result<Motion, string>> =>
    memory.withThread(async (thread) => {
      const id = textOf(input, "id");
      const note = textOf(input, "note");
      const current = readNow(thread, id);
      if (!current) return fail(`There's no thing ${id || "with that id"} in motion.`);
      if (note === "") return fail("Give a note: what this change does, in a few words.");
      const version = await versionOf(thread, id);
      if (fieldOf(input, "version") !== version) {
        return fail(
          `${current.card.title} has changed since you read it: it's at version ${String(version)} now. Read it again, then change it.`,
        );
      }
      const given = fieldOf(input, "changes");
      const shape = kinds.checkChanges(given);
      if (!shape.ok) return shape;
      const applied = applyChanges(id, { card: current.card, content: current.content }, toChanges(given));
      if (!applied.ok) return applied;
      const { title, summary: line, pinned } = applied.value.card as Readonly<Record<string, unknown>>;
      if (typeof title !== "string" || title === "" || typeof line !== "string" || typeof pinned !== "boolean") {
        return fail("A thing's title and summary are text, and pinned is true or false.");
      }
      const summary = textOf(input, "summary");
      const thing: Saved = {
        ...current,
        card: summary === "" ? applied.value.card : { ...applied.value.card, summary },
        content: applied.value.content,
      };
      if (JSON.stringify(thing) === JSON.stringify(current))
        return fail(`${current.card.title} already says exactly that.`);
      const valid = checked(current.kind, id, thing.content);
      if (!valid.ok) return valid;
      const written = await write(thread, id, thing, `${thing.card.title}: ${note}`);
      return written.ok ? ok(record("motion.changed", id, thing, version + 1, note)) : written;
    });

  const finish = (input: unknown): Promise<Result<Motion, string>> =>
    memory.withThread(async (thread) => {
      const id = textOf(input, "id");
      const note = textOf(input, "note");
      const current = readNow(thread, id);
      if (!current) return fail(`There's no thing ${id || "with that id"} in motion.`);
      if (current.status === "done") return fail(`${current.card.title} is already done.`);
      if (note === "") return fail("Give a note, such as “Home from Florence”.");
      const thing: Saved = { ...current, status: "done", card: { ...current.card, pinned: false } };
      const version = (await versionOf(thread, id)) + 1;
      const written = await write(thread, id, thing, `${thing.card.title}: ${note}`);
      return written.ok ? ok(record("motion.finished", id, thing, version, note)) : written;
    });

  const restore = (input: unknown): Promise<Result<Motion, string>> =>
    memory.withThread(async (thread) => {
      const id = textOf(input, "id");
      const note = textOf(input, "note");
      const wanted = fieldOf(input, "version");
      const current = readNow(thread, id);
      if (!current) return fail(`There's no thing ${id || "with that id"} in motion.`);
      if (note === "") return fail("Give a note: why you're bringing it back.");
      const earlier = typeof wanted === "number" ? await readAt(thread, id, wanted) : undefined;
      if (!earlier) return fail(`${current.card.title} has no version ${String(wanted)}.`);
      if (JSON.stringify(earlier) === JSON.stringify(current))
        return fail(`${current.card.title} already is that version.`);
      const version = (await versionOf(thread, id)) + 1;
      const written = await write(thread, id, earlier, `${earlier.card.title}: ${note}`);
      return written.ok ? ok(record("motion.changed", id, earlier, version, note)) : written;
    });

  const forget = async (input: unknown): Promise<Result<string, string>> => {
    const id = textOf(input, "id");
    const reason = textOf(input, "reason");
    const motion = store.findMotion(id);
    if (!motion) return fail(`There's no thing ${id || "with that id"} in motion.`);
    if (reason === "") return fail("Say why it should go.");
    const isAllowed = await approve({
      kind: "approval",
      question: `Forget ${motion.title}?`,
      options: [{ label: "Forget it", acts: true }, { label: "Keep it" }],
      allows_text: true,
      preview: `${motion.title}: ${reason}`,
      secret: false,
    });
    if (!isAllowed) return ok(`They kept ${motion.title}, so nothing was forgotten.`);
    return memory.withThread(async (thread) => {
      if (!store.findMotion(id)) return ok(`${motion.title} is already forgotten.`);
      if (readNow(thread, id)) {
        const removed = await thread.writeFiles([], `Forget ${motion.title}: ${reason}`, [folderOf(id)]);
        if (!removed.ok) return fail(removed.failure);
      }
      store.removeMotion(id);
      remember(id, undefined);
      queueIndex(id, undefined);
      step("forgotten", motion);
      return ok(`Forgot ${motion.title}.`);
    });
  };

  const describe = (id: string, thing: Saved, version: number, isLatest: boolean): string => {
    const state = store.motionState(id);
    const notes = store.motionChanges(id, recentNotes).map(({ version: at, note }) => `- ${String(at)}: ${note}`);
    return [
      `${id} (${thing.kind}), version ${String(version)}${isLatest ? "" : " (an earlier version)"}, ${thing.status}` +
        (thing.card.pinned ? ", pinned" : ""),
      `title: ${thing.card.title}`,
      `summary: ${thing.card.summary}`,
      "content:",
      JSON.stringify(thing.content, undefined, 2),
      ...(Object.keys(state).length > 0
        ? ["their ticks, which win over the content's own:", JSON.stringify(state)]
        : []),
      ...(isLatest && notes.length > 0 ? ["what changed lately:", ...notes] : []),
    ].join("\n");
  };

  const read = (input: unknown): Promise<Result<string, string>> =>
    memory.withThread(async (thread) => {
      const id = textOf(input, "id");
      const current = readNow(thread, id);
      if (!current) return fail(`There's no thing ${id || "with that id"} in motion.`);
      const latest = await versionOf(thread, id);
      const wanted = fieldOf(input, "version");
      if (wanted === undefined) return ok(describe(id, current, latest, true));
      const earlier = typeof wanted === "number" ? await readAt(thread, id, wanted) : undefined;
      return earlier
        ? ok(describe(id, earlier, Number(wanted), wanted === latest))
        : fail(`${current.card.title} has no version ${JSON.stringify(wanted)}.`);
    });

  const changesSchema = {
    type: "array",
    description:
      "Each one of: {set: id, fields: {…}} sets fields of an item (null removes one), or of the thing itself by its " +
      "own id; {add: item with a new id, to: list, after?: id} adds it after that item, or first; {move: id, to?: " +
      "list, after?: id}; {remove: id}. A list is named by its field, such as todo or places, or for a day's stops " +
      "by the day's id.",
    items: { type: "object" },
  };

  const tools: readonly Tool[] = [
    {
      name: "start_motion",
      title: "Start a thing in motion",
      description:
        "Start something going on that the person will come back to, such as a trip being planned: a plan with " +
        "several steps that will outlast this conversation, or whenever they ask you to pin something. Give its " +
        "whole content once, as the Things in motion skill describes for its kind, with an id on every item. It's " +
        "pinned above their chat until it's done.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "Lowercase words and dashes, such as florence-with-janki." },
          kind: { type: "string", enum: ["trip", "training"] },
          title: { type: "string", description: "Such as Florence with Janki." },
          summary: { type: "string", description: "Where it stands, in one line, such as “6–9 Nov · 4 to book”." },
          content: { type: "object", description: "The whole content, as its kind describes." },
          note: { type: "string", description: "What you did, in a few words, such as “Started the trip”." },
        },
        required: ["id", "kind", "title", "summary", "content", "note"],
        additionalProperties: false,
      },
      call: async (input) => {
        const started = await start(input);
        if (!started.ok) return failed(started.failure);
        step("started", started.value);
        return { text: `Started ${started.value.title} as ${started.value.id}, at version 1.` };
      },
    },
    {
      name: "change_motion",
      title: "Change a thing in motion",
      description:
        "Change a thing you've read, item by item, citing the version read_motion gave you. All of a change " +
        "applies, or none of it. Keep its summary current with every change. When the person tells you something " +
        "that ticks an item, such as “booked the Uffizi”, change it here.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string" },
          version: { type: "integer", description: "The version you read." },
          changes: changesSchema,
          summary: { type: "string", description: "Where it stands now, in one line, when that changed." },
          note: { type: "string", description: "What this change does, such as “Booked the Uffizi, 8:15 Saturday”." },
        },
        required: ["id", "version", "changes", "note"],
        additionalProperties: false,
      },
      call: async (input) => {
        const changed = await change(input);
        if (!changed.ok) return failed(changed.failure);
        step("updated", changed.value, textOf(input, "note"));
        return { text: `Saved ${changed.value.title}, now at version ${String(changed.value.version)}.` };
      },
    },
    {
      name: "read_motion",
      title: "Read a thing in motion",
      description:
        "Read a thing in motion: its content with every id, its version, the person's ticks and what changed " +
        "lately. Read it before you change it. Give a version to read it as it was then.",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string" }, version: { type: "integer" } },
        required: ["id"],
        additionalProperties: false,
      },
      call: async (input) => answer(await read(input)),
    },
    {
      name: "finish_motion",
      title: "Finish a thing in motion",
      description: "Move a thing to Done once it's over, such as a trip they're home from. It stops being pinned.",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string" }, note: { type: "string" } },
        required: ["id", "note"],
        additionalProperties: false,
      },
      call: async (input) => {
        const finished = await finish(input);
        if (!finished.ok) return failed(finished.failure);
        step("finished", finished.value);
        return { text: `Finished ${finished.value.title}.` };
      },
    },
    {
      name: "restore_motion",
      title: "Bring back an earlier version",
      description:
        "Bring a thing back as it was at an earlier version, as a new change: the undo for a change that was " +
        "wrong. read_motion shows what changed, and reads an earlier version.",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string" }, version: { type: "integer" }, note: { type: "string" } },
        required: ["id", "version", "note"],
        additionalProperties: false,
      },
      call: async (input) => {
        const restored = await restore(input);
        if (!restored.ok) return failed(restored.failure);
        step("restored", restored.value);
        return {
          text: `Brought back version ${String(fieldOf(input, "version"))} of ${restored.value.title}, now at version ${String(restored.value.version)}.`,
        };
      },
    },
    {
      name: "forget_motion",
      title: "Forget a thing in motion",
      description:
        "Forget a whole thing, after asking the person: this asks them for approval and waits for their answer. " +
        "To end one that's over, finish it instead.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string" },
          reason: { type: "string", description: "Why it should go, in a few words, said to the person." },
        },
        required: ["id", "reason"],
        additionalProperties: false,
      },
      call: async (input) => answer(await forget(input)),
    },
  ];

  const ready = (async (): Promise<void> => {
    await memory.ready;
    try {
      await memory.withThread((thread) => {
        for (const motion of store.listMotions()) remember(motion.id, readNow(thread, motion.id));
        return Promise.resolve();
      });
    } catch (error) {
      info("Things in motion couldn't be read as the server started", { error: String(error) });
      return;
    }
    for (const [id, thing] of saved.get()) queueIndex(id, thing);
  })();

  return {
    ready,
    tools,
    list: () => store.listMotions(),
    detail: async (id, version) => {
      const motion = store.findMotion(id);
      if (!motion) return fail({ code: "not_found", detail: `There's no thing ${id} in motion.` });
      const thing = version === undefined ? saved.get().get(id) : await readVersion(id, version);
      if (!thing) return fail({ code: "not_found", detail: `${motion.title} has no version ${String(version)}.` });
      return ok({
        motion,
        content: thing.content,
        state: store.motionState(id),
        changes: store.motionChanges(id, changesShown),
      });
    },
    patchState: (id, patch) => {
      const thing = saved.get().get(id);
      if (!thing) return fail({ code: "not_found", detail: `There's no thing ${id} in motion.` });
      const state = mergePatch(store.motionState(id), patch);
      const shape = kinds.checkState(thing.kind, state);
      if (!shape.ok) return fail({ code: "invalid", detail: shape.failure });
      const fields = state as Fields;
      const stray = strayIds(fields, thing.content);
      if (stray.length > 0) {
        return fail({ code: "not_found", detail: `${thing.card.title} has no item ${stray.join(", ")}.` });
      }
      if (JSON.stringify(fields) !== JSON.stringify(store.motionState(id))) store.setMotionState(id, fields);
      return ok(fields);
    },
    inMindText: () => {
      const active = store.listMotions().filter(({ status }) => status === "active");
      return active.length === 0
        ? ""
        : [
            "<in_motion>",
            "Things in motion you keep for them. Read one with read_motion before you change it.",
            ...active.map(({ id, title, kind, summary }) => `- ${title} (${id}, ${kind}): ${summary}`),
            "</in_motion>",
          ].join("\n");
    },
    tickNote: () => {
      const ticks = store
        .motionTicksSinceLastTurn()
        .map(({ motion, before, after }) => ({ thing: saved.get().get(motion), before, after }))
        .filter(
          (entry): entry is { readonly thing: Saved; readonly before: Fields; readonly after: Fields } =>
            entry.thing !== undefined,
        )
        .map(({ thing, before, after }) => ({ title: thing.card.title, said: tickedIn(thing.content, before, after) }))
        .filter(({ said }) => said.length > 0)
        .map(({ title, said }) => `in ${title}, you ${said.join(", ")}`);
      return ticks.length === 0 ? "" : `(Since your last reply: ${ticks.join("; ")}.)`;
    },
  };
};
