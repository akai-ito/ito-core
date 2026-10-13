import { createAsyncQueue, type AsyncQueue } from "#async-queue.ts";
import { createCell } from "#cell.ts";
import type { Cancel, Clock } from "#clock.ts";
import type { TurnId } from "#conversation/ids.ts";
import type { Engine, EngineEvent, Input, SteerOutcome } from "#engine/engine.ts";

export type TimedEvent = { readonly at: number; readonly event: EngineEvent };

export type Steered = { readonly outcome: SteerOutcome; readonly events?: readonly TimedEvent[] };

export type TurnScript = {
  readonly events: readonly TimedEvent[];
  readonly steer: (input: Input, now: number) => Steered;
  readonly stoppedAt: (requestedAt: number) => number;
};

export type ScriptSource = (turn: TurnId, inputs: readonly Input[], now: number) => TurnScript;

type Scheduled = { readonly at: number; readonly event: EngineEvent; readonly cancel: Cancel };

type Playing = {
  readonly queue: AsyncQueue<EngineEvent>;
  readonly script: TurnScript;
  readonly scheduled: readonly Scheduled[];
};

const terminalTypes: ReadonlySet<EngineEvent["type"]> = new Set(["ended", "failed", "stopped"]);

const isTerminal = (event: EngineEvent): boolean => terminalTypes.has(event.type);

export const createScriptEngine = (clock: Clock, scriptFor: ScriptSource): Engine => {
  const playing = createCell<ReadonlyMap<TurnId, Playing>>(new Map());

  const finish = (turn: TurnId): void => {
    const current = playing.get().get(turn);
    if (!current) return;
    for (const { cancel } of current.scheduled) cancel();
    current.queue.end();
    playing.update((turns) => new Map([...turns].filter(([id]) => id !== turn)));
  };

  const emit = (turn: TurnId, event: EngineEvent): void => {
    playing.get().get(turn)?.queue.push(event);
    if (isTerminal(event)) finish(turn);
  };

  const toScheduled = (turn: TurnId, { at, event }: TimedEvent): Scheduled => ({
    at,
    event,
    cancel: clock.after(Math.max(0, at - clock.now()), () => {
      emit(turn, event);
    }),
  });

  const replace = (turn: TurnId, scheduled: readonly Scheduled[]): void => {
    playing.update((turns) => {
      const current = turns.get(turn);
      return current ? new Map([...turns, [turn, { ...current, scheduled }]]) : turns;
    });
  };

  const schedule = (turn: TurnId, timed: readonly TimedEvent[]): void => {
    const current = playing.get().get(turn);
    if (!current) return;
    const latest = Math.max(...timed.map(({ at }) => at));
    const ending = current.scheduled.filter(({ event, at }) => isTerminal(event) && at <= latest);
    for (const { cancel } of ending) cancel();
    const moved = ending.map(({ event }) => ({ at: latest + 1, event }));
    const kept = current.scheduled.filter((item) => !ending.includes(item));
    replace(turn, [...kept, ...[...timed, ...moved].map((item) => toScheduled(turn, item))]);
  };

  return {
    start: (turn, inputs) => {
      const queue = createAsyncQueue<EngineEvent>();
      const script = scriptFor(turn, inputs, clock.now());
      playing.update((turns) => new Map([...turns, [turn, { queue, script, scheduled: [] }]]));
      schedule(turn, script.events);
      return queue;
    },

    steer: (turn, input) => {
      const current = playing.get().get(turn);
      if (!current) return Promise.resolve("refused");
      const steered = current.script.steer(input, clock.now());
      if (steered.events) schedule(turn, steered.events);
      return Promise.resolve(steered.outcome);
    },

    interrupt: (turn) => {
      const current = playing.get().get(turn);
      if (!current) return Promise.resolve();
      for (const { cancel } of current.scheduled) cancel();
      replace(turn, []);
      schedule(turn, [{ at: current.script.stoppedAt(clock.now()), event: { type: "stopped" } }]);
      return Promise.resolve();
    },

    restart: () => {
      for (const turn of playing.get().keys()) finish(turn);
      return Promise.resolve();
    },

    close: () => {
      for (const turn of playing.get().keys()) finish(turn);
      return Promise.resolve();
    },
  };
};
