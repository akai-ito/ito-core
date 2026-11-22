import type { Attachment } from "#protocol/types.ts";
import { withoutBlocks } from "#replies/blocks.ts";

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

// A line of a message to show beside it, such as a thread's news or a quote: its first words, or what it carries.
export const lineOf = (text: string, attachments: readonly Attachment[] = []): string =>
  toFirstLine(withoutBlocks(text)) ||
  (attachments.some((attachment) => attachment.kind === "image")
    ? "A photo"
    : attachments.length > 0
      ? "A file"
      : "") ||
  "A message";
