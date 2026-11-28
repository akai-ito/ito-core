import { createCell } from "#cell.ts";
import { fail, ok, type Result } from "#result.ts";
import { inTime } from "./quietly.ts";

// His touches, keys and text, applied to the page one after another in the order they came, each given a moment at
// most: one that hangs, such as on a page that's busy or between documents, is left to finish by itself and the next
// goes on. A finger's move or a scroll that comes while the one before it still waits joins it, so a slow page
// catches up at once rather than replaying every step.

export type LaneOptions<Item> = {
  readonly apply: (item: Item) => Promise<Result<undefined, string>>;
  // The two as one, when they can be, such as two scrolls in a row; otherwise nothing.
  readonly merge: (waiting: Item, next: Item) => Item | undefined;
  // How long one may take before the next goes on.
  readonly limitMs: (item: Item) => number;
};

export type Lane<Item> = {
  // Resolves once it's applied, or given up on: never later than its limit after its turn comes.
  readonly push: (item: Item) => Promise<Result<undefined, string>>;
  // Drops what still waits, such as when the takeover ends.
  readonly clear: (why: string) => void;
  readonly waiting: () => number;
};

type Waiting<Item> = {
  readonly item: Item;
  readonly answers: readonly ((result: Result<undefined, string>) => void)[];
};

const describe = (error: unknown): string =>
  error instanceof Error ? (error.message.split("\n", 1)[0] ?? error.message) : String(error);

export const createLane = <Item>({ apply, merge, limitMs }: LaneOptions<Item>): Lane<Item> => {
  const queue = createCell<readonly Waiting<Item>[]>([]);
  const isRunning = createCell(false);

  const attempt = async (item: Item): Promise<Result<undefined, string>> => {
    try {
      return await apply(item);
    } catch (error) {
      return fail(describe(error));
    }
  };

  // One at a time, never awaiting the next, so a long takeover builds no chain of waits.
  const next = async (): Promise<void> => {
    const [first, ...rest] = queue.get();
    if (!first) {
      isRunning.set(false);
      return;
    }
    queue.set(rest);
    // Given up on, it may still land: it was sent, so it's not refused.
    const result = (await inTime(attempt(first.item), limitMs(first.item))) ?? ok(undefined);
    for (const answer of first.answers) answer(result);
    void next();
  };

  return {
    push: (item) =>
      new Promise((resolve) => {
        const waiting = queue.get();
        const last = waiting.at(-1);
        const merged = last === undefined ? undefined : merge(last.item, item);
        queue.set(
          last === undefined || merged === undefined
            ? [...waiting, { item, answers: [resolve] }]
            : [...waiting.slice(0, -1), { item: merged, answers: [...last.answers, resolve] }],
        );
        if (isRunning.get()) return;
        isRunning.set(true);
        void next();
      }),
    clear: (why) => {
      const dropped = queue.get();
      queue.set([]);
      for (const { answers } of dropped) for (const answer of answers) answer(fail(why));
    },
    waiting: () => queue.get().length,
  };
};
