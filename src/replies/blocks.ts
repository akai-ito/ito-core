const blockPattern = /^```ari:(?<kind>[a-z]+)[^\n]*\n(?<body>[\s\S]*?)^```[ \t]*$/gmu;

const unclosedBlock = /^```ari:[\s\S]*$/mu;

export const withoutBlocks = (text: string): string =>
  text
    .replaceAll(blockPattern, "")
    .replace(unclosedBlock, "")
    .replaceAll(/\n{3,}/gu, "\n\n")
    .trim();
