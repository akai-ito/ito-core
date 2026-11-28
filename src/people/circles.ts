import { fail, ok, type Result } from "#result.ts";

// Circles: who someone is to him, from their People page's `circle`, in the order he keeps them. The order is his
// setting, partner first by default; he can add circles of his own (five-a-side, a book club) and rename them.
// Others is the catch-all: anyone whose circle isn't in his list is there, and it can move but not go or be renamed.

export const circlesSetting = "people_circles";
export const othersCircle = "Others";
export const defaultCircles: readonly string[] = ["Partner", "Friends", "Family", "Work", othersCircle];

export type CircleChange = { readonly name: string; readonly was?: string };

export type CirclesChanged = {
  readonly order: readonly string[];
  // Each circle renamed, from its old name to the new one, so the pages in it can follow.
  readonly renames: readonly (readonly [string, string])[];
};

const mostCircles = 30;
const longestName = 40;

const tidy = (name: string): string => name.replaceAll(/\s+/gu, " ").trim();

// A circle's name as it's matched: "Friends" and a page's "friend" are one circle, as are "Work" and "work".
export const circleKey = (name: string): string => {
  const plain = tidy(name).normalize("NFKD").replaceAll(/\p{M}/gu, "").toLowerCase();
  return plain.length > 3 && plain.endsWith("s") && !plain.endsWith("ss") ? plain.slice(0, -1) : plain;
};

export const isOthers = (name: string): boolean => circleKey(name) === circleKey(othersCircle);

// His order as stored, or the default when there's none or it doesn't read; Others is always in it.
export const readCircles = (text: string | undefined): readonly string[] => {
  const parsed = ((): unknown => {
    try {
      return text === undefined ? undefined : (JSON.parse(text) as unknown);
    } catch {
      return undefined;
    }
  })();
  const names = Array.isArray(parsed)
    ? (parsed as readonly unknown[]).flatMap((item) =>
        typeof item === "string" && tidy(item) !== "" ? tidy(item) : [],
      )
    : [];
  if (names.length === 0) return defaultCircles;
  return names.some((name) => isOthers(name)) ? names : [...names, othersCircle];
};

// The circle someone is listed under: theirs, by key, when it's in his order, otherwise Others.
export const circleOf = (circle: string | undefined, order: readonly string[]): string => {
  const key = circle === undefined ? "" : circleKey(circle);
  return order.find((name) => !isOthers(name) && circleKey(name) === key) ?? othersCircle;
};

// A new order from the whole list he sent: each circle by name, with `was` for one he renamed. A new name adds a
// circle; one left out goes, and its people show under Others.
export const changeCircles = (
  current: readonly string[],
  wanted: readonly CircleChange[],
): Result<CirclesChanged, string> => {
  const names = wanted.map(({ name }) => tidy(name));
  if (names.length > mostCircles) return fail(`Keep to ${String(mostCircles)} circles.`);
  const bad = names.find((name) => name === "" || name.length > longestName);
  if (bad !== undefined) return fail(`Name each circle in 1 to ${String(longestName)} characters.`);
  const keys = names.map((name) => circleKey(name));
  if (new Set(keys).size !== keys.length) return fail("Two circles have the same name.");
  if (keys.filter((key) => key === circleKey(othersCircle)).length !== 1) {
    return fail(`${othersCircle} stays in the list: it's where everyone else goes.`);
  }
  const renamed = wanted.map(({ name, was }): Result<readonly (readonly [string, string])[], string> => {
    if (was === undefined || circleKey(was) === circleKey(name)) return ok([]);
    const existing = current.find((circle) => circleKey(circle) === circleKey(was));
    if (existing === undefined) return fail(`There's no circle called ${tidy(was)} to rename.`);
    if (isOthers(existing) || isOthers(name)) return fail(`${othersCircle} can't be renamed.`);
    return ok([[existing, tidy(name)]]);
  });
  const [problem] = renamed.flatMap((each) => (each.ok ? [] : each.failure));
  return problem === undefined
    ? ok({ order: names, renames: renamed.flatMap((each) => (each.ok ? each.value : [])) })
    : fail(problem);
};
