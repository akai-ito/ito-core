import type { Status, StepKind } from "#protocol/types.ts";

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

const statusKindOf = (kind: StepKind): Status["kind"] => {
  if (kind === "thinking" || kind === "plan") return "thinking";
  return kind === "wait" || kind === "compacting" ? "waiting" : "working";
};

export const toStepStatus = (kind: StepKind, title: string, heading: string | undefined): Status => {
  const status: Status = { kind: statusKindOf(kind), label: title };
  return kind === "thinking" ? withDetail(status, heading) : status;
};

export const writingStatus: Status = { kind: "writing", label: "Writing" };

export const adjustingStatus: Status = { kind: "adjusting", label: "Adjusting to your message" };

export const stoppingStatus: Status = { kind: "stopping", label: "Stopping" };
