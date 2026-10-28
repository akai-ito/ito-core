export type Block = { readonly kind: string; readonly body: string };

export type PlanItem = { readonly id: string; readonly text: string; readonly done: boolean };

export type Plan = { readonly title?: string; readonly items: readonly PlanItem[] };

export type TickNote = { readonly plan: string; readonly item: string; readonly done: boolean };

const blockPattern = /^```ari:(?<kind>[a-z]+)[^\n]*\n(?<body>[\s\S]*?)^```[ \t]*$/gmu;

const unclosedBlock = /^```ari:[\s\S]*$/mu;

const fieldOf = (value: unknown, field: string): unknown =>
  value && typeof value === "object" ? Reflect.get(value, field) : undefined;

const parsed = (body: string): unknown => {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return undefined;
  }
};

export const blocksIn = (text: string): readonly Block[] =>
  text
    .matchAll(blockPattern)
    .map(({ groups }) => ({ kind: groups?.kind ?? "", body: groups?.body ?? "" }))
    .toArray();

export const withoutBlocks = (text: string): string =>
  text
    .replaceAll(blockPattern, "")
    .replace(unclosedBlock, "")
    .replaceAll(/\n{3,}/gu, "\n\n")
    .trim();

const toItem = (value: unknown): PlanItem | undefined => {
  const id = fieldOf(value, "id");
  const text = fieldOf(value, "text");
  return typeof id === "string" && typeof text === "string"
    ? { id, text, done: fieldOf(value, "done") === true }
    : undefined;
};

export const toPlan = (block: Block | undefined): Plan | undefined => {
  if (block?.kind !== "plan") return undefined;
  const value = parsed(block.body);
  const items = fieldOf(value, "items");
  if (!Array.isArray(items)) return undefined;
  const title = fieldOf(value, "title");
  return {
    ...(typeof title === "string" && title.trim() !== "" && { title: title.trim() }),
    items: (items as readonly unknown[]).map((item) => toItem(item)).filter((item) => item !== undefined),
  };
};

const listed = (phrases: readonly string[]): string =>
  phrases.length < 2 ? (phrases[0] ?? "") : `${phrases.slice(0, -1).join(", ")} and ${phrases.at(-1) ?? ""}`;

export const toTickNote = (ticks: readonly TickNote[]): string =>
  ticks.length === 0
    ? ""
    : `(Since your last reply, they ${listed(
        ticks.map(({ plan, item, done }) => `${done ? "ticked" : "unticked"} “${item}” in ${plan}`),
      )}.)`;
