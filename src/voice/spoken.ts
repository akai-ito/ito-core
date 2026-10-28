import { createCell } from "#cell.ts";

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
      .filter((sentence) => sentence !== "");
    spokenCount.set(spokenCount.get() + cut);
    return sentences;
  };
};
