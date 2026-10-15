import { createCell } from "#cell.ts";

export type Secrets = {
  readonly add: (text: string) => void;
  readonly redact: (text: string) => string;
  readonly redactValue: <Value>(value: Value) => Value;
  readonly unfinished: (text: string) => number;
};

export const redaction = "••••••";

const shortestSecret = 4;

const startsAtEnd = (text: string, secret: string): number =>
  Array.from({ length: Math.min(secret.length - 1, text.length) }, (_, index) => index + 1)
    .filter((length) => text.endsWith(secret.slice(0, length)))
    .reduce((longest, length) => Math.max(longest, length), 0);

export const createSecrets = (): Secrets => {
  const known = createCell<readonly string[]>([]);

  const redact = (text: string): string =>
    known.get().reduce((redacted, secret) => redacted.split(secret).join(redaction), text);

  const redactAny = (value: unknown): unknown => {
    if (typeof value === "string") return redact(value);
    if (Array.isArray(value)) return value.map((item) => redactAny(item));
    return value && typeof value === "object"
      ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactAny(item)]))
      : value;
  };

  return {
    add: (text) => {
      const secret = text.trim();
      if (secret.length < shortestSecret || known.get().includes(secret)) return;
      known.set([...known.get(), secret].toSorted((left, right) => right.length - left.length));
    },
    redact,
    redactValue: <Value>(value: Value): Value => (known.get().length === 0 ? value : (redactAny(value) as Value)),
    unfinished: (text) => known.get().reduce((longest, secret) => Math.max(longest, startsAtEnd(text, secret)), 0),
  };
};
