export type Name = { readonly text: string; readonly address: string };

export type NamedPage = {
  readonly address: string;
  readonly shelf: string;
  readonly title: string;
  readonly aliases: readonly string[];
};

export const boostLimit = 60;

const nameShelves: ReadonlySet<string> = new Set(["people", "groups", "places"]);

const escaped = (text: string): string => text.replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`);

const notWord = String.raw`[^\p{L}\p{N}]`;

export const mentions = (term: string): RegExp => new RegExp(`(?:^|${notWord})${escaped(term)}(?:${notWord}|$)`, "iu");

export const toNames = (pages: readonly NamedPage[]): readonly Name[] =>
  pages
    .filter((page) => nameShelves.has(page.shelf))
    .toSorted((left, right) => left.address.localeCompare(right.address))
    .flatMap((page) => [page.title, ...page.aliases].map((text) => ({ text, address: page.address })));

export const toBoosted = (names: readonly Name[], isRecent: (name: Name) => boolean): readonly string[] =>
  [...new Set(names.filter((name) => isRecent(name)).map(({ text }) => text))].slice(0, boostLimit);
