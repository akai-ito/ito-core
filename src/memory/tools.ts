import type { AskFields, StepFacts } from "#engine/engine.ts";
import { numberLines, toVersion } from "#memory/edits.ts";
import { gistGuide, toOneLine } from "#memory/gists.ts";
import { parsePage, toLocation, type Location, type Page } from "#memory/pages.ts";
import type { Passage } from "#memory/recall.ts";
import type { FileCommit } from "#memory/thread.ts";
import type { Result } from "#result.ts";
import { textOf } from "#tools/input.ts";
import type { Tool, ToolResult } from "#tools/mcp.ts";

type Saved = { readonly title: string; readonly change: string; readonly version: string };

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
  readonly journal: (input: unknown) => Promise<Result<{ readonly address: string; readonly title: string }, string>>;
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

const toPageReference = ({
  address,
  title,
}: {
  readonly address: string;
  readonly title: string;
}): StepFacts["pages"] => [{ address, title }];

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
      memory.whenReady(async () => {
        const missing = toMissing(input, ["gist", "note"]);
        if (missing) return failed(missing);
        const written = await memory.journal(input);
        if (!written.ok) return failed(written.failure);
        memory.recordStep({ action: "journaled", pages: toPageReference(written.value) });
        return { text: "Added to today's journal." };
      }),
  },
];
