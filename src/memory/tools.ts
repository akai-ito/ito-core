import type { AskFields, StepFacts } from "#engine/engine.ts";
import { beganGuide, endedGuide } from "#memory/chapters.ts";
import { numberLines, toVersion } from "#memory/edits.ts";
import { gistGuide, toOneLine } from "#memory/gists.ts";
import { learntCopiesText, learntGuide, type LearntBody } from "#memory/learnt.ts";
import { parsePage, toLocation, type Location, type Page } from "#memory/pages.ts";
import type { Passage } from "#memory/recall.ts";
import type { FileCommit } from "#memory/thread.ts";
import type { Result } from "#result.ts";
import { fieldOf, textOf } from "#tools/input.ts";
import type { Tool, ToolResult } from "#tools/mcp.ts";

// A page that says some words: the lines that do, numbered as read_page numbers them, and its gist or title when
// those do.
export type Copy = {
  readonly address: string;
  readonly title: string;
  readonly version: string;
  readonly lines: readonly { readonly number: number; readonly text: string }[];
  readonly gist?: string;
  readonly inTitle?: boolean;
};

export type Saved = {
  readonly title: string;
  readonly change: string;
  readonly version: string;
  readonly photos: number;
  // Something worth knowing about the page now, such as a page in mind growing long.
  readonly note?: string;
  // After a correction, the other pages that still say what was wrong.
  readonly copies?: readonly Copy[];
};

export type PageOperations = {
  readonly whenReady: <Value>(work: () => Promise<Value>) => Promise<Value>;
  readonly recall: (query: string) => Promise<readonly Passage[]>;
  readonly currentVersion: (location: Location) => Promise<string | undefined>;
  readonly readText: (file: string) => string | undefined;
  readonly readTextAt: (version: string, file: string) => Promise<string | undefined>;
  readonly history: (file: string) => Promise<readonly FileCommit[]>;
  readonly find: (location: Location) => Page | undefined;
  readonly titleOf: (location: Location) => string;
  readonly edit: (input: unknown) => Promise<Result<Saved, string>>;
  readonly writeNew: (input: unknown) => Promise<Result<Saved, string>>;
  readonly forget: (location: Location, title: string, reason: string) => Promise<Result<string, string>>;
  readonly restore: (location: Location, version: string, note: string) => Promise<Result<Saved, string>>;
  readonly journal: (
    input: unknown,
  ) => Promise<Result<{ readonly address: string; readonly title: string; readonly photos: number }, string>>;
  readonly findCopies: (words: readonly string[]) => Promise<readonly Copy[]>;
  readonly findLearnt: (words: readonly string[]) => readonly LearntBody[];
  readonly recordStep: (facts: StepFacts) => boolean;
  readonly approve: (fields: AskFields) => Promise<boolean>;
};

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

const circleGuide =
  "Who they are to the person, in a few words you reuse across people, such as family, friends, work or " +
  "running club.";

const contactGuide =
  "People pages only: the uid of their card in Contacts, from ito contacts, which holds the facts about them " +
  "(emails, phones, addresses, birthday, work), so the page keeps the story.";

// How to put a chat photo on a page: where it belongs, by its file in the workspace.
const photoGuide =
  "To keep a photo they shared with it, put it where it belongs: ![what it shows](uploads/photo.jpg). Memory " +
  "keeps a copy.";

// How a page reads: notes a sharp, warm friend keeps, plain, current and short.
const writingGuide =
  "Plain, current and short: the present first, in the present tense; date events, deadlines and changes " +
  "(“since 16 Nov”), not every paragraph; what used to be true goes under ## Earlier, a line per turning point. No " +
  "disclaimers (“this doesn't establish…”) or process notes (tool failures, what you checked, ids, approvals); " +
  "summaries, not raw data. What they told you and what happened, never your guess at their feelings, " +
  "relationships or motives as fact.";

// What a write kept besides the words.
const withPhotos = (count: number): string =>
  count === 0 ? "" : count === 1 ? ", with its photo" : `, with its ${String(count)} photos`;

const toPageReference = ({
  address,
  title,
}: {
  readonly address: string;
  readonly title: string;
}): StepFacts["pages"] => [{ address, title }];

const formatCopy = ({ address, title, version, lines, gist, inTitle }: Copy): string =>
  [
    `${address} (${title}, version ${version})`,
    ...(inTitle === true ? ["  in its title"] : []),
    ...(gist === undefined ? [] : [`  gist: ${gist}`]),
    ...lines.map(({ number, text }) => `  ${String(number)}  ${text}`),
  ].join("\n");

// What a save says after a correction: where what was wrong still is, or that it's nowhere else.
const copiesText = (copies: readonly Copy[] | undefined): string => {
  if (copies === undefined) return "";
  return copies.length === 0
    ? " No other page says it."
    : ` Still said elsewhere, so put each right too:\n${copies.map((copy) => formatCopy(copy)).join("\n")}`;
};

const formatPassage = (passage: Passage, index: number): string =>
  `${String(index + 1)}. ${passage.title} (${passage.address}, ${passage.at.slice(0, 10)})\n${passage.text}`;

export const createMemoryTools = (memory: PageOperations): readonly Tool[] => [
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
      memory.whenReady(async () => {
        const query = textOf(input, "query").trim();
        if (query === "") return failed("Recall needs a query.");
        const passages = await memory.recall(query);
        if (passages.length === 0) return { text: "Nothing in memory matches that." };
        const pages = new Map(passages.map((passage) => [passage.address, passage]))
          .values()
          .map(({ address, title }) => ({ address, title }))
          .toArray()
          .toSorted((left, right) => left.title.localeCompare(right.title));
        memory.recordStep({ action: "used", pages });
        return { text: passages.map((passage, index) => formatPassage(passage, index)).join("\n\n") };
      }),
  },
  {
    name: "find_in_memory",
    title: "Find every copy in memory",
    description:
      "Find every page that says some words, exactly: every shelf, every journal day and the pages in your " +
      "mind, in their words, titles and gists, with the lines numbered as read_page numbers them and each " +
      "page's version. Use it when they correct something, before you edit, so every copy is put right.",
    inputSchema: {
      type: "object",
      properties: {
        words: {
          type: "array",
          items: { type: "string" },
          description: "A few distinctive words or phrases, any of which counts, such as “worried about Sam”.",
        },
      },
      required: ["words"],
      additionalProperties: false,
    },
    call: (input) =>
      memory.whenReady(async () => {
        const words = (
          Array.isArray(fieldOf(input, "words")) ? (fieldOf(input, "words") as readonly unknown[]) : []
        ).filter((word): word is string => typeof word === "string" && word.trim().length >= 3);
        if (words.length === 0) return failed("Give a word or phrase of three letters or more to find.");
        const copies = await memory.findCopies(words);
        return {
          text:
            (copies.length === 0 ? "No page says that." : copies.map((copy) => formatCopy(copy)).join("\n")) +
            learntCopiesText(memory.findLearnt(words)),
        };
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
      memory.whenReady(async () => {
        const location = toLocation(textOf(input, "address").trim());
        if (!location.ok) return failed(location.failure);
        const asked = textOf(input, "version").trim();
        const version = asked || (await memory.currentVersion(location.value));
        const text =
          asked === "" ? memory.readText(location.value.path) : await memory.readTextAt(asked, location.value.path);
        if (text === undefined || version === undefined) {
          return failed(
            asked === ""
              ? `There's no page at ${location.value.address}. If it was forgotten, page_history shows its versions.`
              : `${location.value.address} has no version ${asked}. See page_history.`,
          );
        }
        const page = parsePage(text, memory.titleOf(location.value));
        memory.recordStep({
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
      `them. Give title, gist, aliases or links to change those too. ${writingGuide} Portrait, Now (what's live) ` +
      "and How to help you (lasting preferences, not one-off corrections) are in your mind on every turn: keep " +
      "them to what matters now, and move the rest to a shelf page. Never store passwords or tokens.",
    inputSchema: {
      type: "object",
      properties: {
        address: { type: "string", description: "The page's address." },
        version: { type: "string", description: "The version you read." },
        old_text: { type: "string", description: "The passage to replace, exactly as it is on the page." },
        start_line: { type: "integer", description: "The first line to replace." },
        end_line: { type: "integer", description: "The last line to replace." },
        new_text: { type: "string", description: `What goes in its place, as Markdown. ${photoGuide}` },
        gist: { type: "string", description: `${gistGuide} Keep it current with every change.` },
        note: {
          type: "string",
          description:
            "What this change does, in a few words, such as “Florence together 6–9 Nov” or “Forgot the first date”.",
        },
        title: { type: "string", description: "A new title." },
        circle: { type: "string", description: `People pages only. ${circleGuide}` },
        contact: { type: "string", description: contactGuide },
        began: { type: "string", description: beganGuide },
        ended: { type: "string", description: endedGuide },
        learnt: { type: "string", description: learntGuide },
        aliases: { type: "array", items: { type: "string" }, description: "Other names for it, all of them." },
        links: { type: "array", items: { type: "string" }, description: "Addresses of related pages, all of them." },
        corrects: {
          type: "array",
          items: { type: "string" },
          description:
            "When this puts right something that was wrong, the words it said, a few distinctive ones per claim: " +
            "the answer lists every other page, journal day and gist that still says them.",
        },
      },
      required: ["address", "version", "note"],
      additionalProperties: false,
    },
    call: (input) =>
      memory.whenReady(async () => {
        const missing = toMissing(input, ["note"]);
        if (missing) return failed(missing);
        const edited = await memory.edit(input);
        if (!edited.ok) return failed(edited.failure);
        memory.recordStep({
          action: "updated",
          pages: toPageReference({ address: textOf(input, "address").trim(), title: edited.value.title }),
          change: edited.value.change,
        });
        const { title, photos, version, note, copies } = edited.value;
        return {
          text:
            `Saved ${title}${withPhotos(photos)}, now at version ${version}.` +
            (note === undefined ? "" : ` ${note}`) +
            copiesText(copies),
        };
      }),
  },
  {
    name: "write_page",
    title: "Write a new page in memory",
    description:
      "Write a page that doesn't exist yet: memory:portrait, memory:now, memory:helping-you, or a page on a " +
      "shelf, memory:people/… for one person, memory:groups/… for a group of people, memory:goals/…, " +
      "memory:projects/…, memory:places/…, memory:topics/… or memory:chapters/… for a chapter of their life " +
      `(read the chapters skill first), named with lowercase words and dashes. ${writingGuide} To change a page ` +
      "that exists, read it and use edit_page. Never store passwords or tokens.",
    inputSchema: {
      type: "object",
      properties: {
        address: { type: "string", description: "The page's address, such as memory:people/alex." },
        title: { type: "string", description: "The page's title, such as Alex." },
        gist: { type: "string", description: gistGuide },
        circle: { type: "string", description: `Required on a people page. ${circleGuide}` },
        contact: { type: "string", description: contactGuide },
        began: { type: "string", description: `Required on a chapter. ${beganGuide}` },
        ended: { type: "string", description: endedGuide },
        note: { type: "string", description: "What this page is for, in a few words." },
        learnt: { type: "string", description: learntGuide },
        aliases: { type: "array", items: { type: "string" }, description: "Other names for it." },
        links: {
          type: "array",
          items: { type: "string" },
          description: "Addresses of related pages, such as memory:places/dishoom-shoreditch.",
        },
        body: {
          type: "string",
          description: `The whole page as Markdown, without front matter. ${photoGuide}`,
        },
      },
      required: ["address", "gist", "note", "body"],
      additionalProperties: false,
    },
    call: (input) =>
      memory.whenReady(async () => {
        const isPerson = textOf(input, "address").trimStart().startsWith("memory:people/");
        const missing = toMissing(input, isPerson ? ["gist", "circle", "note"] : ["gist", "note"]);
        if (missing) return failed(missing);
        const written = await memory.writeNew(input);
        if (!written.ok) return failed(written.failure);
        memory.recordStep({
          action: "updated",
          pages: toPageReference({ address: textOf(input, "address").trim(), title: written.value.title }),
          change: written.value.change,
        });
        const { title, photos, version, note } = written.value;
        return {
          text: `Saved ${title}${withPhotos(photos)}, at version ${version}.${note === undefined ? "" : ` ${note}`}`,
        };
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
      memory.whenReady(async () => {
        const location = toLocation(textOf(input, "address").trim());
        if (!location.ok) return failed(location.failure);
        const page = memory.find(location.value);
        if (!page) return failed(`There's no page at ${location.value.address}.`);
        const reason = toOneLine(textOf(input, "reason"));
        if (reason === "") return failed("Say why it should go.");
        const isAllowed = await memory.approve({
          kind: "approval",
          question: `Forget ${page.title}?`,
          options: [{ label: "Forget it", acts: true }, { label: "Keep it" }],
          allows_text: true,
          preview: `${page.title} (${location.value.address}): ${reason}`,
        });
        if (!isAllowed) return { text: `They kept ${page.title}, so nothing was forgotten.` };
        const forgotten = await memory.forget(location.value, page.title, reason);
        if (!forgotten.ok) return failed(forgotten.failure);
        memory.recordStep({
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
      memory.whenReady(async () => {
        const location = toLocation(textOf(input, "address").trim());
        if (!location.ok) return failed(location.failure);
        const history = await memory.history(location.value.path);
        if (history.length === 0) return failed(`${location.value.address} has no history.`);
        return {
          text: history
            .map(
              ({ commit: version, at, subject, body, isDeleted }) =>
                `${toVersion(version)}  ${at.slice(0, 16).replace("T", " ")}  ${subject}` +
                (body ? `: ${body.replaceAll(/\s*\n+\s*/gu, " · ")}` : "") +
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
      memory.whenReady(async () => {
        const location = toLocation(textOf(input, "address").trim());
        if (!location.ok) return failed(location.failure);
        const missing = toMissing(input, ["note"]);
        if (missing) return failed(missing);
        const restored = await memory.restore(
          location.value,
          textOf(input, "version").trim(),
          toOneLine(textOf(input, "note")),
        );
        if (!restored.ok) return failed(restored.failure);
        memory.recordStep({
          action: "updated",
          pages: toPageReference({ address: location.value.address, title: restored.value.title }),
          change: restored.value.change,
        });
        return { text: `Restored ${restored.value.title}, now at version ${restored.value.version}.` };
      }),
  },
  {
    name: "journal",
    title: "Write a day's journal entry",
    audience: "dream",
    description:
      "Write one day's journal entry whole, as their own diary in the first person (“I…”), from the day's notes and " +
      "everything else you read: the day's moments, the people, their own words, photos where they belong, big news " +
      "they read, what actually happened, and training or sleep only when it mattered. One flowing entry in short " +
      "paragraphs, no time headings, its length following the day; nothing invented, and how they felt only when " +
      "they said so. It replaces what the day said, so read the day first and keep everything still true, every " +
      "photo included. Something they mentioned later goes into the day it happened.",
    inputSchema: {
      type: "object",
      properties: {
        day: { type: "string", description: "The day it's about, as YYYY-MM-DD." },
        text: { type: "string", description: `The whole entry, as Markdown. ${photoGuide}` },
        gist: {
          type: "string",
          description: "The day in one line, in the first person, such as “Home from Ljubljana; Leo's first sub-two”.",
        },
        note: { type: "string", description: "What this write changed, in a few words." },
        links: {
          type: "array",
          items: { type: "string" },
          description: "Addresses of the pages it draws on, such as memory:people/leo.",
        },
        learnt: { type: "string", description: learntGuide },
      },
      required: ["day", "text", "gist", "note"],
      additionalProperties: false,
    },
    call: (input) =>
      memory.whenReady(async () => {
        const missing = toMissing(input, ["gist", "note"]);
        if (missing) return failed(missing);
        const written = await memory.journal(input);
        if (!written.ok) return failed(written.failure);
        memory.recordStep({ action: "journaled", pages: toPageReference(written.value) });
        return { text: `Wrote ${written.value.title}${withPhotos(written.value.photos)}.` };
      }),
  },
];
