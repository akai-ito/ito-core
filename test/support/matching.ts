import { createCell } from "#cell.ts";

type IdMap = { readonly forward: ReadonlyMap<string, string>; readonly backward: ReadonlyMap<string, string> };

export type IdMatcher = {
  readonly match: (expected: unknown, actual: unknown) => string | undefined;
  readonly translate: <Value>(value: Value) => Value;
};

const idPattern = /^[emstacf]_[\da-z_]+$/u;
const transcriptIdPattern = /[emstacf]_\d{4}_\d{5}/gu;

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const createIdMatcher = (known: readonly string[]): IdMatcher => {
  const ids = createCell<IdMap>({
    forward: new Map(known.map((id) => [id, id])),
    backward: new Map(known.map((id) => [id, id])),
  });

  const matchId = (expected: string, actual: string, at: string): string | undefined => {
    const { forward, backward } = ids.get();
    const mapped = forward.get(expected);
    if (mapped !== undefined)
      return mapped === actual ? undefined : `${at}: expected ${expected} (= ${mapped}), got ${actual}`;
    if (backward.has(actual))
      return `${at}: ${actual} already stands for ${backward.get(actual) ?? ""}, not ${expected}`;
    ids.set({
      forward: new Map([...forward, [expected, actual]]),
      backward: new Map([...backward, [actual, expected]]),
    });
    return undefined;
  };

  const match = (expected: unknown, actual: unknown, at = "$"): string | undefined => {
    if (typeof expected === "string" && typeof actual === "string" && idPattern.test(expected)) {
      return matchId(expected, actual, at);
    }
    if (Array.isArray(expected)) {
      return Array.isArray(actual) && actual.length === expected.length
        ? expected.map((item, index) => match(item, actual[index], `${at}[${index}]`)).find(Boolean)
        : `${at}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`;
    }
    if (isRecord(expected)) {
      if (!isRecord(actual)) return `${at}: expected an object, got ${JSON.stringify(actual)}`;
      const keys = [...new Set([...Object.keys(expected), ...Object.keys(actual)])].toSorted((left, right) =>
        left.localeCompare(right),
      );
      return keys.map((key) => match(expected[key], actual[key], `${at}.${key}`)).find(Boolean);
    }
    return Object.is(expected, actual)
      ? undefined
      : `${at}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`;
  };

  const translate = <Value>(value: Value): Value =>
    JSON.parse(JSON.stringify(value).replaceAll(transcriptIdPattern, (id) => ids.get().forward.get(id) ?? id)) as Value;

  return { match, translate };
};
