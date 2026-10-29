import { statSync } from "node:fs";
import path from "node:path";
import { createCell } from "#cell.ts";
import { toTimestamp, type Cancel, type Clock } from "#clock.ts";
import type { AskFields, JsonSchema, StepFacts } from "#engine/engine.ts";
import type { Identifiers } from "#identifiers.ts";
import type { Embedder } from "#memory/embedder.ts";
import { applyEdit, isSameVersion, isSharplyShorter, numberLines, toVersion, type BodyEdit } from "#memory/edits.ts";
import {
  circleSchema,
  circlesPerRequest,
  toCirclePrompt,
  toGroupAddress,
  toSorted,
  type CirclePage,
  type Sorted,
} from "#memory/circles.ts";
import {
  gistGuide,
  gistSchema,
  gistsPerRequest,
  toGistPrompt,
  toGists,
  toOneLine,
  type GistPage,
} from "#memory/gists.ts";
import {
  appendEntry,
  dayTitle,
  formatPage,
  inMindLimit,
  inMindPages,
  inMindTitles,
  parsePage,
  shelves,
  toAddress,
  toDay,
  toJournalEntry,
  toLocation,
  toMarkdown,
  toTimeOfDay,
  type InMindPage,
  type Location,
  type Page,
  type Shelf,
} from "#memory/pages.ts";
import { mentions, toBoosted, toVocabulary, type Learned } from "#memory/vocabulary.ts";
import { rank, toMessageChunk, toPageChunks, type Passage } from "#memory/recall.ts";
import { openThread, type Thread } from "#memory/thread.ts";
import { withoutBlocks } from "#replies/blocks.ts";
import { fail, ok, type Result } from "#result.ts";
import type { MemoryStore } from "#store/memory.ts";
import type { Settings } from "#store/store.ts";
import type { Term } from "#memory/vocabulary.ts";
import type { Tool, ToolResult } from "#tools/mcp.ts";
import type { Info } from "#turns/turns.ts";

export type LinkBody = { readonly address: string; readonly title: string; readonly aliases: readonly string[] };

export type PageBody = {
  readonly address: string;
  readonly title: string;
  readonly gist?: string;
  readonly circle?: string;
  readonly shelf: Shelf | InMindPage;
  readonly aliases: readonly string[];
  readonly links: readonly LinkBody[];
  readonly changed_at: string;
  readonly markdown: string;
};

type ReadPage = Omit<PageBody, "links"> & { readonly links: readonly string[] };

export type PageSummary = {
  readonly address: string;
  readonly title: string;
  readonly gist?: string;
  readonly circle?: string;
  readonly changed_at: string;
};

export type RecentChangeBody = {
  readonly change: string;
  readonly address: string;
  readonly title: string;
  readonly at: string;
  readonly note?: string;
};

export type ChangeBody = {
  readonly change: string;
  readonly address: string;
  readonly title: string;
  readonly at: string;
  readonly before?: string;
  readonly after?: string;
};

export type SeededPage = {
  readonly address: string;
  readonly title: string;
  readonly gist?: string;
  readonly circle?: string;
  readonly note?: string;
  readonly aliases: readonly string[];
  readonly links: readonly string[];
  readonly markdown: string;
};

export type Memory = {
  readonly ready: Promise<void>;
  readonly tools: readonly Tool[];
  readonly inMindText: () => string;
  readonly inMind: () => readonly PageBody[];
  readonly shelves: () => readonly { readonly shelf: Shelf; readonly count: number }[];
  readonly pages: (shelf: Shelf) => readonly PageSummary[];
  readonly recent: () => readonly RecentChangeBody[];
  readonly page: (
    address: string,
  ) => Result<PageBody, { readonly code: "invalid" | "not_found"; readonly detail: string }>;
  readonly change: (id: string) => Promise<ChangeBody | undefined>;
  readonly seed: (page: SeededPage) => Promise<Result<string, string>>;
  readonly isBackedUp: () => boolean;
  readonly indexConversation: () => void;
  readonly sync: () => Promise<void>;
  readonly vocabulary: () => Promise<readonly Term[]>;
  readonly boosted: (terms: readonly Term[]) => readonly string[];
  readonly learn: (corrections: readonly Correction[]) => Promise<readonly Learnt[]>;
  readonly withThread: <Value>(work: (thread: Thread) => Promise<Value>) => Promise<Value>;
  readonly indexText: (address: string, title: string, text: string | undefined) => Promise<void>;
  readonly close: () => Promise<void>;
};

export type Correction = { readonly heard: string; readonly meant: string };

export type Learnt = Correction & { readonly address?: string };

export type MemoryOptions = {
  readonly directory: string;
  readonly store: MemoryStore;
  readonly settings: Settings;
  readonly clock: Clock;
  readonly identifiers: Identifiers;
  readonly embedder: Embedder;
  readonly recordStep: (facts: StepFacts) => boolean;
  readonly approve: (fields: AskFields) => Promise<boolean>;
  readonly info: Info;
  readonly timeZone: string;
  readonly complete?: (prompt: string, schema: JsonSchema) => Promise<Result<unknown, string>>;
  readonly pushDelayMs?: number;
};

const indexModelSetting = "memory_index_model";
const indexedSetting = "memory_indexed_commit";
const learnedSetting = "vocabulary_learned";
const pushedAtSetting = "memory_pushed_at";
const failingSinceSetting = "memory_push_failing_since";
const dayMs = 24 * 60 * 60 * 1000;
const longestPushDelayMs = 60 * 60 * 1000;
const passagesPerRecall = 6;
const recentChanges = 20;
const boostDays = 28;
const boostMessages = 200;

type Complete = NonNullable<MemoryOptions["complete"]>;

const batchesOf = <Item>(items: readonly Item[], size: number): readonly (readonly Item[])[] =>
  Array.from({ length: Math.ceil(items.length / size) }, (_, index) => items.slice(index * size, (index + 1) * size));

const fieldOf = (value: unknown, field: string): unknown =>
  value && typeof value === "object" ? Reflect.get(value, field) : undefined;

const textOf = (value: unknown, field: string): string => {
  const text = fieldOf(value, field);
  return typeof text === "string" ? text : "";
};

const stringsOf = (value: unknown, field: string): readonly string[] => {
  const list = fieldOf(value, field);
  return Array.isArray(list) ? list.filter((item): item is string => typeof item === "string") : [];
};

const isInMindPage = (shelf: Shelf | InMindPage): shelf is InMindPage =>
  (inMindPages as readonly string[]).includes(shelf);

const toPageReference = ({
  address,
  title,
}: {
  readonly address: string;
  readonly title: string;
}): StepFacts["pages"] => [{ address, title }];

const failed = (text: string): ToolResult => ({ text, isError: true });

const missingField: Readonly<Record<string, string>> = {
  gist: "Give the page a gist: what it is now, in one line.",
  note: "Give a note: what this change does, in a few words.",
  circle: "Give them a circle: who they are to the person, such as family, friends or work.",
};

const toMissing = (input: unknown, fields: readonly string[]): string | undefined => {
  const missing = fields.filter((field) => textOf(input, field).trim() === "").map((field) => missingField[field]);
  return missing.length === 0 ? undefined : missing.join(" ");
};

const onlyPeople = "Only a page about one person has a circle.";

const circleGuide =
  "Who they are to the person, in a few words you reuse across people, such as family, friends, work or " +
  "running club.";

const tooLong = (title: string, length: number): string =>
  `${title} is ${String(length)} characters, over the ${String(inMindLimit)} it can hold. Keep it to what matters ` +
  "on every turn, and move the detail to a page on a shelf.";

const formatPassage = (passage: Passage, index: number): string =>
  `${String(index + 1)}. ${passage.title} (${passage.address}, ${passage.at.slice(0, 10)})\n${passage.text}`;

const fallbackTitle = (location: Location): string =>
  isInMindPage(location.shelf)
    ? inMindTitles[location.shelf]
    : location.shelf === "journal"
      ? dayTitle(location.path.slice("journal/".length, -".md".length))
      : path.basename(location.path, ".md");

export const createMemory = ({
  directory,
  store,
  settings,
  clock,
  identifiers,
  embedder,
  recordStep,
  approve,
  info,
  timeZone,
  complete,
  pushDelayMs = 30_000,
}: MemoryOptions): Memory => {
  const thread = createCell<Thread | undefined>(undefined);
  const writes = createCell<Promise<unknown>>(Promise.resolve());
  const pushTimer = createCell<Cancel | undefined>(undefined);
  const pushAttempts = createCell(0);
  const hasRemote = createCell(false);
  const isClosed = createCell(false);
  const tidying = createCell<Promise<void> | undefined>(undefined);
  const isUntidy = createCell(false);

  const opened = (): Thread => {
    const current = thread.get();
    if (!current) throw new Error("The Thread isn't open yet.");
    return current;
  };

  const serially = <Value>(work: () => Promise<Value>): Promise<Value> => {
    const run = async (): Promise<Value> => {
      try {
        await writes.get();
      } catch {
        info("A memory write before this one failed", {});
      }
      return work();
    };
    const next = run();
    writes.set(next);
    return next;
  };

  const changedAt = createCell<ReadonlyMap<string, string>>(new Map());
  const refreshChangedAt = (): void => {
    changedAt.set(new Map(store.latestChanges().map(({ address, at }) => [address, at])));
  };

  const fileChangedAt = (location: Location): string => {
    const known = changedAt.get().get(location.address);
    if (known !== undefined) return known;
    const { mtimeMs } = statSync(path.join(opened().directory, location.path));
    return toTimestamp(mtimeMs);
  };

  const readParsed = (location: Location): Page | undefined => {
    const text = opened().read(location.path);
    return text === undefined ? undefined : parsePage(text, fallbackTitle(location));
  };

  const readPage = (location: Location): ReadPage | undefined => {
    const page = readParsed(location);
    if (!page) return undefined;
    const { title, gist, circle, aliases, links, markdown } = page;
    return {
      address: location.address,
      shelf: location.shelf,
      title,
      ...(gist !== undefined && { gist }),
      ...(circle !== undefined && { circle }),
      aliases,
      links,
      markdown,
      changed_at: fileChangedAt(location),
    };
  };

  const toLink = (address: string): LinkBody | undefined => {
    const location = toLocation(address);
    if (!location.ok) return undefined;
    const page = readParsed(location.value);
    return page && { address: location.value.address, title: page.title, aliases: page.aliases };
  };

  const toPageBody = (page: ReadPage): PageBody => ({
    ...page,
    links: page.links.map((address) => toLink(address)).filter((link) => link !== undefined),
  });

  const indexPage = async (location: Location, title: string, markdown: string | undefined): Promise<void> => {
    if (markdown === undefined || isInMindPage(location.shelf)) {
      store.replaceChunks(location.address, []);
      return;
    }
    const chunks = toPageChunks(location.address, title, markdown, toTimestamp(clock.now()));
    const vectors = await embedder.passages(chunks.map((chunk) => chunk.text));
    store.replaceChunks(
      location.address,
      chunks.map((chunk, index) => ({ ...chunk, ...(vectors[index] && { vector: vectors[index] }) })),
    );
  };

  const isBackedUp = (): boolean => {
    const failingSince = settings.setting(failingSinceSetting) ?? "";
    return hasRemote.get() && (failingSince === "" || clock.now() - Date.parse(failingSince) < dayMs);
  };

  const push = async (): Promise<void> => {
    pushTimer.set(undefined);
    if (isClosed.get()) return;
    hasRemote.set(await opened().hasRemote());
    if (!hasRemote.get()) return;
    const pushed = await opened().push();
    if (pushed.ok) {
      settings.setSetting(pushedAtSetting, toTimestamp(clock.now()));
      settings.setSetting(failingSinceSetting, "");
      pushAttempts.set(0);
      return;
    }
    if (!settings.setting(failingSinceSetting)) settings.setSetting(failingSinceSetting, toTimestamp(clock.now()));
    const attempts = pushAttempts.update((count) => count + 1);
    info("Memory couldn't be pushed to its remote, so it'll try again", { attempts, error: pushed.failure });
    schedulePush(Math.min(pushDelayMs * 2 ** attempts, longestPushDelayMs));
  };

  const schedulePush = (delayMs = pushDelayMs): void => {
    if (pushTimer.get() || isClosed.get()) return;
    pushTimer.set(
      clock.after(delayMs, () => {
        void serially(push);
      }),
    );
  };

  const commit = async (
    location: Location,
    title: string,
    text: string | undefined,
    message: string,
    note: string | undefined,
  ): Promise<Result<string, string>> => {
    const committed = await opened().write(location.path, text, note ? `${message}\n\n${note}` : message);
    if (!committed.ok) return committed;
    const id = identifiers.change();
    const at = toTimestamp(clock.now());
    store.recordChange({
      id,
      address: location.address,
      title,
      file: location.path,
      commit: committed.value,
      ...(note !== undefined && { note }),
      at,
    });
    settings.setSetting(indexedSetting, committed.value);
    changedAt.update((current) => new Map([...current, [location.address, at]]));
    await indexPage(location, title, text === undefined ? undefined : parsePage(text, title).markdown);
    schedulePush();
    if (isUntidy.get()) startTidying();
    return ok(id);
  };

  const writePage = (input: unknown): Promise<Result<{ readonly title: string; readonly change: string }, string>> =>
    serially(async () => {
      const location = toLocation(textOf(input, "address").trim());
      if (!location.ok) return location;
      const isFixed = isInMindPage(location.value.shelf);
      const existing = readPage(location.value);
      const title = isFixed
        ? fallbackTitle(location.value)
        : textOf(input, "title").trim() || (existing?.title ?? fallbackTitle(location.value));
      const markdown = toMarkdown(textOf(input, "body"));
      if (isFixed && markdown.length > inMindLimit) return fail(tooLong(title, markdown.length));
      const gist = toOneLine(textOf(input, "gist")) || existing?.gist;
      const note = toOneLine(textOf(input, "note")) || undefined;
      const circle = toOneLine(textOf(input, "circle")) || existing?.circle;
      const text =
        markdown === ""
          ? undefined
          : formatPage({
              title,
              ...(gist !== undefined && { gist }),
              ...(circle !== undefined && { circle }),
              aliases: stringsOf(input, "aliases"),
              links: stringsOf(input, "links"),
              heard: readParsed(location.value)?.heard ?? [],
              markdown,
            });
      if (text === opened().read(location.value.path)) return fail(`${title} already says exactly that.`);
      const verb = text === undefined ? "Delete" : existing ? "Update" : "Add";
      const committed = await commit(location.value, title, text, `${verb} ${title}`, note);
      return committed.ok ? ok({ title, change: committed.value }) : committed;
    });

  const writeJournal = (
    input: unknown,
  ): Promise<Result<{ readonly address: string; readonly title: string }, string>> =>
    serially(async () => {
      const words = textOf(input, "text");
      if (words.trim() === "") return fail("A journal entry needs text.");
      const day = toDay(clock.now(), timeZone);
      const location = toLocation(`memory:journal/${day}`);
      if (!location.ok) return location;
      const title = dayTitle(day);
      const existing = readPage(location.value);
      const entry = toJournalEntry(words, fieldOf(input, "yours") === true, toTimeOfDay(clock.now(), timeZone));
      const text = formatPage({
        title,
        gist: toOneLine(textOf(input, "gist")),
        aliases: [],
        links: [],
        markdown: appendEntry(existing?.markdown ?? "", entry),
      });
      const committed = await commit(location.value, title, text, `Journal ${day}`, toOneLine(textOf(input, "note")));
      return committed.ok ? ok({ address: location.value.address, title }) : committed;
    });

  const currentVersion = async (location: Location): Promise<string | undefined> => {
    const [latest] = await opened().history(location.path, 1);
    return latest && !latest.isDeleted ? toVersion(latest.commit) : undefined;
  };

  const toBodyEdit = (input: unknown): Result<BodyEdit | undefined, string> => {
    const old = fieldOf(input, "old_text");
    const start = fieldOf(input, "start_line");
    const end = fieldOf(input, "end_line");
    if (typeof old === "string" && (start !== undefined || end !== undefined)) {
      return fail("Give either old_text or start_line and end_line, not both.");
    }
    const replacement = textOf(input, "new_text");
    if (typeof old === "string") return ok({ kind: "passage", old, new: replacement });
    if (typeof start === "number" && typeof end === "number")
      return ok({ kind: "lines", start, end, new: replacement });
    if (start !== undefined || end !== undefined) return fail("Give both start_line and end_line.");
    return ok(undefined);
  };

  const editPage = (
    input: unknown,
  ): Promise<Result<{ readonly title: string; readonly change: string; readonly version: string }, string>> =>
    serially(async () => {
      const location = toLocation(textOf(input, "address").trim());
      if (!location.ok) return location;
      const existing = readParsed(location.value);
      const version = await currentVersion(location.value);
      if (!existing || version === undefined) {
        return fail(`There's no page at ${location.value.address}. Make a new page with write_page.`);
      }
      if (!isSameVersion(textOf(input, "version").trim(), version)) {
        return fail(
          `${existing.title} has changed since you read it: it's at version ${version} now. Read it again, then edit.`,
        );
      }
      const bodyEdit = toBodyEdit(input);
      if (!bodyEdit.ok) return bodyEdit;
      const markdown = bodyEdit.value ? applyEdit(existing.markdown, bodyEdit.value) : ok(existing.markdown);
      if (!markdown.ok) return markdown;
      if (isSharplyShorter(existing.markdown, markdown.value)) {
        return fail(
          `That would remove more than half of ${existing.title}. Edit it a part at a time, or forget the page ` +
            "with forget_page if it should go.",
        );
      }
      const isFixed = isInMindPage(location.value.shelf);
      const title = isFixed ? existing.title : textOf(input, "title").trim() || existing.title;
      if (isFixed && markdown.value.length > inMindLimit) return fail(tooLong(title, markdown.value.length));
      const gist = toOneLine(textOf(input, "gist")) || existing.gist;
      const circle = toOneLine(textOf(input, "circle"));
      if (circle !== "" && location.value.shelf !== "people") return fail(onlyPeople);
      const listOr = (field: string, fallback: readonly string[]): readonly string[] =>
        Array.isArray(fieldOf(input, field)) ? stringsOf(input, field) : fallback;
      const text = formatPage({
        ...existing,
        title,
        ...(gist !== undefined && { gist }),
        ...(circle !== "" && { circle }),
        aliases: listOr("aliases", existing.aliases),
        links: listOr("links", existing.links),
        markdown: markdown.value,
      });
      if (text === opened().read(location.value.path)) return fail(`${title} already says exactly that.`);
      const committed = await commit(location.value, title, text, `Update ${title}`, toOneLine(textOf(input, "note")));
      return committed.ok
        ? ok({ title, change: committed.value, version: (await currentVersion(location.value)) ?? "" })
        : committed;
    });

  const writeNewPage = (
    input: unknown,
  ): Promise<Result<{ readonly title: string; readonly change: string; readonly version: string }, string>> =>
    serially(async () => {
      const location = toLocation(textOf(input, "address").trim());
      if (!location.ok) return location;
      const existing = readParsed(location.value);
      if (existing) {
        return fail(`${existing.title} is already a page. Read it with read_page, then change it with edit_page.`);
      }
      const markdown = toMarkdown(textOf(input, "body"));
      if (markdown === "") return fail("A new page needs a body.");
      const title = isInMindPage(location.value.shelf)
        ? fallbackTitle(location.value)
        : textOf(input, "title").trim() || fallbackTitle(location.value);
      if (isInMindPage(location.value.shelf) && markdown.length > inMindLimit) {
        return fail(tooLong(title, markdown.length));
      }
      const circle = toOneLine(textOf(input, "circle"));
      if (circle !== "" && location.value.shelf !== "people") return fail(onlyPeople);
      const text = formatPage({
        title,
        gist: toOneLine(textOf(input, "gist")),
        ...(circle !== "" && { circle }),
        aliases: stringsOf(input, "aliases"),
        links: stringsOf(input, "links"),
        markdown,
      });
      const committed = await commit(location.value, title, text, `Add ${title}`, toOneLine(textOf(input, "note")));
      return committed.ok
        ? ok({ title, change: committed.value, version: (await currentVersion(location.value)) ?? "" })
        : committed;
    });

  const forgetPage = (location: Location, title: string, reason: string): Promise<Result<string, string>> =>
    serially(() => commit(location, title, undefined, `Forget ${title}`, reason));

  const restorePage = (
    location: Location,
    version: string,
    note: string,
  ): Promise<Result<{ readonly title: string; readonly change: string; readonly version: string }, string>> =>
    serially(async () => {
      const text = await opened().readAt(version, location.path);
      if (text === undefined) return fail(`${location.address} has no version ${version}. See page_history.`);
      if (text === opened().read(location.path)) return fail("The page already says exactly that.");
      const { title } = parsePage(text, fallbackTitle(location));
      const committed = await commit(location, title, text, `Restore ${title}`, note);
      return committed.ok
        ? ok({ title, change: committed.value, version: (await currentVersion(location)) ?? "" })
        : committed;
    });

  const recall = async (query: string): Promise<readonly Passage[]> => {
    const chunks = store.chunks();
    const vector = await embedder.query(query);
    return rank(chunks, store.searchText(query, passagesPerRecall * 3), vector, passagesPerRecall).map(
      ({ address, title, text, at }) => ({ address, title, text, at }),
    );
  };

  const indexConversation = (): void => {
    void serially(async () => {
      const messages = store.unindexedMessages();
      if (messages.length === 0) return;
      const chunks = messages.map(({ id, role, text, at }) =>
        toMessageChunk(id, role === "user", withoutBlocks(text), at),
      );
      try {
        const vectors = await embedder.passages(chunks.map((chunk) => chunk.text));
        store.addChunks(
          chunks.map((chunk, index) => ({ ...chunk, ...(vectors[index] && { vector: vectors[index] }) })),
        );
      } catch (error) {
        info("Past conversations couldn't be added to memory's search yet", { error: String(error) });
      }
    });
  };

  const reindex = async (): Promise<void> => {
    store.clearChunks();
    for (const file of opened().files()) {
      const location = toLocation(toAddress(file));
      if (!location.ok) continue;
      const page = readPage(location.value);
      if (page) await indexPage(location.value, page.title, page.markdown);
    }
    settings.setSetting(indexModelSetting, embedder.model);
    indexConversation();
  };

  const catchUpWith = async (head: string, indexed: string): Promise<void> => {
    const changes = await opened().changedFiles(indexed, head);
    for (const { file, isDeleted } of changes) {
      const location = toLocation(toAddress(file));
      if (!location.ok) continue;
      const page = isDeleted ? undefined : readPage(location.value);
      await indexPage(location.value, page?.title ?? "", page?.markdown);
      if (!page) continue;
      const at = toTimestamp(clock.now());
      store.recordChange({
        id: identifiers.change(),
        address: page.address,
        title: page.title,
        file,
        commit: head,
        before: indexed,
        at,
      });
      changedAt.update((current) => new Map([...current, [page.address, at]]));
    }
  };

  const catchUp = async (): Promise<void> => {
    const head = await opened().head();
    const indexed = settings.setting(indexedSetting);
    if (head === indexed && settings.setting(indexModelSetting) === embedder.model) return;
    try {
      if (indexed === undefined || settings.setting(indexModelSetting) !== embedder.model) await reindex();
      else await catchUpWith(head, indexed);
    } catch (error) {
      info("Memory's search couldn't catch up with the Thread, so it starts again", { error: String(error) });
      await reindex();
    }
    settings.setSetting(indexedSetting, head);
    startTidying();
  };

  const writeGists = (gists: ReadonlyMap<string, string>): Promise<void> =>
    serially(async () => {
      if (isClosed.get()) return;
      await catchUp();
      const files = [...gists]
        .map(([address, gist]) => {
          const location = toLocation(address);
          if (!location.ok) return;
          const page = readParsed(location.value);
          return page && page.gist === undefined
            ? { file: location.value.path, text: formatPage({ ...page, gist }) }
            : undefined;
        })
        .filter((file) => file !== undefined);
      if (files.length === 0) return;
      const committed = await opened().writeFiles(files, "Write gists");
      if (!committed.ok) {
        info("Ari's gists couldn't be saved", { error: committed.failure });
        return;
      }
      settings.setSetting(indexedSetting, committed.value);
      schedulePush();
    });

  const allPages = (): readonly ReadPage[] =>
    opened()
      .files()
      .map((file) => toLocation(toAddress(file)))
      .filter((location) => location.ok)
      .map(({ value }) => readPage(value))
      .filter((page) => page !== undefined);

  const withoutGists = (): readonly GistPage[] =>
    allPages()
      .filter((page) => page.gist === undefined)
      .map(({ address, title, markdown }) => ({ address, title, markdown }));

  const withoutCircles = (): readonly CirclePage[] =>
    allPages()
      .filter((page) => page.shelf === "people" && page.circle === undefined)
      .map(({ address, title, gist, markdown }) => ({ address, title, ...(gist !== undefined && { gist }), markdown }));

  const askGists = async (ask: Complete, pages: readonly GistPage[]): Promise<void> => {
    const answered = await ask(toGistPrompt(pages), gistSchema);
    if (!answered.ok) {
      info("Ari couldn't write gists for some pages yet", {
        pages: pages.map(({ address }) => address),
        error: answered.failure,
      });
      return;
    }
    await writeGists(toGists(answered.value, pages));
  };

  const fillGists = async (ask: Complete): Promise<void> => {
    for (const batch of batchesOf(withoutGists(), gistsPerRequest)) {
      if (isClosed.get()) return;
      await askGists(ask, batch);
    }
    for (const page of withoutGists()) {
      if (isClosed.get()) return;
      await askGists(ask, [page]);
    }
  };

  const toCircleChoice = (
    address: string,
    { circle, isGroup }: Sorted,
  ):
    | { readonly location: Location; readonly page: Page; readonly circle: string; readonly to?: Location }
    | undefined => {
    const location = toLocation(address);
    const page = location.ok ? readParsed(location.value) : undefined;
    if (!page || !location.ok || page.circle !== undefined) return undefined;
    const group = toLocation(toGroupAddress(address));
    if (isGroup && group.ok && opened().read(group.value.path) === undefined) {
      return { location: location.value, page, circle, to: group.value };
    }
    return circle === "" ? undefined : { location: location.value, page, circle };
  };

  const writeCircles = (sorted: ReadonlyMap<string, Sorted>): Promise<void> =>
    serially(async () => {
      if (isClosed.get()) return;
      await catchUp();
      const choices = [...sorted]
        .map(([address, choice]) => toCircleChoice(address, choice))
        .filter((choice) => choice !== undefined);
      if (choices.length === 0) return;
      const moves = choices.filter((choice) => choice.to !== undefined);
      const moved = new Map(moves.map(({ location, to }) => [location.address, to?.address ?? location.address]));
      const relink = (links: readonly string[]): readonly string[] => links.map((link) => moved.get(link) ?? link);
      const chosen = new Set(choices.map(({ location }) => location.path));
      const relinked = opened()
        .files()
        .filter((file) => !chosen.has(file))
        .map((file) => {
          const location = toLocation(toAddress(file));
          return { file, page: location.ok ? readParsed(location.value) : undefined };
        })
        .filter(
          (entry): entry is { readonly file: string; readonly page: Page } =>
            entry.page?.links.some((link) => moved.has(link)) === true,
        )
        .map(({ file, page }) => ({ file, text: formatPage({ ...page, links: relink(page.links) }) }));
      const written = choices.map(({ location, page, circle, to }) =>
        to
          ? { file: to.path, text: formatPage({ ...page, links: relink(page.links) }) }
          : { file: location.path, text: formatPage({ ...page, circle, links: relink(page.links) }) },
      );
      const committed = await opened().writeFiles(
        [...written, ...relinked],
        moved.size > 0 ? "Sort people into circles, and move groups to their shelf" : "Sort people into circles",
        moves.map(({ location }) => location.path),
      );
      if (!committed.ok) {
        info("Ari's circles couldn't be saved", { error: committed.failure });
        return;
      }
      settings.setSetting(indexedSetting, committed.value);
      for (const { location, page, to } of choices) {
        if (!to) continue;
        await indexPage(location, page.title, undefined);
        await indexPage(to, page.title, page.markdown);
      }
      schedulePush();
    });

  const fillCircles = async (ask: Complete): Promise<void> => {
    for (const batch of batchesOf(withoutCircles(), circlesPerRequest)) {
      if (isClosed.get()) return;
      const circles = [
        ...new Set(
          allPages()
            .map(({ circle }) => circle)
            .filter((circle) => circle !== undefined),
        ),
      ];
      const answered = await ask(toCirclePrompt(batch, circles), circleSchema);
      if (!answered.ok) {
        info("Ari couldn't sort some people into circles yet", { error: answered.failure });
        continue;
      }
      await writeCircles(toSorted(answered.value, batch));
    }
  };

  const startTidying = (): void => {
    if (!complete || tidying.get() || isClosed.get()) return;
    const run = async (): Promise<void> => {
      try {
        await fillGists(complete);
        await fillCircles(complete);
      } catch (error) {
        info("Ari's tidying of its pages stopped partway", { error: String(error) });
      } finally {
        tidying.set(undefined);
        const left = isClosed.get() ? [] : [...withoutGists(), ...withoutCircles()];
        isUntidy.set(left.length > 0);
        if (left.length > 0)
          info("Some pages still need a gist or a circle", { pages: left.map((page) => page.address) });
      }
    };
    tidying.set(run());
  };

  const ready = (async (): Promise<void> => {
    thread.set(await openThread(directory));
    hasRemote.set(await opened().hasRemote());
    refreshChangedAt();
    await serially(catchUp);
    indexConversation();
    schedulePush();
    startTidying();
  })();

  const sync = async (): Promise<void> => {
    await ready;
    await serially(catchUp);
  };

  const whenReady = async <Value>(work: () => Promise<Value>): Promise<Value> => {
    await sync();
    return work();
  };

  const tools: readonly Tool[] = [
    {
      name: "recall",
      title: "Recall from memory",
      description:
        "Search your memory, the pages you keep and past conversations, by words and meaning. Use it whenever " +
        "the person, the people in their life, their plans or their past might matter to your answer. Your " +
        "Portrait, Now and How to help you pages are already in your mind, so don't recall those.",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string", description: "What you're looking for, in a few words." } },
        required: ["query"],
        additionalProperties: false,
      },
      call: (input) =>
        whenReady(async () => {
          const query = textOf(input, "query").trim();
          if (query === "") return failed("Recall needs a query.");
          const passages = await recall(query);
          if (passages.length === 0) return { text: "Nothing in memory matches that." };
          const pages = new Map(passages.map((passage) => [passage.address, passage]))
            .values()
            .map(({ address, title }) => ({ address, title }))
            .toArray()
            .toSorted((left, right) => left.title.localeCompare(right.title));
          recordStep({ action: "used", pages });
          return { text: passages.map((passage, index) => formatPassage(passage, index)).join("\n\n") };
        }),
    },
    {
      name: "read_page",
      title: "Read a page from memory",
      description:
        "Read one page from your memory by its address, such as memory:people/alex or memory:journal/2026-10-25: " +
        "its front matter, its body with line numbers, and its version. Read a page before you edit it. Give a " +
        "version from page_history to read the page as it was then.",
      inputSchema: {
        type: "object",
        properties: {
          address: { type: "string", description: "The page's address." },
          version: { type: "string", description: "An earlier version, from page_history." },
        },
        required: ["address"],
        additionalProperties: false,
      },
      call: (input) =>
        whenReady(async () => {
          const location = toLocation(textOf(input, "address").trim());
          if (!location.ok) return failed(location.failure);
          const asked = textOf(input, "version").trim();
          const version = asked || (await currentVersion(location.value));
          const text =
            asked === "" ? opened().read(location.value.path) : await opened().readAt(asked, location.value.path);
          if (text === undefined || version === undefined) {
            return failed(
              asked === ""
                ? `There's no page at ${location.value.address}. If it was forgotten, page_history shows its versions.`
                : `${location.value.address} has no version ${asked}. See page_history.`,
            );
          }
          const page = parsePage(text, fallbackTitle(location.value));
          recordStep({
            action: "used",
            pages: toPageReference({ address: location.value.address, title: page.title }),
          });
          const frontMatter = text.slice(0, text.length - page.markdown.length).trim();
          return {
            text: [
              `${location.value.address}, version ${version}${asked === "" ? "" : " (an earlier version)"}`,
              frontMatter,
              numberLines(page.markdown),
            ].join("\n"),
          };
        }),
    },
    {
      name: "edit_page",
      title: "Edit a page in memory",
      description:
        "Change a page you've read, citing the version read_page gave you; if the page has changed since, read it " +
        "again. Replace a passage, old_text copied exactly from the page and there only once, with new_text; or " +
        "replace lines start_line to end_line, as read_page numbers them, with new_text. An empty new_text removes " +
        "them. Keep the present first, in the present tense with an (as of <date>) note, and move what used to be " +
        "true to the ## Earlier section as a dated line. Give title, gist, aliases or links to change those too. " +
        "Portrait, Now and How to help you hold 2,000 characters each. Never store passwords or tokens.",
      inputSchema: {
        type: "object",
        properties: {
          address: { type: "string", description: "The page's address." },
          version: { type: "string", description: "The version you read." },
          old_text: { type: "string", description: "The passage to replace, exactly as it is on the page." },
          start_line: { type: "integer", description: "The first line to replace." },
          end_line: { type: "integer", description: "The last line to replace." },
          new_text: { type: "string", description: "What goes in its place, as Markdown." },
          gist: { type: "string", description: `${gistGuide} Keep it current with every change.` },
          note: {
            type: "string",
            description:
              "What this change does, in a few words, such as “Florence together 6–9 Nov” or “Forgot the first date”.",
          },
          title: { type: "string", description: "A new title." },
          circle: { type: "string", description: `People pages only. ${circleGuide}` },
          aliases: { type: "array", items: { type: "string" }, description: "Other names for it, all of them." },
          links: { type: "array", items: { type: "string" }, description: "Addresses of related pages, all of them." },
        },
        required: ["address", "version", "note"],
        additionalProperties: false,
      },
      call: (input) =>
        whenReady(async () => {
          const missing = toMissing(input, ["note"]);
          if (missing) return failed(missing);
          const edited = await editPage(input);
          if (!edited.ok) return failed(edited.failure);
          recordStep({
            action: "updated",
            pages: toPageReference({ address: textOf(input, "address").trim(), title: edited.value.title }),
            change: edited.value.change,
          });
          return { text: `Saved ${edited.value.title}, now at version ${edited.value.version}.` };
        }),
    },
    {
      name: "write_page",
      title: "Write a new page in memory",
      description:
        "Write a page that doesn't exist yet: memory:portrait, memory:now, memory:helping-you, or a page on a " +
        "shelf, memory:people/… for one person, memory:groups/… for a group of people, memory:goals/…, " +
        "memory:projects/…, memory:places/… or memory:topics/…, named with lowercase words and dashes. The present first, in the present tense with an (as of <date>) note, " +
        "then an ## Earlier section of dated lines for what used to be true. To change a page that exists, read " +
        "it and use edit_page. Never store passwords or tokens.",
      inputSchema: {
        type: "object",
        properties: {
          address: { type: "string", description: "The page's address, such as memory:people/alex." },
          title: { type: "string", description: "The page's title, such as Alex." },
          gist: { type: "string", description: gistGuide },
          circle: { type: "string", description: `Required on a people page. ${circleGuide}` },
          note: { type: "string", description: "What this page is for, in a few words." },
          aliases: { type: "array", items: { type: "string" }, description: "Other names for it." },
          links: {
            type: "array",
            items: { type: "string" },
            description: "Addresses of related pages, such as memory:places/dishoom-shoreditch.",
          },
          body: { type: "string", description: "The whole page as Markdown, without front matter." },
        },
        required: ["address", "gist", "note", "body"],
        additionalProperties: false,
      },
      call: (input) =>
        whenReady(async () => {
          const isPerson = textOf(input, "address").trimStart().startsWith("memory:people/");
          const missing = toMissing(input, isPerson ? ["gist", "circle", "note"] : ["gist", "note"]);
          if (missing) return failed(missing);
          const written = await writeNewPage(input);
          if (!written.ok) return failed(written.failure);
          recordStep({
            action: "updated",
            pages: toPageReference({ address: textOf(input, "address").trim(), title: written.value.title }),
            change: written.value.change,
          });
          return { text: `Saved ${written.value.title}, at version ${written.value.version}.` };
        }),
    },
    {
      name: "forget_page",
      title: "Forget a page",
      description:
        "Forget a whole page, after asking the person: this asks them for approval and waits for their answer. " +
        "Use it only when a page shouldn't exist at all; its history stays, so restore_page can bring it back.",
      inputSchema: {
        type: "object",
        properties: {
          address: { type: "string", description: "The page's address." },
          reason: { type: "string", description: "Why it should go, in a few words, said to the person." },
        },
        required: ["address", "reason"],
        additionalProperties: false,
      },
      call: (input) =>
        whenReady(async () => {
          const location = toLocation(textOf(input, "address").trim());
          if (!location.ok) return failed(location.failure);
          const page = readParsed(location.value);
          if (!page) return failed(`There's no page at ${location.value.address}.`);
          const reason = toOneLine(textOf(input, "reason"));
          if (reason === "") return failed("Say why it should go.");
          const isAllowed = await approve({
            kind: "approval",
            question: `Forget ${page.title}?`,
            options: [{ label: "Forget it", acts: true }, { label: "Keep it" }],
            allows_text: true,
            preview: `${page.title} (${location.value.address}): ${reason}`,
            secret: false,
          });
          if (!isAllowed) return { text: `They kept ${page.title}, so nothing was forgotten.` };
          const forgotten = await forgetPage(location.value, page.title, reason);
          if (!forgotten.ok) return failed(forgotten.failure);
          recordStep({
            action: "updated",
            pages: toPageReference({ address: location.value.address, title: page.title }),
            change: forgotten.value,
          });
          return { text: `Forgot ${page.title}.` };
        }),
    },
    {
      name: "page_history",
      title: "See a page's history",
      description:
        "List a page's versions, newest first, with when and what changed, even for a page that was forgotten. " +
        "Read one with read_page and its version, or bring it back with restore_page.",
      inputSchema: {
        type: "object",
        properties: { address: { type: "string", description: "The page's address." } },
        required: ["address"],
        additionalProperties: false,
      },
      call: (input) =>
        whenReady(async () => {
          const location = toLocation(textOf(input, "address").trim());
          if (!location.ok) return failed(location.failure);
          const history = await opened().history(location.value.path);
          if (history.length === 0) return failed(`${location.value.address} has no history.`);
          return {
            text: history
              .map(
                ({ commit: version, at, subject, body, isDeleted }) =>
                  `${toVersion(version)}  ${at.slice(0, 16).replace("T", " ")}  ${subject}${body ? `: ${body}` : ""}` +
                  (isDeleted ? " (gone after this)" : ""),
              )
              .join("\n"),
          };
        }),
    },
    {
      name: "restore_page",
      title: "Restore a page",
      description:
        "Bring a page back as it was at an earlier version from page_history, forgotten pages included. It " +
        "becomes the page's newest version; the versions in between stay in its history.",
      inputSchema: {
        type: "object",
        properties: {
          address: { type: "string", description: "The page's address." },
          version: { type: "string", description: "The version to bring back." },
          note: { type: "string", description: "Why, in a few words." },
        },
        required: ["address", "version", "note"],
        additionalProperties: false,
      },
      call: (input) =>
        whenReady(async () => {
          const location = toLocation(textOf(input, "address").trim());
          if (!location.ok) return failed(location.failure);
          const missing = toMissing(input, ["note"]);
          if (missing) return failed(missing);
          const restored = await restorePage(
            location.value,
            textOf(input, "version").trim(),
            toOneLine(textOf(input, "note")),
          );
          if (!restored.ok) return failed(restored.failure);
          recordStep({
            action: "updated",
            pages: toPageReference({ address: location.value.address, title: restored.value.title }),
            change: restored.value.change,
          });
          return { text: `Restored ${restored.value.title}, now at version ${restored.value.version}.` };
        }),
    },
    {
      name: "journal",
      title: "Add to today's journal",
      description:
        "Add to today's journal, your running account of the day: what you talked about, what happened, how " +
        "the person seemed. When they journal to you themselves, add their own words with yours: true.",
      inputSchema: {
        type: "object",
        properties: {
          text: { type: "string", description: "What to add, as Markdown." },
          yours: { type: "boolean", description: "True when these are the person's own words." },
          gist: {
            type: "string",
            description:
              "The day's headline so far, in one line, such as “Home from Ljubljana; Bora's first sub-two”. " +
              "Keep it current as the day goes on.",
          },
          note: { type: "string", description: "What this entry adds, in a few words." },
        },
        required: ["text", "gist", "note"],
        additionalProperties: false,
      },
      call: (input) =>
        whenReady(async () => {
          const missing = toMissing(input, ["gist", "note"]);
          if (missing) return failed(missing);
          const written = await writeJournal(input);
          if (!written.ok) return failed(written.failure);
          recordStep({ action: "journaled", pages: toPageReference(written.value) });
          return { text: "Added to today's journal." };
        }),
    },
  ];

  const shelvedPages = (): readonly (Page & {
    readonly address: string;
    readonly shelf: string;
    readonly location: Location;
  })[] =>
    opened()
      .files()
      .map((file) => toLocation(toAddress(file)))
      .filter((location) => location.ok)
      .map(({ value: location }) => ({ location, page: readParsed(location) }))
      .filter(
        (entry): entry is { readonly location: Location; readonly page: Page } =>
          entry.page !== undefined && !isInMindPage(entry.location.shelf) && entry.location.shelf !== "journal",
      )
      .map(({ location, page }) => ({ ...page, address: location.address, shelf: location.shelf, location }));

  const learnedTerms = (): readonly Learned[] => {
    const saved = settings.setting(learnedSetting);
    return saved === undefined ? [] : (JSON.parse(saved) as readonly Learned[]);
  };

  const learnOne = async ({ heard, meant }: Correction): Promise<Learnt> => {
    const wanted = meant.trim().toLowerCase();
    const page = shelvedPages().find(({ title, aliases }) =>
      [title, ...aliases].some((name) => name.toLowerCase() === wanted),
    );
    if (!page) {
      const learned = learnedTerms();
      const known = learned.find((entry) => entry.meant.toLowerCase() === wanted);
      const updated = known
        ? learned.map((entry) => (entry === known ? { ...entry, heard: [...new Set([...entry.heard, heard])] } : entry))
        : [...learned, { meant, heard: [heard] }];
      settings.setSetting(learnedSetting, JSON.stringify(updated));
      return { heard, meant };
    }
    const heardBefore = page.heard ?? [];
    if (!heardBefore.includes(heard)) {
      const { title, gist, aliases, links, markdown } = page;
      const text = formatPage({
        title,
        ...(gist !== undefined && { gist }),
        aliases,
        links,
        heard: [...heardBefore, heard],
        markdown,
      });
      await commit(
        page.location,
        title,
        text,
        `Learn that ${title} can sound like ${heard}`,
        `Can sound like “${heard}”`,
      );
    }
    return { heard, meant, address: page.address };
  };

  const inMind = (): readonly PageBody[] =>
    thread.get()
      ? inMindPages
          .map((name) => {
            const location = toLocation(`memory:${name}`);
            return location.ok ? readPage(location.value) : undefined;
          })
          .filter((page) => page !== undefined)
          .map((page) => toPageBody(page))
      : [];

  const summariesOf = (files: readonly string[]): readonly PageSummary[] =>
    files
      .map((file) => {
        const location = toLocation(toAddress(file));
        return location.ok ? readPage(location.value) : undefined;
      })
      .filter((page) => page !== undefined)
      .map(({ address, title, gist, circle, changed_at }) => ({
        address,
        title,
        ...(gist !== undefined && { gist }),
        ...(circle !== undefined && { circle }),
        changed_at,
      }));

  const inMindText = (): string => {
    const pages = inMind();
    return pages.length === 0
      ? ""
      : [
          "<in_mind>",
          "These pages from your memory are in your mind on every turn, as they are now.",
          ...pages.map(({ title, address, markdown }) => `\n## ${title} (${address})\n\n${markdown.trim()}`),
          "</in_mind>",
        ].join("\n");
  };

  return {
    ready,
    tools,
    inMindText,
    inMind,
    shelves: () => {
      const files = thread.get()?.files() ?? [];
      return shelves.map((shelf) => ({ shelf, count: files.filter((file) => file.startsWith(`${shelf}/`)).length }));
    },
    pages: (shelf) => {
      const summaries = summariesOf((thread.get()?.files() ?? []).filter((file) => file.startsWith(`${shelf}/`)));
      return summaries.toSorted(
        shelf === "journal"
          ? (left, right) => right.address.localeCompare(left.address)
          : (left, right) => left.title.localeCompare(right.title),
      );
    },
    recent: () =>
      store.recentChanges(recentChanges).map(({ id, address, title, note, at }) => ({
        change: id,
        address,
        title,
        at,
        ...(note !== undefined && { note }),
      })),
    page: (address) => {
      const location = toLocation(address);
      if (!location.ok) return fail({ code: "invalid", detail: location.failure });
      const page = thread.get() ? readPage(location.value) : undefined;
      return page ? ok(toPageBody(page)) : fail({ code: "not_found", detail: `There's no page at ${address}.` });
    },
    change: async (id) => {
      await ready;
      const found = store.findChange(id);
      if (!found) return;
      const [before, after] = await Promise.all([
        opened().readAt(found.before ?? `${found.commit}^`, found.file),
        opened().readAt(found.commit, found.file),
      ]);
      const fallback = found.title;
      return {
        change: found.id,
        address: found.address,
        title: found.title,
        at: found.at,
        ...(before !== undefined && { before: parsePage(before, fallback).markdown }),
        ...(after !== undefined && { after: parsePage(after, fallback).markdown }),
      };
    },
    seed: (page) =>
      whenReady(async () => {
        const written = await writePage({ ...page, body: page.markdown });
        return written.ok ? ok(written.value.change) : written;
      }),
    isBackedUp,
    indexConversation,
    sync,
    vocabulary: async () => {
      await sync();
      if (isClosed.get()) return [];
      const pages = shelvedPages().map(({ address, shelf, title, aliases, heard = [], markdown }) => ({
        address,
        shelf,
        title,
        aliases,
        heard,
        markdown,
      }));
      return toVocabulary(pages, store.yourMessages(), learnedTerms());
    },
    boosted: (terms) => {
      if (isClosed.get()) return [];
      const since = clock.now() - boostDays * dayMs;
      const written = new Set(
        store
          .recentChanges(boostMessages)
          .filter(({ note, at }) => note !== undefined && Date.parse(at) >= since)
          .map(({ address }) => address),
      );
      const lately = [inMindText(), ...store.yourMessages().slice(0, boostMessages)].join("\n");
      return toBoosted(
        terms,
        (term) => term.address === undefined || written.has(term.address) || mentions(term.text).test(lately),
      );
    },
    learn: async (corrections) => {
      await sync();
      return serially(async () => {
        const learnt: readonly Learnt[] = [];
        return corrections.reduce<Promise<readonly Learnt[]>>(
          async (earlier, correction) => [...(await earlier), await learnOne(correction)],
          Promise.resolve(learnt),
        );
      });
    },
    withThread: async (work) => {
      await ready;
      return serially(async () => {
        const before = await opened().head();
        const isCaughtUp = settings.setting(indexedSetting) === before;
        const value = await work(opened());
        const after = await opened().head();
        if (after !== before) {
          if (isCaughtUp) settings.setSetting(indexedSetting, after);
          schedulePush();
        }
        return value;
      });
    },
    indexText: async (address, title, text) => {
      if (isClosed.get()) return;
      if (text === undefined) {
        store.replaceChunks(address, []);
        return;
      }
      const chunks = toPageChunks(address, title, text, toTimestamp(clock.now()));
      const vectors = await embedder.passages(chunks.map((chunk) => chunk.text));
      if (isClosed.get()) return;
      store.replaceChunks(
        address,
        chunks.map((chunk, index) => ({ ...chunk, ...(vectors[index] && { vector: vectors[index] }) })),
      );
    },
    close: async () => {
      isClosed.set(true);
      pushTimer.get()?.();
      await ready;
      await writes.get();
    },
  };
};
