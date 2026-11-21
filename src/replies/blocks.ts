const blockPattern = /^```ari:(?<kind>[a-z]+)[^\n]*\n(?<body>[\s\S]*?)^```[ \t]*$/gmu;

const unclosedBlock = /^```ari:[\s\S]*$/mu;

export type Block = { readonly kind: string; readonly body: string };

// The `ari:` blocks in some Markdown, each with its kind and the JSON it holds.
export const blocksIn = (text: string): readonly Block[] =>
  text
    .matchAll(blockPattern)
    .map((match) => ({ kind: match.groups?.kind ?? "", body: match.groups?.body ?? "" }))
    .toArray();

export const withoutBlocks = (text: string): string =>
  text
    .replaceAll(blockPattern, "")
    .replace(unclosedBlock, "")
    .replaceAll(/\n{3,}/gu, "\n\n")
    .trim();
