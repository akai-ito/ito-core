import { createCell } from "#cell.ts";
import type { Cancel, Clock } from "#clock.ts";
import { toCommandError, toTurnError, toWatchdogError } from "#conversation/failures.ts";
import type { AskId, MessageId, TurnId } from "#conversation/ids.ts";
import { isAdjustingAfterRead, route, type Conversation } from "#conversation/routing.ts";
import { createSecrets, type Secrets } from "#conversation/secrets.ts";
import { adjustingStatus, stoppingStatus, toStepStatus, writingStatus } from "#conversation/status.ts";
import { toEndedStep, toStepTitle, toUpdatedStep, type Trail } from "#conversation/steps.ts";
import type { AskFields, Engine, EngineEvent, Input, StepFacts } from "#engine/engine.ts";
import type { Identifiers } from "#identifiers.ts";
import type { Ask, Error as ErrorBody, Outcome, Status, Step, StepKind } from "#protocol/types.ts";
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

export type TurnsOptions = {
  readonly limits?: Limits;
  readonly attachmentPath?: (id: string) => string;
  readonly secrets?: Secrets;
  readonly trail?: Trail;
};

export type Info = (message: string, details: Readonly<Record<string, unknown>>) => void;

export type Turns = {
  readonly route: (message: MessageId, text: string, isSecret?: boolean) => void;
  readonly stop: (turn: TurnId, cut: Cut | undefined) => StopState | undefined;
  readonly retry: (failed: TurnId) => Result<RetryStarted, "not_found" | "not_failed">;
  readonly ask: (fields: AskFields) => Result<Ask, "no_turn">;
  readonly recordStep: (kind: StepKind, facts: StepFacts) => boolean;
  readonly cancelAsk: (ask: AskId) => Result<Ask, "not_found">;
  readonly recover: () => void;
  readonly settled: () => Promise<void>;
  readonly close: () => Promise<void>;
};

type Writing = { readonly message: MessageId; readonly kind: "reply" | "note" };

type Running = {
  readonly id: TurnId;
  readonly phase: "running" | "stopping" | "asking";
  readonly cut: Cut | undefined;
  readonly writing: Writing | undefined;
  readonly hasStartedReply: boolean;
  readonly awaitingRead: readonly MessageId[];
  readonly buffered: string;
  readonly held: string;
  readonly lastFlushAt: number | undefined;
  readonly cancelFlush: Cancel | undefined;
  readonly cancelWatchdog: Cancel;
  readonly cancelForcedStop: Cancel | undefined;
  readonly steps: ReadonlyMap<string, Step>;
};

export const defaultLimits: Limits = { watchdogMs: 60_000, forcedStopMs: 5000, coalesceMs: 100 };

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const statusOf = (step: Step): Status => toStepStatus(step.kind, step.title, step.heading);

const isSameStatus = (left: Status, right: Status): boolean =>
  left.kind === right.kind && left.label === right.label && left.detail === right.detail;

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
  { limits = defaultLimits, attachmentPath = (id: string) => id, secrets = createSecrets(), trail }: TurnsOptions = {},
): Turns => {
  const running = createCell<Running | undefined>(undefined);
  const actor = createCell<Promise<void>>(Promise.resolve());
  const received = createCell<ReadonlyMap<MessageId, string>>(new Map());
  const notes = createCell<readonly string[]>([]);

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

  const emitText = (turn: TurnId, text: string): void => {
    const state = current(turn);
    if (text === "" || !state?.writing) return;
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

  const pushText = (turn: TurnId, text: string): void => {
    const state = current(turn);
    if (!state?.writing) return;
    const combined = secrets.redact(state.held + text);
    const cut = combined.length - secrets.unfinished(combined);
    running.set({ ...state, held: combined.slice(cut) });
    emitText(turn, combined.slice(0, cut));
  };

  const releaseHeld = (turn: TurnId): void => {
    const state = current(turn);
    if (!state?.held) return;
    running.set({ ...state, held: "" });
    emitText(turn, state.held);
  };

  const endOpenMessage = (turn: TurnId): void => {
    releaseHeld(turn);
    flush(turn);
    const state = current(turn);
    if (!state?.writing) return;
    store.endMessage(state.writing.message, "completed", sentLength(state));
    running.set({ ...state, writing: undefined });
  };

  const afterTurn = (state: Running): void => {
    clearTimers(state);
    running.set(undefined);
    for (const message of state.awaitingRead) store.queueMessage(state.id, message);
    void enqueue(drain);
  };

  const endOpenSteps = (state: Running, outcome: Outcome): void => {
    for (const step of state.steps.values()) store.endStep(toEndedStep(step, outcome, {}, clock.now(), trail));
  };

  const changeSteps = (turn: TurnId, update: (steps: ReadonlyMap<string, Step>) => ReadonlyMap<string, Step>): void => {
    change(turn, (latest) => ({ ...latest, steps: update(latest.steps) }));
  };

  const startStep = (turn: TurnId, event: Extract<EngineEvent, { readonly type: "step.started" }>): void => {
    const started = { kind: event.kind, facts: secrets.redactValue(event.facts) };
    const { kind, facts } = trail?.toStart(started) ?? started;
    const title = toStepTitle(kind, facts, "present", trail);
    const step = store.startStep(turn, kind, title, facts);
    changeSteps(turn, (steps) => new Map(steps).set(event.key, step));
    store.setStatus(turn, statusOf(step));
  };

  const updateStep = (turn: TurnId, event: Extract<EngineEvent, { readonly type: "step.updated" }>): void => {
    const step = current(turn)?.steps.get(event.key);
    if (!step) return;
    const updated = toUpdatedStep(step, secrets.redactValue(event.facts), trail);
    store.updateStep(updated);
    changeSteps(turn, (steps) => new Map(steps).set(event.key, updated));
    if (!isSameStatus(statusOf(step), statusOf(updated))) store.setStatus(turn, statusOf(updated));
  };

  const endStep = (turn: TurnId, event: Extract<EngineEvent, { readonly type: "step.ended" }>): void => {
    const step = current(turn)?.steps.get(event.key);
    if (!step) return;
    const ended = { outcome: event.outcome, facts: secrets.redactValue(event.facts) };
    const { outcome, facts } = trail?.toEnd(step, ended) ?? ended;
    store.endStep(toEndedStep(step, outcome, facts, clock.now(), trail));
    changeSteps(turn, (steps) => new Map([...steps].filter(([key]) => key !== event.key)));
  };

  const finishStop = (turn: TurnId): void => {
    const state = current(turn);
    if (!state) return;
    if (state.writing) {
      const sent = sentLength(state);
      const length = state.cut?.message === state.writing.message ? Math.min(state.cut.offset, sent) : sent;
      store.endMessage(state.writing.message, "stopped", length);
    }
    endOpenSteps(state, "stopped");
    store.endTurn(turn, "stopped");
    afterTurn(state);
  };

  const failTurn = (turn: TurnId, error: ErrorBody): void => {
    releaseHeld(turn);
    flush(turn);
    const state = current(turn);
    if (!state) return;
    if (state.writing) store.endMessage(state.writing.message, "failed", sentLength(state), error);
    endOpenSteps(state, "failed");
    if (!state.hasStartedReply) store.endMessage(store.startMessage(turn, "reply"), "failed", 0, error);
    store.endTurn(turn, "failed", error);
    afterTurn(state);
  };

  const completeTurn = (turn: TurnId): void => {
    releaseHeld(turn);
    flush(turn);
    const state = current(turn);
    if (!state) return;
    if (state.writing) store.endMessage(state.writing.message, "completed", sentLength(state));
    endOpenSteps(state, "completed");
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

  const askNow = (turn: TurnId, fields: AskFields): Result<Ask, "no_turn"> => {
    const state = current(turn);
    if (state?.phase !== "running") return fail("no_turn");
    endOpenMessage(turn);
    const asked = store.startAsk(turn, secrets.redactValue(fields));
    change(turn, (latest) => ({ ...latest, phase: "asking", buffered: "", held: "" }));
    return ok(asked);
  };

  const finishAsking = async (turn: TurnId): Promise<void> => {
    if (current(turn)?.phase !== "asking") return;
    try {
      await engine.restart();
    } finally {
      completeTurn(turn);
    }
  };

  const endAfterAsking = (turn: TurnId): void => {
    change(turn, (latest) => ({
      ...latest,
      cancelForcedStop:
        latest.cancelForcedStop ??
        clock.after(limits.forcedStopMs, () => {
          void finishAsking(turn);
        }),
    }));
    void interruptEngine(turn, () => finishAsking(turn));
  };

  const handle = (turn: TurnId, event: EngineEvent): void => {
    const state = current(turn);
    if (!state) return;
    const isQuiet = state.phase !== "running";
    const isAsking = state.phase === "asking";
    switch (event.type) {
      case "step.started": {
        if (!isQuiet) startStep(turn, event);
        return;
      }
      case "step.updated": {
        if (!isQuiet) updateStep(turn, event);
        return;
      }
      case "step.ended": {
        if (!isQuiet) endStep(turn, event);
        return;
      }
      case "text.started": {
        if (isQuiet) return;
        endOpenMessage(turn);
        if (event.kind === "reply") store.setStatus(turn, writingStatus);
        const message = store.startMessage(turn, event.kind);
        running.set({
          ...(current(turn) ?? state),
          writing: { message, kind: event.kind },
          hasStartedReply: state.hasStartedReply || event.kind === "reply",
          buffered: "",
          held: "",
          lastFlushAt: undefined,
        });
        return;
      }
      case "text": {
        if (!isQuiet) pushText(turn, event.text);
        return;
      }
      case "text.ended": {
        if (!isQuiet) endOpenMessage(turn);
        return;
      }
      case "input.read": {
        store.markRead(turn, event.messageId);
        change(turn, (latest) => ({
          ...latest,
          awaitingRead: latest.awaitingRead.filter((message) => message !== event.messageId),
        }));
        if (!isQuiet && isAdjustingAfterRead(state)) store.setStatus(turn, adjustingStatus);
        return;
      }
      case "ask": {
        askNow(turn, event.fields);
        return;
      }
      case "asked": {
        if (isAsking) endAfterAsking(turn);
        return;
      }
      case "failed": {
        if (isAsking) completeTurn(turn);
        else if (isQuiet) finishStop(turn);
        else failTurn(turn, toTurnError(event.code, event.detail));
        return;
      }
      case "progress": {
        return;
      }
      case "stopped": {
        if (isAsking) completeTurn(turn);
        else finishStop(turn);
        return;
      }
      case "ended": {
        if (state.phase === "stopping") finishStop(turn);
        else completeTurn(turn);
        return;
      }
    }
  };

  const endUnfinished = (turn: TurnId, detail: string): void => {
    const state = current(turn);
    if (state?.phase === "stopping") finishStop(turn);
    else if (state?.phase === "asking") completeTurn(turn);
    else if (state) failTurn(turn, toTurnError("engine_failed", detail));
  };

  const consume = async (turn: TurnId, events: AsyncIterable<EngineEvent>): Promise<void> => {
    try {
      for await (const event of events) {
        if (!current(turn)) return;
        resetWatchdog(turn);
        handle(turn, event);
      }
      endUnfinished(turn, "The engine ended the turn without a result.");
    } catch (error) {
      endUnfinished(turn, describe(error));
    }
  };

  const lostSecret =
    "(Their answer was a secret, and the server restarted before you could read it. Ask for it again.)";

  const inputOf = (message: MessageId): Input => {
    const attached = store.messageAttachments(message).map((attachment) => ({
      kind: attachment.kind === "image" ? ("image" as const) : ("file" as const),
      name: attachment.name,
      source: attachmentPath(attachment.id),
    }));
    const text = received.get().get(message) ?? store.messageText(message) ?? "";
    return {
      messageId: message,
      text: text === "" && attached.length === 0 ? lostSecret : text,
      ...(attached.length > 0 && { attachments: attached }),
    };
  };

  const withNotes = (inputs: readonly Input[]): readonly Input[] => {
    const pending = notes.get();
    const [first, ...rest] = inputs;
    if (!first || pending.length === 0) return inputs;
    notes.set([]);
    return [{ ...first, text: [...pending, first.text].join("\n\n") }, ...rest];
  };

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
      held: "",
      lastFlushAt: undefined,
      cancelFlush: undefined,
      cancelWatchdog: armWatchdog(turn),
      cancelForcedStop: undefined,
      steps: new Map(),
    });
    const engineInputs = withNotes(inputs.map((message) => inputOf(message)));
    received.update((texts) => new Map([...texts].filter(([message]) => !inputs.includes(message))));
    void consume(turn, engine.start(turn, engineInputs));
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

  const routeMessage = async (message: MessageId): Promise<void> => {
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
        const outcome = await engine.steer(decision.turn, inputOf(message));
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
    route: (message, text, isSecret = false) => {
      if (isSecret) secrets.add(text);
      received.update((texts) => new Map([...texts, [message, text]]));
      void enqueue(() => routeMessage(message));
    },

    ask: (fields) => {
      const state = running.get();
      return state ? askNow(state.id, fields) : fail("no_turn");
    },

    recordStep: (kind, facts) => {
      const state = running.get();
      if (!state) return false;
      const key = `core:${identifiers.step()}`;
      startStep(state.id, { type: "step.started", key, kind, facts });
      endStep(state.id, { type: "step.ended", key, outcome: "completed", facts: {} });
      return true;
    },

    cancelAsk: (ask) => {
      const before = store.findAsk(ask);
      const cancelled = store.cancelAsk(ask);
      if (before && !before.outcome && cancelled.ok) {
        notes.update((current) => [
          ...current,
          `(You asked “${before.question}”, and they cancelled it without answering.)`,
        ]);
      }
      return cancelled;
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
            held: "",
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
        for (const step of store.openSteps(turn.id)) {
          store.endStep(toEndedStep(step, "interrupted", {}, clock.now()));
        }
        if (!turn.hasStartedReply) store.endMessage(store.startMessage(turn.id, "reply"), "interrupted", 0);
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
