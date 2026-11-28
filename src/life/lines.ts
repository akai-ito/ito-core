import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { createCell } from "#cell.ts";
import { toTimestamp, type Clock } from "#clock.ts";
import type { Complete, JsonSchema } from "#engine/engine.ts";
import type { QuickChoice } from "#engine/quick-model.ts";
import type { Info } from "#turns/turns.ts";

// Kumo's lines in Life, written on the quick model and kept: the answer to a search, a range's line, the short
// version of what Kumo knows about them. Each is kept under its key with the basis it was written from (a hash of
// everything it read), so it's written again only once what it reads changes. A line still being written when
// the app asks is waited for briefly; past that the answer goes without it, and the next ask finds it kept.
export type Lines = {
  readonly write: <Value>(request: LineRequest<Value>) => Promise<Value | undefined>;
};

export type LineRequest<Value> = {
  readonly key: string;
  // Everything the line is written from, hashed to tell when it needs writing again.
  readonly basis: unknown;
  readonly prompt: string;
  readonly schema: JsonSchema;
  readonly toValue: (answer: unknown) => Value | undefined;
};

export type LinesOptions = {
  readonly database: DatabaseSync;
  readonly complete: Complete;
  readonly quickChoice: QuickChoice;
  readonly clock: Clock;
  readonly info: Info;
  // How long an ask waits for a line being written.
  readonly waitMs?: number;
};

type Row = { readonly basis: string; readonly body: string };

const defaultWaitMs = 12_000;

// Lines no one has asked for in this long go.
const keptMs = 60 * 24 * 60 * 60 * 1000;

export const hashOf = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 32);

export const createLines = ({
  database,
  complete,
  quickChoice,
  clock,
  info,
  waitMs = defaultWaitMs,
}: LinesOptions): Lines => {
  const writing = createCell<ReadonlyMap<string, Promise<unknown>>>(new Map());

  const kept = (key: string, basis: string): unknown => {
    const row = database.prepare("SELECT basis, body FROM life_lines WHERE key = ?").get(key) as Row | undefined;
    if (row?.basis !== basis) return undefined;
    database.prepare("UPDATE life_lines SET at = ? WHERE key = ?").run(toTimestamp(clock.now()), key);
    return JSON.parse(row.body) as unknown;
  };

  const keep = (key: string, basis: string, value: unknown): void => {
    const now = clock.now();
    database
      .prepare("INSERT OR REPLACE INTO life_lines (key, basis, body, at) VALUES (?, ?, ?, ?)")
      .run(key, basis, JSON.stringify(value), toTimestamp(now));
    database.prepare("DELETE FROM life_lines WHERE at < ?").run(toTimestamp(now - keptMs));
  };

  const run = async <Value>(
    { key, prompt, schema, toValue }: LineRequest<Value>,
    basis: string,
  ): Promise<Value | undefined> => {
    const answered = await complete(prompt, schema, await quickChoice());
    if (!answered.ok) {
      info("Kumo couldn't write a line in Life", { key, error: answered.failure });
      return undefined;
    }
    const value = toValue(answered.value);
    if (value === undefined) info("Kumo's line in Life didn't fit", { key });
    else keep(key, basis, value);
    return value;
  };

  return {
    write: async <Value>(request: LineRequest<Value>): Promise<Value | undefined> => {
      const basis = hashOf(request.basis);
      const found = kept(request.key, basis);
      if (found !== undefined) return found as Value;
      const id = `${request.key}\n${basis}`;
      const started = async (): Promise<Value | undefined> => {
        try {
          return await run(request, basis);
        } finally {
          writing.update((current) => new Map([...current].filter(([known]) => known !== id)));
        }
      };
      const pending = (writing.get().get(id) as Promise<Value | undefined> | undefined) ?? started();
      writing.update((current) => new Map([...current, [id, pending]]));
      const bound = createCell<(() => void) | undefined>(undefined);
      const timedOut = new Promise<undefined>((resolve) => {
        bound.set(
          clock.after(waitMs, () => {
            resolve(undefined);
          }),
        );
      });
      try {
        return await Promise.race([pending, timedOut]);
      } finally {
        bound.get()?.();
      }
    },
  };
};
