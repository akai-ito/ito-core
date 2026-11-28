import { createCell } from "#cell.ts";
import { inTime } from "./quietly.ts";

// The latest of something read from the page, such as the field with the focus, told as soon as it's known and never
// in the way of his input. A read waits a moment for the input that asked for it to land, runs one at a time, and is
// let go after `limitMs`, so the next can start. A read is told only if it began after the one told last, so the
// newest wins. One that failed or was let go is tried again a little later, a few times, as a page between documents
// answers once the next one is there.

export type ReporterOptions<Value> = {
  readonly read: () => Promise<Value>;
  readonly report: (value: Value) => void;
  readonly delayMs?: number;
  readonly limitMs?: number;
  readonly retryMs?: number;
  readonly retries?: number;
};

export type Reporter = {
  readonly request: () => void;
  readonly stop: () => void;
};

// A read's value in a box, so a value of nothing is told apart from no answer in time.
const boxed = async <Value>(read: () => Promise<Value>): Promise<{ readonly given: Value }> => ({
  given: await read(),
});

export const createReporter = <Value>({
  read,
  report,
  delayMs = 40,
  limitMs = 800,
  retryMs = 400,
  retries = 4,
}: ReporterOptions<Value>): Reporter => {
  const timer = createCell<NodeJS.Timeout | undefined>(undefined);
  const started = createCell(0);
  const told = createCell(0);
  const asked = createCell(0);
  const isReading = createCell(false);
  const isAgain = createCell(false);
  // Moves on when it stops, so what was being read then is never told.
  const era = createCell(0);

  const schedule = (ms: number, tries: number): void => {
    clearTimeout(timer.get());
    const waiting = setTimeout(() => {
      void attempt(tries);
    }, ms);
    waiting.unref();
    timer.set(waiting);
  };

  const attempt = async (tries: number): Promise<void> => {
    if (isReading.get()) {
      isAgain.set(true);
      return;
    }
    isReading.set(true);
    isAgain.set(false);
    const mine = started.update((count) => count + 1);
    const request = asked.get();
    const begun = era.get();
    const value = await inTime(boxed(read), limitMs);
    isReading.set(false);
    if (begun !== era.get()) return;
    if (value !== undefined && mine > told.get()) {
      told.set(mine);
      report(value.given);
    }
    if (isAgain.get() || asked.get() !== request) {
      schedule(delayMs, retries);
      return;
    }
    if (value === undefined && tries > 0) schedule(retryMs, tries - 1);
  };

  return {
    request: () => {
      asked.update((count) => count + 1);
      schedule(delayMs, retries);
    },
    stop: () => {
      clearTimeout(timer.get());
      era.update((count) => count + 1);
      isAgain.set(false);
    },
  };
};
