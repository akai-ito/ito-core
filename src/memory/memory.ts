import { statSync } from "node:fs";
import path from "node:path";
import { createCell } from "#cell.ts";
import { toTimestamp, type Cancel, type Clock } from "#clock.ts";
import type { JsonSchema, StepFacts } from "#engine/engine.ts";
import type { Identifiers } from "#identifiers.ts";
import type { Embedder } from "#memory/embedder.ts";
import { gistGuide, gistSchema, gistsPerRequest, toGistPrompt, toGists, toOneLine } from "#memory/gists.ts";
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
};

const toMissing = (input: unknown, fields: readonly string[]): string | undefined => {
  const missing = fields.filter((field) => textOf(input, field).trim() === "").map((field) => missingField[field]);
  return missing.length === 0 ? undefined : missing.join(" ");
};

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
  const gistPass = createCell<Promise<void> | undefined>(undefined);

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
    const { title, gist, aliases, links, markdown } = page;
    return {
      address: location.address,
      shelf: location.shelf,
      title,
      ...(gist !== undefined && { gist }),
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
    const committed = await opened().write(location.path, text, message);
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
      if (isFixed && markdown.length > inMindLimit) {
        return fail(
          `${title} is ${String(markdown.length)} characters, over the ${String(inMindLimit)} it can hold. ` +
            "Keep it to what matters on every turn, and move the detail to a page on a shelf.",
        );
      }
      const gist = toOneLine(textOf(input, "gist")) || existing?.gist;
      const note = toOneLine(textOf(input, "note")) || undefined;
      const text =
        markdown === ""
          ? undefined
          : formatPage({
              title,
              ...(gist !== undefined && { gist }),
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
    startGistPass();
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

  const fillGists = async (ask: NonNullable<MemoryOptions["complete"]>): Promise<void> => {
    const missing = opened()
      .files()
      .map((file) => toLocation(toAddress(file)))
      .filter((location) => location.ok)
      .map(({ value }) => readPage(value))
      .filter((page): page is ReadPage => page !== undefined && page.gist === undefined)
      .map(({ address, title, markdown }) => ({ address, title, markdown }));
    const batches = Array.from({ length: Math.ceil(missing.length / gistsPerRequest) }, (_, index) =>
      missing.slice(index * gistsPerRequest, (index + 1) * gistsPerRequest),
    );
    for (const batch of batches) {
      if (isClosed.get()) return;
      const answered = await ask(toGistPrompt(batch), gistSchema);
      if (!answered.ok) {
        info("Ari couldn't write gists for its pages yet", { error: answered.failure });
        return;
      }
      await writeGists(toGists(answered.value, batch));
    }
  };

  const startGistPass = (): void => {
    if (!complete || gistPass.get() || isClosed.get()) return;
    const run = async (): Promise<void> => {
      try {
        await fillGists(complete);
      } catch (error) {
        info("Ari's gists stopped partway", { error: String(error) });
      } finally {
        gistPass.set(undefined);
      }
    };
    gistPass.set(run());
  };

  const ready = (async (): Promise<void> => {
    thread.set(await openThread(directory));
    hasRemote.set(await opened().hasRemote());
    refreshChangedAt();
    await serially(catchUp);
    indexConversation();
    schedulePush();
    startGistPass();
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
        "Read one whole page from your memory by its address, such as memory:people/alex or " +
        "memory:journal/2026-10-25. Read a page before you rewrite it with remember.",
      inputSchema: {
        type: "object",
        properties: { address: { type: "string", description: "The page's address." } },
        required: ["address"],
        additionalProperties: false,
      },
      call: (input) =>
        whenReady(() => {
          const location = toLocation(textOf(input, "address").trim());
          if (!location.ok) return Promise.resolve(failed(location.failure));
          const page = readPage(location.value);
          if (!page) return Promise.resolve(failed(`There's no page at ${location.value.address} yet.`));
          recordStep({ action: "used", pages: toPageReference(page) });
          return Promise.resolve({ text: opened().read(location.value.path) ?? "" });
        }),
    },
    {
      name: "remember",
      title: "Write a page in memory",
      description:
        "Write or rewrite a page in your memory: memory:portrait, memory:now, memory:helping-you, or a page on a " +
        "shelf, memory:people/…, memory:goals/…, memory:projects/…, memory:places/… or memory:topics/…, named " +
        "with lowercase words and dashes. Give the whole page each time: the present first, in the present " +
        "tense with an (as of <date>) note, then an ## Earlier section of dated lines for what used to be true. " +
        "The newest thing the person said wins: rewrite the present and move the old state to Earlier. " +
        "An empty body deletes the page. Portrait, Now and How to help you hold 2,000 characters each. " +
        "Never store passwords or tokens.",
      inputSchema: {
        type: "object",
        properties: {
          address: { type: "string", description: "The page's address, such as memory:people/alex." },
          title: { type: "string", description: "The page's title, such as Alex." },
          gist: { type: "string", description: `${gistGuide} Keep it current with every change.` },
          note: {
            type: "string",
            description:
              "What this change does, in a few words, such as “Florence together 6–9 Nov” or “Forgot the first date”.",
          },
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
          const missing = toMissing(input, textOf(input, "body").trim() === "" ? ["note"] : ["gist", "note"]);
          if (missing) return failed(missing);
          const written = await writePage(input);
          if (!written.ok) return failed(written.failure);
          const address = textOf(input, "address").trim();
          recordStep({
            action: "updated",
            pages: toPageReference({ address, title: written.value.title }),
            change: written.value.change,
          });
          return { text: `Saved ${written.value.title}.` };
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
      .map(({ address, title, gist, changed_at }) => ({
        address,
        title,
        ...(gist !== undefined && { gist }),
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
    close: async () => {
      isClosed.set(true);
      pushTimer.get()?.();
      await ready;
      await writes.get();
    },
  };
};
