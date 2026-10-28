import type { Correction, Term } from "#protocol/types.ts";

type Word = { readonly text: string; readonly start: number; readonly end: number };

type Learnt = { readonly heard: readonly string[]; readonly meant: string };

export type Corrected = { readonly text: string; readonly corrections: readonly Correction[] };

const fold = (word: string): string => word.normalize("NFD").replaceAll(/\p{M}/gu, "").toLowerCase();

const wordsIn = (text: string): readonly Word[] =>
  text
    .matchAll(/[\p{L}\p{N}]+(?:['’]\p{L}[\p{L}\p{N}]*)*/gu)
    .map((match) => ({ text: match[0], start: match.index, end: match.index + match[0].length }))
    .toArray();

const foldedWords = (text: string): readonly string[] => wordsIn(text).map(({ text: word }) => fold(word));

const isSame = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((word, index) => word === right[index]);

const toLearnt = (terms: readonly Term[]): readonly Learnt[] =>
  terms
    .flatMap(({ text, heard }) =>
      heard
        .map((mishearing) => ({ heard: foldedWords(mishearing), meant: text }))
        .filter(({ heard: words }) => words.length > 0 && !isSame(words, foldedWords(text))),
    )
    .toSorted((left, right) => right.heard.length - left.heard.length);

type Replacement = { readonly from: number; readonly count: number; readonly meant: string };

const replacements = (words: readonly Word[], learnt: readonly Learnt[], from = 0): readonly Replacement[] => {
  if (from >= words.length) return [];
  const folded = words.slice(from).map(({ text }) => fold(text));
  const match = learnt.find(
    ({ heard, meant }) =>
      isSame(folded.slice(0, heard.length), heard) &&
      words
        .slice(from, from + heard.length)
        .map(({ text }) => text)
        .join(" ") !== meant,
  );
  return match
    ? [{ from, count: match.heard.length, meant: match.meant }, ...replacements(words, learnt, from + match.heard.length)]
    : replacements(words, learnt, from + 1);
};

export const correct = (text: string, terms: readonly Term[]): Corrected => {
  const words = wordsIn(text);
  const found = replacements(words, toLearnt(terms));
  const initial: { readonly output: string; readonly cursor: number; readonly corrections: readonly Correction[] } = {
    output: "",
    cursor: 0,
    corrections: [],
  };
  const done = found.reduce(({ output, cursor, corrections }, { from, count, meant }) => {
    const start = words[from]?.start ?? cursor;
    const end = words[from + count - 1]?.end ?? start;
    const before = output + text.slice(cursor, start);
    return {
      output: before + meant,
      cursor: end,
      corrections: [...corrections, { offset: before.length, length: meant.length, heard: text.slice(start, end) }],
    };
  }, initial);
  return { text: done.output + text.slice(done.cursor), corrections: done.corrections };
};
