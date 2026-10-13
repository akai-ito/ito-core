import { createCell } from "#cell.ts";

export type AsyncQueue<Value> = AsyncIterable<Value> & {
  readonly push: (value: Value) => void;
  readonly end: () => void;
};

type Waiter<Value> = (result: IteratorResult<Value, undefined>) => void;

type QueueState<Value> = {
  readonly values: readonly Value[];
  readonly waiters: readonly Waiter<Value>[];
  readonly isEnded: boolean;
};

const done = { done: true, value: undefined } as const;

export const createAsyncQueue = <Value>(): AsyncQueue<Value> => {
  const state = createCell<QueueState<Value>>({ values: [], waiters: [], isEnded: false });

  const push = (value: Value): void => {
    const { values, waiters, isEnded } = state.get();
    if (isEnded) return;
    const [waiter, ...rest] = waiters;
    if (waiter) {
      state.set({ values, waiters: rest, isEnded });
      waiter({ done: false, value });
      return;
    }
    state.set({ values: [...values, value], waiters, isEnded });
  };

  const end = (): void => {
    const { waiters } = state.get();
    state.set({ values: state.get().values, waiters: [], isEnded: true });
    for (const waiter of waiters) waiter(done);
  };

  const next = (): Promise<IteratorResult<Value, undefined>> => {
    const { values, waiters, isEnded } = state.get();
    const [value, ...rest] = values;
    if (values.length > 0) {
      state.set({ values: rest, waiters, isEnded });
      return Promise.resolve({ done: false, value: value as Value });
    }
    if (isEnded) return Promise.resolve(done);
    return new Promise((resolve) => {
      state.set({ values, waiters: [...waiters, resolve], isEnded });
    });
  };

  return {
    push,
    end,
    [Symbol.asyncIterator]: () => ({
      next,
      return: () => {
        end();
        return Promise.resolve(done);
      },
    }),
  };
};
