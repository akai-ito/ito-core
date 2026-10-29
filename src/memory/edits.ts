import { fail, ok, type Result } from "#result.ts";

export type BodyEdit =
  | { readonly kind: "passage"; readonly old: string; readonly new: string }
  | { readonly kind: "lines"; readonly start: number; readonly end: number; readonly new: string };

export type PageVersion = { readonly version: string; readonly at: string; readonly what: string };

export const versionLength = 10;

export const toVersion = (commit: string): string => commit.slice(0, versionLength);

export const isSameVersion = (cited: string, current: string): boolean =>
  cited.length >= 7 && current.startsWith(cited.slice(0, versionLength));

const linesOf = (markdown: string): readonly string[] => markdown.replace(/\n$/u, "").split("\n");

export const numberLines = (markdown: string): string => {
  const lines = linesOf(markdown);
  const width = String(lines.length).length;
  return lines.map((line, index) => `${String(index + 1).padStart(width)}  ${line}`.trimEnd()).join("\n");
};

const countOf = (text: string, passage: string): number => text.split(passage).length - 1;

export const applyEdit = (markdown: string, edit: BodyEdit): Result<string, string> => {
  switch (edit.kind) {
    case "passage": {
      if (edit.old === "") return fail("Give the passage to replace, copied exactly from the page.");
      const count = countOf(markdown, edit.old);
      if (count === 0) return fail("That passage isn't on the page. Read the page again and copy it exactly.");
      if (count > 1) {
        return fail(
          `That passage is on the page ${String(count)} times. Include more of what's around it, so it's there once.`,
        );
      }
      return ok(markdown.replace(edit.old, () => edit.new));
    }
    case "lines": {
      const lines = linesOf(markdown);
      const { start, end } = edit;
      if (
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end) ||
        start < 1 ||
        end < start ||
        end > lines.length
      ) {
        return fail(
          `Lines ${String(start)}–${String(end)} aren't on the page: it has lines 1–${String(lines.length)}.`,
        );
      }
      const replacement = edit.new === "" ? [] : linesOf(edit.new);
      return ok(`${[...lines.slice(0, start - 1), ...replacement, ...lines.slice(end)].join("\n")}\n`);
    }
  }
};

export const isSharplyShorter = (before: string, after: string): boolean =>
  after.trim() === "" || after.trim().length < before.trim().length / 2;
