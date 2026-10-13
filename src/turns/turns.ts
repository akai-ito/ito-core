import { createCell } from "#cell.ts";
import type { Cancel, Clock } from "#clock.ts";
import { toCommandError, toTurnError, toWatchdogError } from "#conversation/failures.ts";
import type { MessageId, TurnId } from "#conversation/ids.ts";
import { isAdjustingAfterRead, route, type Conversation } from "#conversation/routing.ts";
import { adjustingStatus, stoppingStatus, toStatus, writingStatus } from "#conversation/status.ts";
import type { Engine, EngineEvent, Input } from "#engine/engine.ts";
import type { Identifiers } from "#identifiers.ts";
import type { Error as ErrorBody, Outcome } from "#protocol/types.ts";
import { fail, ok, type Result } from "#result.ts";
import type { PendingWork, Store } from "#store/store.ts";

export type Cut = { readonly message: MessageId; readonly offset: number };

export type StopState = { readonly state: "stopping" } | { readonly state: "ended"; readonly outcome: Outcome };

export type RetryStarted = { readonly turn: TurnId; readonly isNew: boolean };

export type Limits = {
  readonly watchdogMs: number;
  readonly forcedStopMs: number;
  readonly coalesceMs: number;
};

export type Log = (message: string, error: unknown) => void;

export type Turns = {
  readonly route: (message: MessageId, text: string) => void;
  readonly stop: (turn: TurnId, cut: Cut | undefined) => StopState | undefined;
  readonly retry: (failed: TurnId) => Result<RetryStarted, "not_found" | "not_failed">;
  readonly recover: () => void;
  readonly settled: () => Promise<void>;
  readonly close: () => Promise<void>;
};

type Writing = { readonly message: MessageId; readonly kind: "reply" | "note" };

type Running = {
  readonly id: TurnId;
  readonly phase: "running" | "stopping";
  readonly cut: Cut | undefined;
  readonly writing: Writing | undefined;
  readonly hasStartedReply: boolean;
  readonly awaitingRead: readonly MessageId[];
  readonly buffered: string;
  readonly lastFlushAt: number | undefined;
  readonly cancelFlush: Cancel | undefined;
  readonly cancelWatchdog: Cancel;
  readonly cancelForcedStop: Cancel | undefined;
};

export const defaultLimits: Limits = { watchdogMs: 60_000, forcedStopMs: 5000, coalesceMs: 100 };

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));

type MessageWork = Extract<PendingWork, { readonly kind: "message" }>;

const isMessageWork = (work: PendingWork): work is MessageWork => work.kind === "message";

const leadingMessages = (pending: readonly PendingWork[]): readonly MessageId[] => {
  const end = pending.findIndex((work) => work.kind !== "message");
  return pending
    .slice(0, end === -1 ? pending.length : end)
    .filter((work) => isMessageWork(work))
    .map((work) => work.message);
};

export const createTurns = (
  store: Store,
  engine: Engine,
  clock: Clock,
  identifiers: Identifiers,
  log: Log,
  limits: Limits = defaultLimits,
): Turns => {
  const running = createCell<Running | undefined>(undefined);
  const actor = createCell<Promise<void>>(Promise.resolve());

  const enqueue = (job: () => Promise<void> | void): Promise<void> =>
    actor.update(async (previous) => {
      await previous;
      try {
        await job();
      } catch (error) {
        log("A routing job failed", error);
      }
    });

  const current = (turn: TurnId): Running | undefined => {
    const state = running.get();
    return state?.id === turn ? state : undefined;
  };

  const change = (turn: TurnId, update: (state: Running) => Running): void => {
    const state = current(turn);
    if (state) running.set(update(state));
  };

  const conversation = (): Conversation => {
    const state = running.get();
    return {
      turn: state && { id: state.id, phase: state.phase, hasStartedReply: state.hasStartedReply },
      next: store
        .pendingWork()
        .filter((work) => isMessageWork(work))
        .map((work) => work.message),
    };
  };

  const clearTimers = (state: Running): void => {
    state.cancelWatchdog();
    state.cancelFlush?.();
    state.cancelForcedStop?.();
  };

  const sentLength = (state: Running): number => (state.writing ? (store.openMessage(state.id)?.text.length ?? 0) : 0);

  const flush = (turn: TurnId): void => {
    const state = current(turn);
    if (!state?.writing || state.buffered === "") return;
    store.appendText(state.writing.message, state.buffered);
    running.set({ ...state, buffered: "", cancelFlush: undefined, lastFlushAt: clock.now() });
  };

  const pushText = (turn: TurnId, text: string): void => {
    const state = current(turn);
    if (!state?.writing) return;
    const now = clock.now();
    const sinceFlush = state.lastFlushAt === undefined ? Infinity : now - state.lastFlushAt;
    if (sinceFlush >= limits.coalesceMs && state.buffered === "") {
      store.appendText(state.writing.message, text);
      running.set({ ...state, lastFlushAt: now });
      return;
    }
    running.set({
      ...state,
      buffered: state.buffered + text,
      cancelFlush:
        state.cancelFlush ??
        clock.after(limits.coalesceMs - sinceFlush, () => {
          flush(turn);
        }),
    });
  };

  const afterTurn = (state: Running): void => {
    clearTimers(state);
    running.set(undefined);
    for (const message of state.awaitingRead) store.queueMessage(state.id, message);
    void enqueue(drain);
  };

  const finishStop = (turn: TurnId): void => {
    const state = current(turn);
    if (!state) return;
    if (state.writing) {
      const sent = sentLength(state);
      const length = state.cut?.message === state.writing.message ? Math.min(state.cut.offset, sent) : sent;
      store.endMessage(state.writing.message, "stopped", length);
    }
    store.endTurn(turn, "stopped");
    afterTurn(state);
  };

  const failTurn = (turn: TurnId, error: ErrorBody): void => {
    flush(turn);
    const state = current(turn);
    if (!state) return;
    if (state.writing) store.endMessage(state.writing.message, "failed", sentLength(state), error);
    store.endTurn(turn, "failed", error);
    afterTurn(state);
  };

  const completeTurn = (turn: TurnId): void => {
    flush(turn);
    const state = current(turn);
    if (!state) return;
    if (state.writing) store.endMessage(state.writing.message, "completed", sentLength(state));
    store.endTurn(turn, "completed");
    afterTurn(state);
  };

  const interruptEngine = async (turn: TurnId, onFailure: () => Promise<void> | void): Promise<void> => {
    try {
      await engine.interrupt(turn);
    } catch (error) {
      log("Interrupting the engine failed", error);
      await onFailure();
    }
  };

  const forceStop = async (turn: TurnId): Promise<void> => {
    if (current(turn)?.phase !== "stopping") return;
    try {
      await engine.restart();
    } finally {
      finishStop(turn);
    }
  };

  const armWatchdog = (turn: TurnId): Cancel =>
    clock.after(limits.watchdogMs, () => {
      const state = current(turn);
      if (state?.phase !== "running") return;
      failTurn(turn, toWatchdogError(limits.watchdogMs, state.writing !== undefined));
      void interruptEngine(turn, () => engine.restart());
    });

  const resetWatchdog = (turn: TurnId): void => {
    change(turn, (state) => {
      state.cancelWatchdog();
      return { ...state, cancelWatchdog: armWatchdog(turn) };
    });
  };

  const handle = (turn: TurnId, event: EngineEvent): void => {
    const state = current(turn);
    if (!state) return;
    const isStopping = state.phase === "stopping";
    switch (event.type) {
      case "activity": {
        if (!isStopping) store.setStatus(turn, toStatus(event.activity));
        return;
      }
      case "text.started": {
        if (isStopping) return;
        if (event.kind === "reply") store.setStatus(turn, writingStatus);
        const message = store.startMessage(turn, event.kind);
        running.set({
          ...state,
          writing: { message, kind: event.kind },
          hasStartedReply: state.hasStartedReply || event.kind === "reply",
          buffered: "",
          lastFlushAt: undefined,
        });
        return;
      }
      case "text": {
        if (!isStopping) pushText(turn, event.text);
        return;
      }
      case "text.ended": {
        if (isStopping || !state.writing) return;
        flush(turn);
        store.endMessage(state.writing.message, "completed", sentLength(state));
        change(turn, (latest) => ({ ...latest, writing: undefined }));
        return;
      }
      case "input.read": {
        store.markRead(turn, event.messageId);
        change(turn, (latest) => ({
          ...latest,
          awaitingRead: latest.awaitingRead.filter((message) => message !== event.messageId),
        }));
        if (!isStopping && isAdjustingAfterRead(state)) store.setStatus(turn, adjustingStatus);
        return;
      }
      case "failed": {
        failTurn(turn, toTurnError(event.code, event.detail));
        return;
      }
      case "stopped": {
        finishStop(turn);
        return;
      }
      case "ended": {
        if (isStopping) finishStop(turn);
        else completeTurn(turn);
        return;
      }
    }
  };

  const consume = async (turn: TurnId, events: AsyncIterable<EngineEvent>): Promise<void> => {
    try {
      for await (const event of events) {
        if (!current(turn)) return;
        resetWatchdog(turn);
        handle(turn, event);
      }
      if (current(turn)) failTurn(turn, toTurnError("engine_failed", "The engine ended the turn without a result."));
    } catch (error) {
      if (current(turn)) failTurn(turn, toTurnError("engine_failed", describe(error)));
    }
  };

  const inputOf = (message: MessageId): Input => ({ messageId: message, text: store.messageText(message) ?? "" });

  const startTurn = (
    inputs: readonly MessageId[],
    retry?: { readonly turn: TurnId; readonly retryOf: TurnId },
  ): void => {
    const turn = retry?.turn ?? identifiers.turn();
    store.startTurn(turn, inputs, retry?.retryOf);
    running.set({
      id: turn,
      phase: "running",
      cut: undefined,
      writing: undefined,
      hasStartedReply: false,
      awaitingRead: [],
      buffered: "",
      lastFlushAt: undefined,
      cancelFlush: undefined,
      cancelWatchdog: armWatchdog(turn),
      cancelForcedStop: undefined,
    });
    void consume(
      turn,
      engine.start(
        turn,
        inputs.map((message) => inputOf(message)),
      ),
    );
  };

  const drain = (): void => {
    if (running.get()) return;
    const pending = store.pendingWork();
    const [first] = pending;
    if (!first) return;
    if (first.kind === "retry") {
      startTurn(store.findTurn(first.retryOf)?.inputs ?? [], { turn: first.turn, retryOf: first.retryOf });
      return;
    }
    startTurn(leadingMessages(pending));
  };

  const routeMessage = async (message: MessageId, text: string): Promise<void> => {
    const decision = route(conversation(), message);
    switch (decision.kind) {
      case "start": {
        startTurn(decision.inputs);
        return;
      }
      case "queue": {
        store.queueMessage(decision.behind, message);
        return;
      }
      case "steer": {
        const outcome = await engine.steer(decision.turn, { messageId: message, text });
        if (outcome === "taken" && current(decision.turn)) {
          change(decision.turn, (state) => ({ ...state, awaitingRead: [...state.awaitingRead, message] }));
          return;
        }
        store.queueMessage(decision.turn, message);
        if (!running.get()) drain();
        return;
      }
    }
  };

  return {
    route: (message, text) => {
      void enqueue(() => routeMessage(message, text));
    },

    stop: (turn, cut) => {
      const state = current(turn);
      if (state) {
        if (state.phase === "running") {
          running.set({
            ...state,
            phase: "stopping",
            cut,
            buffered: "",
            cancelForcedStop: clock.after(limits.forcedStopMs, () => {
              void forceStop(turn);
            }),
          });
          state.cancelFlush?.();
          store.setStatus(turn, stoppingStatus);
          void interruptEngine(turn, () => forceStop(turn));
        }
        return { state: "stopping" };
      }
      const stored = store.findTurn(turn);
      if (!stored) return;
      return stored.outcome ? { state: "ended", outcome: stored.outcome } : { state: "stopping" };
    },

    retry: (failed) => {
      const stored = store.findTurn(failed);
      if (!stored) return fail("not_found");
      const existing = store.retryFor(failed);
      if (existing) return ok({ turn: existing, isNew: false });
      if (stored.outcome !== "failed") return fail("not_failed");
      const turn = store.requestRetry(failed, identifiers.turn());
      void enqueue(drain);
      return ok({ turn, isNew: true });
    },

    recover: () => {
      const turn = store.runningTurn();
      if (turn) {
        const open = store.openMessage(turn.id);
        if (open) store.endMessage(open.id, "interrupted", open.text.length);
        store.endTurn(turn.id, "interrupted");
      }
      void enqueue(drain);
    },

    settled: () => actor.get(),

    close: async () => {
      const state = running.get();
      if (state) clearTimers(state);
      running.set(undefined);
      await actor.get();
    },
  };
};

export const toRetryFailure = (failure: "not_found" | "not_failed"): ErrorBody =>
  failure === "not_found"
    ? toCommandError("not_found", "No turn with that id.", "That turn isn't on the server.")
    : toCommandError(
        "invalid_request",
        "Only a failed turn can be tried again.",
        "Only a reply that failed can be tried again.",
      );
