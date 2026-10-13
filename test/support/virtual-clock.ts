import { createCell } from "#cell.ts";
import type { Clock } from "#clock.ts";

export type VirtualClock = Clock & {
  readonly runNext: (until: number) => boolean;
  readonly moveTo: (time: number) => void;
};

type Timer = { readonly id: number; readonly at: number; readonly callback: () => void };

type ClockState = { readonly now: number; readonly timers: readonly Timer[]; readonly nextId: number };

const earliest = (timers: readonly Timer[]): Timer | undefined =>
  timers.reduce<Timer | undefined>(
    (soonest, timer) =>
      !soonest || timer.at < soonest.at || (timer.at === soonest.at && timer.id < soonest.id) ? timer : soonest,
    undefined,
  );

export const createVirtualClock = (start: number): VirtualClock => {
  const state = createCell<ClockState>({ now: start, timers: [], nextId: 0 });

  return {
    now: () => state.get().now,
    after: (delayMs, callback) => {
      const { now, nextId } = state.get();
      state.update((current) => ({
        ...current,
        nextId: current.nextId + 1,
        timers: [...current.timers, { id: nextId, at: now + delayMs, callback }],
      }));
      return () => {
        state.update((current) => ({ ...current, timers: current.timers.filter((timer) => timer.id !== nextId) }));
      };
    },
    runNext: (until) => {
      const due = earliest(state.get().timers.filter((timer) => timer.at <= until));
      if (!due) return false;
      state.update((current) => ({
        ...current,
        now: Math.max(current.now, due.at),
        timers: current.timers.filter((timer) => timer.id !== due.id),
      }));
      due.callback();
      return true;
    },
    moveTo: (time) => {
      state.update((current) => ({ ...current, now: Math.max(current.now, time) }));
    },
  };
};
