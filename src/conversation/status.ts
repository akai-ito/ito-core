import type { Activity } from "#engine/engine.ts";
import type { Status } from "#protocol/types.ts";

const commandLabels = {
  read: "Reading files",
  search: "Searching files",
  list: "Browsing files",
  run: "Running a command",
} as const;

const maxDetailLength = 200;

const codePointsIn = (text: string): number => text.match(/./gsu)?.length ?? 0;

const shorten = (text: string, limit: number): string => {
  const graphemes = [...new Intl.Segmenter().segment(text)].map(({ segment }) => segment);
  const totals = graphemes.reduce<readonly number[]>(
    (sums, grapheme) => [...sums, (sums.at(-1) ?? 0) + codePointsIn(grapheme)],
    [],
  );
  const fitting = totals.findIndex((total) => total > limit - 1);
  return `${graphemes.slice(0, fitting).join("").trimEnd()}…`;
};

const toDetail = (text: string | undefined): string | undefined => {
  const detail = text?.replaceAll(/\s+/gu, " ").trim();
  if (!detail) return undefined;
  return codePointsIn(detail) <= maxDetailLength ? detail : shorten(detail, maxDetailLength);
};

const withDetail = (status: Status, text: string | undefined): Status => {
  const detail = toDetail(text);
  return detail ? { ...status, detail } : status;
};

export const toStatus = (activity: Activity): Status => {
  switch (activity.kind) {
    case "thinking": {
      return withDetail({ kind: "thinking", label: "Thinking" }, activity.heading);
    }
    case "web_search": {
      return withDetail({ kind: "working", label: "Searching the web" }, activity.query);
    }
    case "command": {
      return { kind: "working", label: commandLabels[activity.action] };
    }
    case "file_change": {
      return { kind: "working", label: "Editing files" };
    }
    case "tool": {
      return { kind: "working", label: "Working" };
    }
    case "compacting": {
      return { kind: "waiting", label: "Tidying up its notes" };
    }
  }
};

export const writingStatus: Status = { kind: "writing", label: "Writing" };

export const adjustingStatus: Status = { kind: "adjusting", label: "Adjusting to your message" };

export const stoppingStatus: Status = { kind: "stopping", label: "Stopping" };
