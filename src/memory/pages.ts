import { parse as parseYaml, stringify as toYaml } from "yaml";
import { fail, ok, type Result } from "#result.ts";

export const shelves = ["people", "groups", "goals", "projects", "places", "topics", "chapters", "journal"] as const;

export type Shelf = (typeof shelves)[number];

export const inMindPages = ["portrait", "now", "helping-you"] as const;

export type InMindPage = (typeof inMindPages)[number];

export type Location = {
  readonly address: string;
  readonly path: string;
  readonly shelf: Shelf | InMindPage;
};

export type Page = {
  readonly title: string;
  readonly gist?: string;
  readonly circle?: string;
  // On a people page, the uid of their card in Contacts, which holds the facts about them.
  readonly contact?: string;
  // On a chapter, the days it began and ended (none while it's still going), and the day Kumo noticed it.
  readonly began?: string;
  readonly ended?: string;
  readonly noticed?: string;
  readonly aliases: readonly string[];
  readonly links: readonly string[];
  readonly markdown: string;
};

export const inMindTitles: Readonly<Record<InMindPage, string>> = {
  portrait: "Portrait",
  now: "Now",
  "helping-you": "How to help you",
};

// Past this, a page in mind gets a gentle note to move detail out: never a limit, so nothing is ever squeezed in.
export const inMindWords = 450;

// Words as a reader counts them, each run of letters and each number on its own, so that text with its spaces
// squeezed out ("As of4 Dec") counts the same as the text it should be.
export const wordsIn = (markdown: string): number =>
  markdown.match(/\p{L}+(?:['’]\p{L}+)*|\p{N}+(?:[.,:]\p{N}+)*/gu)?.length ?? 0;

// Kumo's own reading of them, never a fact: kept out of every page.
export const isReading = (text: string): boolean => /my reading:/iu.test(text);

const namePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const dayPattern = /^\d{4}-\d{2}-\d{2}$/u;

const isShelf = (name: string): name is Shelf => (shelves as readonly string[]).includes(name);

const isInMind = (name: string): name is InMindPage => (inMindPages as readonly string[]).includes(name);

export const toLocation = (address: string): Result<Location, string> => {
  const [scheme, rest = ""] = address.split(":", 2);
  if (scheme !== "memory") return fail(`${address} isn't a memory address, such as memory:people/alex.`);
  const [first = "", name, extra] = rest.split("/", 3);
  if (name === undefined) {
    return isInMind(first)
      ? ok({ address, path: `${first}.md`, shelf: first })
      : fail(`memory:${first} isn't a page: use memory:portrait, memory:now, memory:helping-you or a shelf page.`);
  }
  if (extra !== undefined || !isShelf(first)) {
    return fail(`${address} isn't on a shelf: use ${shelves.map((shelf) => `memory:${shelf}/…`).join(", ")}.`);
  }
  const isValidName = first === "journal" ? dayPattern.test(name) : namePattern.test(name);
  return isValidName
    ? ok({ address, path: `${first}/${name}.md`, shelf: first })
    : fail(
        `${name} can't name a page: use lowercase words joined by dashes${first === "journal" ? ", or a date" : ""}.`,
      );
};

export const toAddress = (path: string): string => `memory:${path.replace(/\.md$/u, "")}`;

const frontMatter = /^---\n(?<yaml>[\s\S]*?)\n---\n?/u;

const strings = (value: unknown): readonly string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

// A day in front matter, as YYYY-MM-DD, however YAML read it.
const dayOf = (value: unknown): string | undefined => {
  const text = value instanceof Date ? value.toISOString().slice(0, 10) : value;
  return typeof text === "string" && dayPattern.test(text.trim()) ? text.trim() : undefined;
};

export const parsePage = (text: string, fallbackTitle: string): Page => {
  const yaml = frontMatter.exec(text)?.groups?.yaml;
  const fields = (yaml === undefined ? {} : parseYaml(yaml)) as Readonly<Record<string, unknown>> | null;
  const title = fields?.title;
  const gist = fields?.gist;
  const circle = fields?.circle;
  const contact = fields?.contact;
  const began = dayOf(fields?.began);
  const ended = dayOf(fields?.ended);
  const noticed = dayOf(fields?.noticed);
  return {
    title: typeof title === "string" ? title : fallbackTitle,
    ...(typeof gist === "string" && gist.trim() !== "" && { gist: gist.trim() }),
    ...(typeof circle === "string" && circle.trim() !== "" && { circle: circle.trim() }),
    ...(typeof contact === "string" && contact.trim() !== "" && { contact: contact.trim() }),
    ...(began !== undefined && { began }),
    ...(ended !== undefined && { ended }),
    ...(noticed !== undefined && { noticed }),
    aliases: strings(fields?.aliases),
    links: strings(fields?.links),
    markdown: text.replace(frontMatter, "").replace(/^\n+/u, ""),
  };
};

export const formatPage = ({
  title,
  gist,
  circle,
  contact,
  began,
  ended,
  noticed,
  aliases,
  links,
  markdown,
}: Page): string => {
  const fields = {
    title,
    ...(gist !== undefined && { gist }),
    ...(circle !== undefined && { circle }),
    ...(contact !== undefined && { contact }),
    ...(began !== undefined && { began }),
    ...(ended !== undefined && { ended }),
    ...(noticed !== undefined && { noticed }),
    ...(aliases.length > 0 && { aliases }),
    ...(links.length > 0 && { links }),
  };
  return `---\n${toYaml(fields, { flowCollectionPadding: false, collectionStyle: "flow" }).trimEnd()}\n---\n\n${markdown.trim()}\n`;
};

export const toMarkdown = (body: string): string => (body.trim() === "" ? "" : `${body.trim()}\n`);

export const dayTitle = (day: string): string =>
  new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(
    new Date(`${day}T00:00:00.000Z`),
  );

export const toDay = (at: number, timeZone: string): string =>
  new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone }).format(at);

// The lines of a page's body as read_page numbers them, from 1, that hold any of the words.
export const linesWith = (
  markdown: string,
  words: readonly string[],
): readonly { readonly number: number; readonly text: string }[] =>
  markdown
    .replace(/\n$/u, "")
    .split("\n")
    .map((text, index) => ({ number: index + 1, text }))
    .filter(({ text }) => words.some((word) => text.toLowerCase().includes(word)));

const levelOf = (line: string): number | undefined => /^(?<hashes>#{1,6})\s/u.exec(line)?.groups?.hashes?.length;

// The section of a page's Markdown under a heading, such as "Sorting mail" on How to help you, without the heading.
export const sectionOf = (markdown: string, heading: string): string => {
  const lines = markdown.split("\n");
  const wanted = heading.trim().toLowerCase();
  const start = lines.findIndex(
    (line) =>
      levelOf(line) !== undefined &&
      line
        .replace(/^#+\s*/u, "")
        .trim()
        .toLowerCase() === wanted,
  );
  if (start === -1) return "";
  const level = levelOf(lines[start] ?? "") ?? 1;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => (levelOf(line) ?? Infinity) <= level);
  return (end === -1 ? rest : rest.slice(0, end)).join("\n").trim();
};
