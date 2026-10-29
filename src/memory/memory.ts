import { statSync } from "node:fs";
import path from "node:path";
import { createCell } from "#cell.ts";
import { toTimestamp, type Cancel, type Clock } from "#clock.ts";
import type { AskFields, StepFacts } from "#engine/engine.ts";
import type { Identifiers } from "#identifiers.ts";
import type { Embedder } from "#memory/embedder.ts";
import { applyEdit, isSameVersion, isSharplyShorter, toVersion, type BodyEdit } from "#memory/edits.ts";
import { toOneLine } from "#memory/gists.ts";
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
import { mentions, toBoosted, toNames } from "#memory/vocabulary.ts";
import { rank, toMessageChunk, toPageChunks, type Passage } from "#memory/recall.ts";
import { openThread, type Thread } from "#memory/thread.ts";
import { withoutBlocks } from "#replies/blocks.ts";
import { fail, ok, type Result } from "#result.ts";
import type { MemoryStore } from "#store/memory.ts";
import type { Settings } from "#store/store.ts";
import { createMemoryTools } from "#memory/tools.ts";
import { fieldOf, stringsOf, textOf } from "#tools/input.ts";
import type { Tool } from "#tools/mcp.ts";
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
  readonly boostedNames: () => Promise<readonly string[]>;
  readonly withThread: <Value>(work: (thread: Thread) => Promise<Value>) => Promise<Value>;
  readonly indexText: (address: string, title: string, text: string | undefined) => Promise<void>;
  readonly close: () => Promise<void>;
};

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
  readonly pushDelayMs?: number;
};

const indexModelSetting = "memory_index_model";
const indexedSetting = "memory_indexed_commit";
const pushedAtSetting = "memory_pushed_at";
const failingSinceSetting = "memory_push_failing_since";
const dayMs = 24 * 60 * 60 * 1000;
const longestPushDelayMs = 60 * 60 * 1000;
const passagesPerRecall = 6;
const recentChanges = 20;
const boostDays = 28;
const boostMessages = 200;

const isInMindPage = (shelf: Shelf | InMindPage): shelf is InMindPage =>
  (inMindPages as readonly string[]).includes(shelf);

const onlyPeople = "Only a page about one person has a circle.";

const tooLong = (title: string, length: number): string =>
  `${title} is ${String(length)} characters, over the ${String(inMindLimit)} it can hold. Keep it to what matters ` +
  "on every turn, and move the detail to a page on a shelf.";

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
  pushDelayMs = 30_000,
}: MemoryOptions): Memory => {
  const thread = createCell<Thread | undefined>(undefined);
  const writes = createCell<Promise<unknown>>(Promise.resolve());
  const pushTimer = createCell<Cancel | undefined>(undefined);
  const pushAttempts = createCell(0);
  const hasRemote = createCell(false);
  const isClosed = createCell(false);

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
  };

  const ready = (async (): Promise<void> => {
    thread.set(await openThread(directory));
    hasRemote.set(await opened().hasRemote());
    refreshChangedAt();
    await serially(catchUp);
    indexConversation();
    schedulePush();
  })();

  const sync = async (): Promise<void> => {
    await ready;
    await serially(catchUp);
  };

  const whenReady = async <Value>(work: () => Promise<Value>): Promise<Value> => {
    await sync();
    return work();
  };

  const tools = createMemoryTools({
    whenReady,
    recall,
    currentVersion,
    readText: (file) => opened().read(file),
    readTextAt: (version, file) => opened().readAt(version, file),
    history: (file) => opened().history(file),
    find: readParsed,
    titleOf: fallbackTitle,
    edit: editPage,
    writeNew: writeNewPage,
    forget: forgetPage,
    restore: restorePage,
    journal: writeJournal,
    recordStep,
    approve,
  });

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
    boostedNames: async () => {
      await sync();
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
        toNames(shelvedPages()),
        (name) => written.has(name.address) || mentions(name.text).test(lately),
      );
    },
    withThread: async (work) => {
      await ready;
      return serially(async () => {
        if (isClosed.get()) throw new Error("Memory is closing.");
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
