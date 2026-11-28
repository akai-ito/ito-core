import { createCell } from "#cell.ts";

// Waits for something whose failure changes nothing, such as tidying a page that may have closed, and gives back
// what it gave, or nothing.
export const quietly = async <Value>(promise: Promise<Value>): Promise<Value | undefined> => {
  try {
    return await promise;
  } catch {
    return undefined;
  }
};

// Waits for something at most `ms`, quietly: what it gave, or nothing once it failed or took too long. What took too
// long carries on by itself, and what it gives later is dropped, so one stuck page can never hold up what follows.
export const inTime = async <Value>(promise: Promise<Value>, ms: number): Promise<Value | undefined> => {
  const timer = createCell<NodeJS.Timeout | undefined>(undefined);
  const late = new Promise<undefined>((resolve) => {
    const waiting = setTimeout(() => {
      resolve(undefined);
    }, ms);
    waiting.unref();
    timer.set(waiting);
  });
  try {
    return await Promise.race([quietly(promise), late]);
  } finally {
    clearTimeout(timer.get());
  }
};
