import type { Term } from "#protocol/types.ts";

export type VocabularyPage = {
  readonly address: string;
  readonly shelf: string;
  readonly title: string;
  readonly aliases: readonly string[];
  readonly heard: readonly string[];
  readonly markdown: string;
};

export type Learned = { readonly meant: string; readonly heard: readonly string[] };

export const vocabularyLimit = 300;

const phrasesPerTerm = 3;
const longestPhrase = 100;
const timesBeforeATerm = 3;
const learnedWeight = 0.5;

const kinds: Readonly<Record<string, Term["kind"]>> = {
  people: "person",
  places: "place",
  projects: "project",
  goals: "goal",
  topics: "topic",
};

const ordinaryCapitals: ReadonlySet<string> = new Set([
  "I",
  "I'm",
  "I've",
  "I'll",
  "I'd",
  "OK",
  "Ari",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
]);

const escaped = (text: string): string => text.replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`);

const notWord = String.raw`[^\p{L}\p{N}]`;

const mentions = (term: string): RegExp => new RegExp(`(?:^|${notWord})${escaped(term)}(?:${notWord}|$)`, "iu");

const toParagraphs = (markdown: string): readonly string[] =>
  markdown
    .split(/\n\s*\n/u)
    .map((paragraph) => paragraph.replaceAll(/\s+/gu, " ").trim())
    .filter((paragraph) => paragraph !== "" && !paragraph.startsWith("#"));

const shortened = (text: string): string => {
  if (text.length <= longestPhrase) return text;
  const cut = text.lastIndexOf(" ", longestPhrase);
  return text.slice(0, cut > 0 ? cut : longestPhrase).trimEnd();
};

const phrasesFor = (
  term: string,
  own: VocabularyPage | undefined,
  pages: readonly VocabularyPage[],
  messages: readonly string[],
): readonly string[] => {
  const pattern = mentions(term);
  const candidates = [
    ...(own ? toParagraphs(own.markdown) : []),
    ...pages.filter((page) => page !== own).flatMap((page) => toParagraphs(page.markdown)),
    ...messages.flatMap((message) => toParagraphs(message)),
  ];
  return [
    ...new Set(candidates.filter((candidate) => pattern.test(candidate)).map((candidate) => shortened(candidate))),
  ].slice(0, phrasesPerTerm);
};

const countCapitals = (messages: readonly string[]): ReadonlyMap<string, number> =>
  messages
    .flatMap((message) =>
      message
        .split(/(?<=[.!?])\s+/u)
        .flatMap((sentence) =>
          (sentence.match(/[\p{L}\p{N}][\p{L}\p{N}'-]*/gu) ?? []).slice(1).filter((word) => /^\p{Lu}/u.test(word)),
        ),
    )
    .filter((word) => !ordinaryCapitals.has(word))
    .reduce((counts, word) => new Map([...counts, [word, (counts.get(word) ?? 0) + 1]]), new Map<string, number>());

export const toVocabulary = (
  pages: readonly VocabularyPage[],
  messages: readonly string[],
  learned: readonly Learned[],
): readonly Term[] => {
  const shelved = pages
    .filter((page) => kinds[page.shelf] !== undefined)
    .toSorted((left, right) => left.address.localeCompare(right.address));
  const fromPages = shelved.flatMap((page) =>
    [page.title, ...page.aliases].map((text): Term => ({
      text,
      kind: kinds[page.shelf] ?? "term",
      weight: 1,
      phrases: [...phrasesFor(text, page, shelved, messages)],
      heard: [...page.heard],
      address: page.address,
    })),
  );
  const known = new Set(fromPages.map(({ text }) => text.toLowerCase()));
  const fromConversation = [...countCapitals(messages)]
    .filter(([word, count]) => count >= timesBeforeATerm && !known.has(word.toLowerCase()))
    .toSorted(([, left], [, right]) => right - left)
    .map(([text, count]): Term => ({
      text,
      kind: "term",
      weight: Math.min(0.9, 0.3 + 0.1 * count),
      phrases: [...phrasesFor(text, undefined, shelved, messages)],
      heard: [],
    }));
  const fromLearning = learned.map(({ meant, heard }): Term => ({
    text: meant,
    kind: "term",
    weight: learnedWeight,
    phrases: [...phrasesFor(meant, undefined, shelved, messages)],
    heard: [...heard],
  }));
  return [...fromPages, ...fromConversation, ...fromLearning]
    .toSorted((left, right) => right.weight - left.weight)
    .slice(0, vocabularyLimit);
};
