const pushTextLength = 200;

export const toFirstLine = (markdown: string): string => {
  const line =
    markdown
      .split("\n")
      .map((text) =>
        text
          .replaceAll(/^#+\s+|^\s*[-*+]\s+|^\s*>\s?/gu, "")
          .replaceAll(/!?\[([^\]]*)\]\([^)]*\)/gu, "$1")
          .replaceAll(/[*_`~]/gu, "")
          .trim(),
      )
      .find(Boolean) ?? "";
  if (line.length <= pushTextLength) return line;
  const cut = line.lastIndexOf(" ", pushTextLength - 1);
  return `${line.slice(0, cut > 0 ? cut : pushTextLength - 1)}…`;
};

export const toFailedText = (message: string): string => `Couldn't finish: ${message}`;

export const toReminderText = (question: string): string => `Still waiting on one thing: ${question}`;
