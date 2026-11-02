import { parse as parseYaml, stringify as toYaml } from "yaml";
import { fail, ok, type Result } from "#result.ts";

export const shelves = ["people", "groups", "goals", "projects", "places", "topics", "journal"] as const;

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
  readonly aliases: readonly string[];
  readonly links: readonly string[];
  readonly markdown: string;
};

export const inMindTitles: Readonly<Record<InMindPage, string>> = {
  portrait: "Portrait",
  now: "Now",
  "helping-you": "How to help you",
};

export const inMindLimit = 2000;

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

export const parsePage = (text: string, fallbackTitle: string): Page => {
  const yaml = frontMatter.exec(text)?.groups?.yaml;
  const fields = (yaml === undefined ? {} : parseYaml(yaml)) as Readonly<Record<string, unknown>> | null;
  const title = fields?.title;
  const gist = fields?.gist;
  const circle = fields?.circle;
  const contact = fields?.contact;
  return {
    title: typeof title === "string" ? title : fallbackTitle,
    ...(typeof gist === "string" && gist.trim() !== "" && { gist: gist.trim() }),
    ...(typeof circle === "string" && circle.trim() !== "" && { circle: circle.trim() }),
    ...(typeof contact === "string" && contact.trim() !== "" && { contact: contact.trim() }),
    aliases: strings(fields?.aliases),
    links: strings(fields?.links),
    markdown: text.replace(frontMatter, "").replace(/^\n+/u, ""),
  };
};

export const formatPage = ({ title, gist, circle, contact, aliases, links, markdown }: Page): string => {
  const fields = {
    title,
    ...(gist !== undefined && { gist }),
    ...(circle !== undefined && { circle }),
    ...(contact !== undefined && { contact }),
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

export const toTimeOfDay = (at: number, timeZone: string): string =>
  new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone }).format(at);

export const toJournalEntry = (text: string, isYours: boolean, time: string): string => {
  const words = text.trim();
  const body = isYours
    ? words
        .split("\n")
        .map((line) => `> ${line}`.trimEnd())
        .join("\n")
    : words;
  return `### ${time}\n\n${body}\n`;
};

export const appendEntry = (markdown: string, entry: string): string =>
  markdown.trim() === "" ? entry : `${markdown.trimEnd()}\n\n${entry}`;

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
