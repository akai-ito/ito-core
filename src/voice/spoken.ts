import { createCell } from "#cell.ts";
import type { Ask } from "#protocol/types.ts";

const isDivider = (line: string): boolean => line.trim() === "---";

export const hasDivider = (text: string): boolean => text.split("\n").some((line) => isDivider(line));

const beforeDivider = (text: string): string => {
  const lines = text.split("\n");
  const divider = lines.findIndex((line) => isDivider(line));
  return divider === -1 ? text : lines.slice(0, divider).join("\n");
};

const listMarkers = ["- ", "* ", "+ ", "> "];

const plainLine = (line: string): string => {
  const unheaded = line.trim().replace(/^#+/u, "").trim();
  const marker = listMarkers.find((candidate) => unheaded.startsWith(candidate));
  const unlisted = marker ? unheaded.slice(marker.length) : unheaded;
  return unlisted.replace(/^\d+\. /u, "").trim();
};

export const speakable = (markdown: string): string =>
  markdown
    .split("\n")
    .map((line) => plainLine(line))
    .filter((line) => line !== "")
    .map((line) => (/[.!?:;,]$/u.test(line) ? line : `${line}.`))
    .join(" ")
    .replaceAll(/\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replaceAll(/[*`_]/gu, "");

export const spokenPart = (text: string): string => speakable(beforeDivider(text));

const sentenceEnds = (text: string): readonly number[] =>
  text
    .matchAll(/[.!?](?= \S)/gu)
    .map((match) => match.index + 1)
    .toArray();

export const longestSpoken = 25;

const clauseEnd = /[,;:\u{2013}\u{2014}]$/u;

export const toClauses = (sentence: string): readonly string[] => {
  const words = sentence.split(/\s+/u).filter((word) => word !== "");
  if (words.length <= longestSpoken) return [sentence];
  const middle = words.length / 2;
  const cuts = words
    .map((word, index) => (clauseEnd.test(word) && index + 1 < words.length ? index + 1 : 0))
    .filter((index) => index > 0);
  const cut = cuts.toSorted((left, right) => Math.abs(left - middle) - Math.abs(right - middle))[0] ?? Math.ceil(middle);
  return [...toClauses(words.slice(0, cut).join(" ")), ...toClauses(words.slice(cut).join(" "))];
};

export const secretAloud = "There's something to type in the chat.";

type Asked = Pick<Ask, "kind" | "question" | "options" | "preview" | "secret">;

const orList = (labels: readonly string[]): string =>
  labels.length < 2 ? (labels[0] ?? "") : `${labels.slice(0, -1).join(", ")}, or ${labels.at(-1) ?? ""}`;

export const askAloud = ({ kind, question, options, preview, secret }: Asked): readonly string[] => {
  if (secret) return [secretAloud];
  const labels = options.map(({ label }) => label);
  const asked = spokenPart(question);
  const isOffered = labels.every((label) => asked.toLowerCase().includes(label.toLowerCase()));
  const briefly = preview && kind === "approval" ? toClauses(spokenPart(preview))[0] : undefined;
  const choices = !isOffered && labels.length > 0 ? `${orList(labels)}?` : undefined;
  return [briefly, asked, choices]
    .filter((part): part is string => part !== undefined && part !== "")
    .flatMap((part) => toClauses(part));
};

export type SentenceFeed = (text: string, isFinished: boolean) => readonly string[];

export const createSentenceFeed = (): SentenceFeed => {
  const spokenCount = createCell(0);
  return (text, isFinished) => {
    const rest = spokenPart(text).slice(spokenCount.get());
    const isDone = isFinished || hasDivider(text);
    const ends = sentenceEnds(rest);
    const cut = isDone ? rest.length : (ends.at(-1) ?? 0);
    const bounds = [0, ...ends.filter((end) => end < cut), cut];
    const sentences = bounds
      .slice(1)
      .map((end, index) => rest.slice(bounds[index] ?? 0, end).trim())
      .filter((sentence) => sentence !== "")
      .flatMap((sentence) => toClauses(sentence));
    spokenCount.set(spokenCount.get() + cut);
    return sentences;
  };
};
