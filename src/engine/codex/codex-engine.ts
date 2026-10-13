import { createAsyncQueue, type AsyncQueue } from "#async-queue.ts";
import { createCell } from "#cell.ts";
import type { TurnId } from "#conversation/ids.ts";
import type { ServerNotification } from "#engine/codex/bindings/ServerNotification.ts";
import type { JsonValue } from "#engine/codex/bindings/serde_json/JsonValue.ts";
import type { ThreadStartParams } from "#engine/codex/bindings/v2/ThreadStartParams.ts";
import type { UserInput } from "#engine/codex/bindings/v2/UserInput.ts";
import { startCodexProcess, type CodexProcess } from "#engine/codex/codex-process.ts";
import { initialTurnState, toEngineEvents, type TurnState } from "#engine/codex/mapping.ts";
import type { Engine, EngineEvent, Input } from "#engine/engine.ts";
import { fail, ok, type Result } from "#result.ts";
import type { Settings } from "#store/store.ts";
import type { Log } from "#turns/turns.ts";

export type CodexEngineOptions = {
  readonly codexHome: string;
  readonly workspace: string;
  readonly settings: Settings;
  readonly log: Log;
  readonly modelProvider?: string;
  readonly config?: Readonly<Record<string, JsonValue>>;
};

type Session = { readonly process: CodexProcess; readonly threadId: string };

type ActiveTurn = {
  readonly id: TurnId;
  readonly queue: AsyncQueue<EngineEvent>;
  readonly codexTurn: Promise<string | undefined>;
  readonly state: TurnState;
};

export const threadSetting = "codex_thread_id";

const terminalTypes: ReadonlySet<EngineEvent["type"]> = new Set(["ended", "failed", "stopped"]);

const toUserInput = ({ text }: Input): UserInput => ({ type: "text", text, text_elements: [] });

type Scope = Readonly<Partial<Record<"threadId" | "turnId", unknown>>>;

const fieldOf = (notification: ServerNotification, field: keyof Scope): string | undefined => {
  const value = (notification.params as Scope | null)?.[field];
  return typeof value === "string" ? value : undefined;
};

export const createCodexEngine = ({
  codexHome,
  workspace,
  settings,
  log,
  modelProvider,
  config,
}: CodexEngineOptions): Engine => {
  const active = createCell<ActiveTurn | undefined>(undefined);
  const session = createCell<Promise<Result<Session, string>> | undefined>(undefined);
  const generation = createCell(0);
  const openThreadId = createCell<string | undefined>(undefined);
  const threadOptions: ThreadStartParams = {
    cwd: workspace,
    approvalPolicy: "never",
    sandbox: "workspace-write",
    config: { sandbox_workspace_write: { network_access: true }, ...config },
    ...(modelProvider && { modelProvider }),
  };

  const emit = (turn: TurnId, events: readonly EngineEvent[]): void => {
    for (const event of events) {
      const current = active.get();
      if (current?.id !== turn) return;
      current.queue.push(event);
      if (!terminalTypes.has(event.type)) continue;
      current.queue.end();
      active.set(undefined);
    }
  };

  const onNotification = (notification: ServerNotification): void => {
    const current = active.get();
    if (!current || fieldOf(notification, "threadId") !== openThreadId.get()) return;
    const { state, events } = toEngineEvents(current.state, notification);
    const isTurnScoped = fieldOf(notification, "turnId") !== undefined;
    active.set({ ...current, state });
    emit(current.id, isTurnScoped && events.length === 0 ? [{ type: "progress" }] : events);
  };

  const openThread = async (process: CodexProcess): Promise<Result<string, string>> => {
    const stored = settings.setting(threadSetting);
    if (stored) {
      const resumed = await process.call("thread/resume", { ...threadOptions, threadId: stored });
      if (resumed.ok) return ok(resumed.value.thread.id);
      log("Codex couldn't resume the conversation's thread, so it starts a new one", resumed.failure.message);
    }
    const started = await process.call("thread/start", threadOptions);
    if (!started.ok) return fail(`Codex couldn't start a thread: ${started.failure.message}`);
    settings.setSetting(threadSetting, started.value.thread.id);
    return ok(started.value.thread.id);
  };

  const openSession = async (): Promise<Result<Session, string>> => {
    const opened = generation.get();
    const started = await startCodexProcess({
      codexHome,
      workspace,
      onNotification,
      onExit: (description) => {
        if (generation.get() !== opened) return;
        session.set(undefined);
        const current = active.get();
        if (current) emit(current.id, [{ type: "failed", code: "engine_failed", detail: description }]);
      },
    });
    if (!started.ok) return started;
    const threadId = await openThread(started.value);
    if (!threadId.ok) {
      await started.value.kill();
      return threadId;
    }
    openThreadId.set(threadId.value);
    return ok({ process: started.value, threadId: threadId.value });
  };

  const ensureSession = async (): Promise<Result<Session, string>> => {
    const existing = session.get();
    if (existing) return existing;
    const opening = openSession();
    session.set(opening);
    const opened = await opening;
    if (!opened.ok && session.get() === opening) session.set(undefined);
    return opened;
  };

  const beginTurn = async (turn: TurnId, inputs: readonly Input[]): Promise<string | undefined> => {
    const opened = await ensureSession();
    if (!opened.ok) {
      emit(turn, [{ type: "failed", code: "engine_failed", detail: opened.failure }]);
      return undefined;
    }
    const started = await opened.value.process.call("turn/start", {
      threadId: opened.value.threadId,
      clientUserMessageId: inputs[0]?.messageId ?? null,
      input: inputs.map((input) => toUserInput(input)),
      summary: "auto",
    });
    if (started.ok) return started.value.turn.id;
    emit(turn, [{ type: "failed", code: "engine_failed", detail: started.failure.message }]);
    return undefined;
  };

  const endSession = async (shutdown: (process: CodexProcess) => Promise<void>): Promise<void> => {
    generation.update((count) => count + 1);
    const current = active.get();
    active.set(undefined);
    current?.queue.end();
    const opening = session.get();
    session.set(undefined);
    const opened = await opening;
    if (opened?.ok) await shutdown(opened.value.process);
  };

  return {
    start: (turn, inputs) => {
      const queue = createAsyncQueue<EngineEvent>();
      active.set({ id: turn, queue, codexTurn: beginTurn(turn, inputs), state: initialTurnState });
      return queue;
    },

    steer: async (turn, input) => {
      const current = active.get();
      if (current?.id !== turn || current.state.isCompacting) return "refused";
      const codexTurn = await current.codexTurn;
      const opened = await session.get();
      const latest = active.get();
      if (!codexTurn || !opened?.ok || latest?.id !== turn) return "refused";
      active.set({
        ...latest,
        state: { ...latest.state, steered: new Set([...latest.state.steered, input.messageId]) },
      });
      const steered = await opened.value.process.call("turn/steer", {
        threadId: opened.value.threadId,
        expectedTurnId: codexTurn,
        clientUserMessageId: input.messageId,
        input: [toUserInput(input)],
      });
      if (steered.ok) return "taken";
      log("Codex didn't take a steer, so the message waits as Next", steered.failure.message);
      return "refused";
    },

    interrupt: async (turn) => {
      const current = active.get();
      if (current?.id !== turn) return;
      const codexTurn = await current.codexTurn;
      const opened = await session.get();
      if (!codexTurn || !opened?.ok) return;
      const interrupted = await opened.value.process.call("turn/interrupt", {
        threadId: opened.value.threadId,
        turnId: codexTurn,
      });
      if (!interrupted.ok) throw new Error(`Codex didn't interrupt the turn: ${interrupted.failure.message}`);
    },

    restart: () => endSession((process) => process.kill()),

    close: () => endSession((process) => process.stop()),
  };
};
