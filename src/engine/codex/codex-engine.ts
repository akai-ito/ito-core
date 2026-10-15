import { constants, copyFileSync, lstatSync, mkdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { createAsyncQueue, type AsyncQueue } from "#async-queue.ts";
import { createCell } from "#cell.ts";
import type { TurnId } from "#conversation/ids.ts";
import type { ServerNotification } from "#engine/codex/bindings/ServerNotification.ts";
import type { JsonValue } from "#engine/codex/bindings/serde_json/JsonValue.ts";
import type { Account } from "#engine/codex/bindings/v2/Account.ts";
import type { ThreadStartParams } from "#engine/codex/bindings/v2/ThreadStartParams.ts";
import type { ThreadStartResponse } from "#engine/codex/bindings/v2/ThreadStartResponse.ts";
import type { UserInput } from "#engine/codex/bindings/v2/UserInput.ts";
import { startCodexProcess, type CodexProcess } from "#engine/codex/codex-process.ts";
import { initialTurnState, toEngineEvents, type TurnState } from "#engine/codex/mapping.ts";
import {
  accountSetting,
  modelSetting,
  type Engine,
  type EngineEvent,
  type EngineFailureCode,
  type Input,
  type InputAttachment,
  type ToolServer,
} from "#engine/engine.ts";
import { fail, ok, type Result } from "#result.ts";
import type { Settings } from "#store/store.ts";
import { toolServerName } from "#tools/mcp.ts";
import type { Info, Log } from "#turns/turns.ts";

export type CodexEngineOptions = {
  readonly codexHome: string;
  readonly workspace: string;
  readonly instructions: string;
  readonly settings: Settings;
  readonly log: Log;
  readonly info: Info;
  readonly tools?: () => ToolServer | undefined;
  readonly modelProvider?: string;
  readonly config?: Readonly<Record<string, JsonValue>>;
};

type Session = { readonly process: CodexProcess; readonly threadId: string };

type SessionModel = Pick<ThreadStartResponse, "model" | "reasoningEffort">;

type SessionFailure = { readonly code: EngineFailureCode; readonly detail: string };

type Opening = Promise<Result<Session, SessionFailure>>;

type ActiveTurn = {
  readonly id: TurnId;
  readonly queue: AsyncQueue<EngineEvent>;
  readonly codexTurn: Promise<string | undefined>;
  readonly hasStarted: boolean;
  readonly state: TurnState;
};

type Scope = Readonly<Partial<Record<"threadId" | "turnId", unknown>>>;

export const threadSetting = "codex_thread_id";

const toolsTokenVariable = "ITO_TOOLS_TOKEN";

const terminalTypes: ReadonlySet<EngineEvent["type"]> = new Set(["ended", "failed", "stopped"]);

const signedOut: SessionFailure = { code: "engine_signed_out", detail: "Codex has no account signed in." };

const toAccount = (account: Account): Readonly<Record<string, string>> => {
  switch (account.type) {
    case "chatgpt": {
      const domain = account.email?.split("@").at(-1);
      return { kind: "chatgpt", plan: account.planType, ...(domain && { email_domain: domain }) };
    }
    case "apiKey": {
      return { kind: "api_key" };
    }
    case "amazonBedrock": {
      return { kind: "other" };
    }
  }
};

const uploadsFolder = "uploads";
const maxNameBytes = 200;
const maxExtensionBytes = 16;

type Placed = InputAttachment & { readonly path: string; readonly relative?: string };

const isSameFile = (source: string, target: string): boolean => {
  const found = lstatSync(target, { throwIfNoEntry: false });
  return (
    found?.isFile() === true &&
    found.size === statSync(source).size &&
    readFileSync(source).equals(readFileSync(target))
  );
};

const placeName = (
  folder: string,
  source: string,
  name: string,
  attempt = 1,
): { readonly name: string; readonly isThere: boolean } => {
  const extension = path.extname(name);
  const candidate = attempt === 1 ? name : `${path.basename(name, extension)}-${String(attempt)}${extension}`;
  const target = path.join(folder, candidate);
  if (!lstatSync(target, { throwIfNoEntry: false })) return { name: candidate, isThere: false };
  return isSameFile(source, target) ? { name: candidate, isThere: true } : placeName(folder, source, name, attempt + 1);
};

const fitName = (name: string): string => {
  if (Buffer.byteLength(name) <= maxNameBytes) return name;
  const extension = path.extname(name);
  const ending = Buffer.byteLength(extension) <= maxExtensionBytes ? extension : "";
  const graphemes = [...new Intl.Segmenter().segment(name.slice(0, name.length - ending.length))].map(
    ({ segment }) => segment,
  );
  const totals = graphemes.reduce<readonly number[]>(
    (sums, grapheme) => [...sums, (sums.at(-1) ?? 0) + Buffer.byteLength(grapheme)],
    [],
  );
  const fitting = totals.findIndex((total) => total > maxNameBytes - Buffer.byteLength(ending));
  return `${graphemes.slice(0, fitting).join("")}${ending}`;
};

const safeName = (name: string): string => {
  const printable = path
    .basename(name)
    .split(/(?=[\s\S])/u)
    .filter((character) => character >= " ")
    .join("")
    .trim();
  return printable === "" ? "file" : fitName(printable);
};

const place = (folder: string, attachment: InputAttachment, log: Log): Placed => {
  try {
    mkdirSync(folder, { recursive: true });
    if (!lstatSync(folder).isDirectory()) throw new Error(`${folder} isn't a folder`);
    const { name, isThere } = placeName(folder, attachment.source, safeName(attachment.name));
    if (!isThere) copyFileSync(attachment.source, path.join(folder, name), constants.COPYFILE_EXCL);
    return { ...attachment, path: path.join(folder, name), relative: `${uploadsFolder}/${name}` };
  } catch (error) {
    log(`Couldn't save ${attachment.name} in the workspace, so the agent is told it's missing`, error);
    return { ...attachment, path: attachment.source };
  }
};

const toUserInputs = (workspace: string, { text, attachments = [] }: Input, log: Log): readonly UserInput[] => {
  const placed = attachments.map((attachment) => place(path.join(workspace, uploadsFolder), attachment, log));
  const saved = placed.flatMap((attachment) => attachment.relative ?? []);
  const unsaved = placed.filter((attachment) => attachment.relative === undefined).map(({ name }) => name);
  const notes = [
    saved.length > 0 && `(Attached, and saved in your workspace: ${saved.join(", ")})`,
    unsaved.length > 0 && `(Attached, but it couldn't be saved in your workspace: ${unsaved.join(", ")})`,
  ];
  return [
    { type: "text", text: [text, ...notes].filter(Boolean).join("\n\n"), text_elements: [] },
    ...placed
      .filter((attachment) => attachment.kind === "image")
      .map((attachment): UserInput => ({ type: "localImage", path: attachment.path })),
  ];
};

const toolsConfig = (server: ToolServer | undefined): Readonly<Record<string, JsonValue>> =>
  server
    ? {
        mcp_servers: {
          [toolServerName]: {
            url: server.url,
            bearer_token_env_var: toolsTokenVariable,
            default_tools_approval_mode: "approve",
            omit_tools_from: ["deferred"],
          },
        },
      }
    : {};

const fieldOf = (notification: ServerNotification, field: keyof Scope): string | undefined => {
  const value = (notification.params as Scope | null)?.[field];
  return typeof value === "string" ? value : undefined;
};

const shutDown = async (opening: Opening | undefined, how: (process: CodexProcess) => Promise<void>): Promise<void> => {
  const opened = await opening;
  if (opened?.ok) await how(opened.value.process);
};

export const createCodexEngine = ({
  codexHome,
  workspace,
  instructions,
  settings,
  log,
  info,
  tools,
  modelProvider,
  config,
}: CodexEngineOptions): Engine => {
  const active = createCell<ActiveTurn | undefined>(undefined);
  const session = createCell<Opening | undefined>(undefined);
  const generation = createCell(0);
  const openThreadId = createCell<string | undefined>(undefined);
  const threadOptions = (server: ToolServer | undefined): ThreadStartParams => ({
    cwd: workspace,
    approvalPolicy: "never",
    sandbox: "workspace-write",
    baseInstructions: instructions,
    config: {
      sandbox_workspace_write: { network_access: true },
      web_search: "live",
      agents: { enabled: false },
      skills: { include_instructions: false },
      ...toolsConfig(server),
      ...config,
    },
    ...(modelProvider && { modelProvider }),
  });

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

  const route = (notification: ServerNotification): void => {
    const current = active.get();
    if (!current || fieldOf(notification, "threadId") !== openThreadId.get()) return;
    const { state, events } = toEngineEvents(current.state, notification);
    const isTurnScoped = fieldOf(notification, "turnId") !== undefined;
    active.set({ ...current, state, hasStarted: current.hasStarted || notification.method === "turn/started" });
    emit(current.id, isTurnScoped && events.length === 0 ? [{ type: "progress" }] : events);
  };

  const announce = (message: string, { model, reasoningEffort }: SessionModel): void => {
    settings.setSetting(modelSetting, model);
    info(message, { model, reasoningEffort });
  };

  const openThread = async (process: CodexProcess, server: ToolServer | undefined): Promise<Result<string, string>> => {
    const stored = settings.setting(threadSetting);
    if (stored) {
      const resumed = await process.call("thread/resume", { ...threadOptions(server), threadId: stored });
      if (resumed.ok) {
        announce("Codex resumed the conversation's session", resumed.value);
        return ok(resumed.value.thread.id);
      }
      log("Codex couldn't resume the conversation's session, so it starts a new one", resumed.failure.message);
    }
    const started = await process.call("thread/start", threadOptions(server));
    if (!started.ok) return fail(`Codex couldn't start a thread: ${started.failure.message}`);
    settings.setSetting(threadSetting, started.value.thread.id);
    announce("Codex started a session for the conversation", started.value);
    return ok(started.value.thread.id);
  };

  const openSession = async (): Opening => {
    const opened = generation.get();
    const isCurrent = (): boolean => generation.get() === opened;
    const isGivenUp = createCell(false);
    const server = tools?.();
    const started = await startCodexProcess({
      codexHome,
      workspace,
      environment: server ? { [toolsTokenVariable]: server.token } : {},
      onNotification: (notification) => {
        if (isCurrent()) route(notification);
      },
      onExit: (description) => {
        if (!isCurrent() || isGivenUp.get()) return;
        session.set(undefined);
        const current = active.get();
        if (current) emit(current.id, [{ type: "failed", code: "engine_failed", detail: description }]);
      },
    });
    if (!started.ok) return fail({ code: "engine_failed", detail: started.failure });
    const process = started.value;
    const giveUp = async (failure: SessionFailure): Opening => {
      isGivenUp.set(true);
      await process.stop();
      return fail(failure);
    };
    const account = await process.call("account/read", { refreshToken: false });
    if (account.ok && account.value.account) {
      settings.setSetting(accountSetting, JSON.stringify(toAccount(account.value.account)));
    }
    if (account.ok && account.value.account === null && account.value.requiresOpenaiAuth) return giveUp(signedOut);
    const threadId = await openThread(process, server);
    if (!threadId.ok) return giveUp({ code: "engine_failed", detail: threadId.failure });
    openThreadId.set(threadId.value);
    return ok({ process, threadId: threadId.value });
  };

  const ensureSession = async (): Opening => {
    const existing = session.get();
    if (existing) return existing;
    const opening = openSession();
    session.set(opening);
    const opened = await opening;
    if (!opened.ok && session.get() === opening) session.set(undefined);
    return opened;
  };

  const detachSession = (): Opening | undefined => {
    generation.update((count) => count + 1);
    const opening = session.get();
    session.set(undefined);
    openThreadId.set(undefined);
    return opening;
  };

  const beginTurn = async (
    turn: TurnId,
    inputs: readonly Input[],
    stale: Opening | undefined,
  ): Promise<string | undefined> => {
    await shutDown(stale, (process) => process.kill());
    const opened = await ensureSession();
    if (!opened.ok) {
      emit(turn, [{ type: "failed", ...opened.failure }]);
      return undefined;
    }
    const started = await opened.value.process.call("turn/start", {
      threadId: opened.value.threadId,
      clientUserMessageId: inputs[0]?.messageId ?? null,
      input: inputs.flatMap((input) => toUserInputs(workspace, input, log)),
      summary: "auto",
    });
    if (started.ok) return started.value.turn.id;
    emit(turn, [{ type: "failed", code: "engine_failed", detail: started.failure.message }]);
    return undefined;
  };

  const endActiveTurn = (): void => {
    const current = active.get();
    active.set(undefined);
    current?.queue.end();
  };

  return {
    start: (turn, inputs) => {
      const queue = createAsyncQueue<EngineEvent>();
      const isCodexStillBusy = active.get() !== undefined;
      const stale = isCodexStillBusy ? detachSession() : undefined;
      endActiveTurn();
      active.set({
        id: turn,
        queue,
        codexTurn: beginTurn(turn, inputs, stale),
        hasStarted: false,
        state: initialTurnState,
      });
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
        input: [...toUserInputs(workspace, input, log)],
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
      const hasStarted = active.get()?.hasStarted ?? true;
      const attempt = async ([turnId = "", ...rest]: readonly string[]): Promise<void> => {
        const interrupted = await opened.value.process.call("turn/interrupt", {
          threadId: opened.value.threadId,
          turnId,
        });
        if (interrupted.ok) return;
        if (rest.length === 0) throw new Error(`Codex didn't interrupt the turn: ${interrupted.failure.message}`);
        await attempt(rest);
      };
      await attempt(hasStarted ? [codexTurn, ""] : ["", codexTurn]);
    },

    restart: async () => {
      endActiveTurn();
      await shutDown(detachSession(), (process) => process.kill());
    },

    close: async () => {
      endActiveTurn();
      await shutDown(detachSession(), (process) => process.stop());
    },
  };
};
