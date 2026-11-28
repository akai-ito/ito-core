import { closeSync, constants, copyFileSync, lstatSync, mkdirSync, openSync, readSync, statSync } from "node:fs";
import path from "node:path";
import { isFullAccess } from "#access/access.ts";
import { createAsyncQueue, type AsyncQueue } from "#async-queue.ts";
import { createCell } from "#cell.ts";
import type { ThreadId, TurnId } from "#conversation/ids.ts";
import type { ServerNotification } from "#engine/codex/bindings/ServerNotification.ts";
import type { JsonValue } from "#engine/codex/bindings/serde_json/JsonValue.ts";
import type { Account } from "#engine/codex/bindings/v2/Account.ts";
import type { Model } from "#engine/codex/bindings/v2/Model.ts";
import type { RateLimitSnapshot } from "#engine/codex/bindings/v2/RateLimitSnapshot.ts";
import type { RateLimitWindow } from "#engine/codex/bindings/v2/RateLimitWindow.ts";
import type { SandboxPolicy } from "#engine/codex/bindings/v2/SandboxPolicy.ts";
import type { ThreadStartParams } from "#engine/codex/bindings/v2/ThreadStartParams.ts";
import type { ThreadStartResponse } from "#engine/codex/bindings/v2/ThreadStartResponse.ts";
import type { UserInput } from "#engine/codex/bindings/v2/UserInput.ts";
import { startCodexProcess, type CodexProcess } from "#engine/codex/codex-process.ts";
import { declined, toApprovalFields, toElicitationResponse } from "#engine/codex/approvals.ts";
import type { McpServerElicitationRequestParams } from "#engine/codex/bindings/v2/McpServerElicitationRequestParams.ts";
import type { McpServerElicitationRequestResponse } from "#engine/codex/bindings/v2/McpServerElicitationRequestResponse.ts";
import { initialTurnState, toEngineEvents, toFailure, type TurnState } from "#engine/codex/mapping.ts";
import {
  accountSetting,
  effortSetting,
  modelSetting,
  readChoice,
  restartedDetail,
  type Engine,
  type EngineEvent,
  type EngineFailureCode,
  type Input,
  type InputAttachment,
  type ToolServer,
  type WorkFailure,
} from "#engine/engine.ts";
import type { ModelOption } from "#protocol/types.ts";
import { fail, ok, type Result } from "#result.ts";
import type { Settings } from "#store/store.ts";
import { serverUrlVariable, toolServerName, toolsTokenVariable } from "#tools/mcp.ts";
import type { Info, Log } from "#turns/turns.ts";

export type CodexEngineOptions = {
  readonly codexHome: string;
  readonly workspace: string;
  readonly instructions: () => string;
  // What a turn has in mind: the main chat's, or a side thread's with its digest.
  readonly context?: (thread?: ThreadId) => string;
  readonly settings: Settings;
  readonly log: Log;
  readonly info: Info;
  readonly tools?: () => ToolServer | undefined;
  readonly modelProvider?: string;
  readonly config?: Readonly<Record<string, JsonValue>>;
};

type Session = { readonly process: CodexProcess };

type SessionModel = Pick<ThreadStartResponse, "model" | "reasoningEffort">;

type SessionFailure = { readonly code: EngineFailureCode; readonly detail: string };

type Opening = Promise<Result<Session, SessionFailure>>;

// Codex's thread and turn for one of ours, once it has started.
type CodexTurn = { readonly threadId: string; readonly turnId: string };

// Each conversation (the main chat, or a side thread) has its own Codex thread, and at most one turn at a time; turns
// in different conversations run side by side in the one Codex process.
type ActiveTurn = {
  readonly id: TurnId;
  readonly conversation: string;
  readonly queue: AsyncQueue<EngineEvent>;
  readonly codexTurn: Promise<CodexTurn | undefined>;
  readonly hasStarted: boolean;
  readonly state: TurnState;
};

type Scope = Readonly<Partial<Record<"threadId" | "turnId", unknown>>>;

type Approval = { readonly turn: TurnId; readonly respond: (isAllowed: boolean) => void };

type SideJob = {
  readonly answer: string;
  readonly finish: (answer: Result<string, WorkFailure>) => void;
  readonly onActivity?: () => void;
};

// The usage windows the provider last reported, kept across its sparse updates.
type UsageWindows = { readonly primary?: RateLimitWindow; readonly secondary?: RateLimitWindow };

export const threadSetting = "codex_thread_id";

const mainConversation = "";

const conversationOf = (thread: ThreadId | undefined): string => thread ?? mainConversation;

// Where each conversation's Codex thread is kept, so it resumes after a restart.
export const threadSettingFor = (thread: ThreadId | undefined): string =>
  thread === undefined ? threadSetting : `${threadSetting}:${thread}`;

const terminalTypes: ReadonlySet<EngineEvent["type"]> = new Set(["ended", "failed", "stopped"]);

const signedOut: SessionFailure = { code: "engine_signed_out", detail: "Codex has no account signed in." };

const engineFailed = (detail: string): WorkFailure => ({ code: "engine_failed", detail });

const withUpdate = (windows: UsageWindows, { primary, secondary }: RateLimitSnapshot): UsageWindows => ({
  ...windows,
  ...(primary && { primary }),
  ...(secondary && { secondary }),
});

// A usage limit is reached in a window that's used up; it resets when the last such window does.
const resetOf = ({ primary, secondary }: UsageWindows): number | undefined => {
  const resets = [primary, secondary]
    .filter(
      (window): window is RateLimitWindow & { readonly resetsAt: number } =>
        window !== undefined && window.usedPercent >= 100 && window.resetsAt !== null,
    )
    .map(({ resetsAt }) => resetsAt * 1000);
  return resets.length > 0 ? Math.max(...resets) : undefined;
};
const toAccount = (account: Account): Readonly<Record<string, string>> => {
  switch (account.type) {
    case "chatgpt": {
      const domain = account.email?.split("@").at(-1);
      return { kind: "chatgpt", plan: account.planType, ...(domain && { email_domain: domain }) };
    }
    case "apiKey": {
      return { kind: "api_key" };
    }
    case "amazonBedrock":
    case "gcp": {
      return { kind: "other" };
    }
  }
};

const uploadsFolder = "uploads";
const maxNameBytes = 200;
const maxExtensionBytes = 16;

type Placed = InputAttachment & { readonly path: string; readonly relative?: string };

const chunkBytes = 64 * 1024;

// Whether two files hold the same bytes, read a chunk at a time, so a large file never sits in memory whole.
const isSameContent = (source: string, target: string): boolean => {
  const left = openSync(source, "r");
  const right = openSync(target, "r");
  try {
    const leftChunk = Buffer.alloc(chunkBytes);
    const rightChunk = Buffer.alloc(chunkBytes);
    const compareFrom = (offset: number): boolean => {
      const read = readSync(left, leftChunk, 0, chunkBytes, offset);
      if (read === 0) return true;
      if (readSync(right, rightChunk, 0, chunkBytes, offset) !== read) return false;
      return leftChunk.subarray(0, read).equals(rightChunk.subarray(0, read)) && compareFrom(offset + read);
    };
    return compareFrom(0);
  } finally {
    closeSync(left);
    closeSync(right);
  }
};

const isSameFile = (source: string, target: string): boolean => {
  const found = lstatSync(target, { throwIfNoEntry: false });
  return found?.isFile() === true && found.size === statSync(source).size && isSameContent(source, target);
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
    // A copy-on-write clone where the disk can make one, so a large file costs nothing; a plain copy elsewhere. Never
    // a link: Kumo may change its copy, and the attachment must stay as it was sent.
    if (!isThere) {
      copyFileSync(attachment.source, path.join(folder, name), constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
    }
    return { ...attachment, path: path.join(folder, name), relative: `${uploadsFolder}/${name}` };
  } catch (error) {
    log(`Couldn't save ${attachment.name} in the workspace, so the agent is told it's missing`, error);
    return { ...attachment, path: attachment.source };
  }
};

const toUserInputs = (workspace: string, { text, attachments = [] }: Input, log: Log): readonly UserInput[] => {
  const recordings = attachments.filter(({ kind }) => kind === "audio").map(({ name }) => safeName(name));
  const placed = attachments
    .filter(({ kind }) => kind !== "audio")
    .map((attachment) => place(path.join(workspace, uploadsFolder), attachment, log));
  const saved = placed.flatMap((attachment) => attachment.relative ?? []);
  const unsaved = placed.filter((attachment) => attachment.relative === undefined).map(({ name }) => name);
  const notes = [
    saved.length > 0 && `(Attached, and saved in your workspace: ${saved.join(", ")})`,
    unsaved.length > 0 && `(Attached, but it couldn't be saved in your workspace: ${unsaved.join(", ")})`,
    recordings.length > 0 &&
      `(Recordings attached, kept on Ito rather than in your workspace: ${recordings.join(", ")}. Ito transcribes ` +
        "each one: read what was said with read_recording, which lists them when given no attachment.)",
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
            required: true,
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

const delegatingEffort = "ultra";

const appApprovalsOnly: ThreadStartParams["approvalPolicy"] = {
  granular: {
    sandbox_approval: false,
    rules: false,
    skill_approval: false,
    request_permissions: false,
    mcp_elicitations: true,
  },
};

// Kumo's sandbox: its workspace to write in, the network, and the rest of the machine to read. Full access, which
// they turn on in Settings, runs it with none.
const workspaceSandbox: SandboxPolicy = {
  type: "workspaceWrite",
  writableRoots: [],
  networkAccess: true,
  excludeTmpdirEnvVar: false,
  excludeSlashTmp: false,
};

const fullAccess: SandboxPolicy = { type: "dangerFullAccess" };

const toModelOption = (model: Model): ModelOption => ({
  id: model.model,
  title: model.displayName,
  summary: model.description,
  efforts: model.supportedReasoningEfforts
    .filter(({ reasoningEffort }) => reasoningEffort !== delegatingEffort)
    .map(({ reasoningEffort, description }) => ({ id: reasoningEffort, summary: description })),
  default_effort: model.defaultReasoningEffort,
  is_default: model.isDefault,
  images: model.inputModalities.includes("image"),
});

export const createCodexEngine = ({
  codexHome,
  workspace,
  instructions,
  context,
  settings,
  log,
  info,
  tools,
  modelProvider,
  config,
}: CodexEngineOptions): Engine => {
  const actives = createCell<ReadonlyMap<string, ActiveTurn>>(new Map());
  const session = createCell<Opening | undefined>(undefined);
  const generation = createCell(0);
  // Each conversation's Codex thread in this session, and those being opened.
  const codexThreads = createCell<ReadonlyMap<string, string>>(new Map());
  const openingThreads = createCell<ReadonlyMap<string, Promise<Result<string, string>>>>(new Map());
  const isRefreshing = createCell(false);
  // Conversations let go of while others ran, whose Codex turn may not have stopped: the next turn there restarts
  // Codex if nothing else runs by then.
  const wedged = createCell<ReadonlySet<string>>(new Set());
  const injected = createCell<ReadonlyMap<string, string>>(new Map());
  const approvals = createCell<ReadonlyMap<string, Approval>>(new Map());
  const approvalCount = createCell(0);
  const sideJobs = createCell<ReadonlyMap<string, SideJob>>(new Map());
  const usage = createCell<UsageWindows>({});
  const activeOf = (turn: TurnId): ActiveTurn | undefined =>
    actives
      .get()
      .values()
      .find(({ id }) => id === turn);

  const setActive = (turn: ActiveTurn): void => {
    actives.update((current) => new Map([...current, [turn.conversation, turn]]));
  };

  const dropActive = (conversation: string): void => {
    actives.update((current) => new Map([...current].filter(([key]) => key !== conversation)));
  };

  const isOtherActive = (conversation: string): boolean =>
    actives
      .get()
      .keys()
      .some((key) => key !== conversation);

  const conversationOfThread = (threadId: string | undefined): string | undefined =>
    threadId === undefined ? undefined : [...codexThreads.get()].find(([, id]) => id === threadId)?.[0];

  const isFull = (): boolean => isFullAccess(settings.setting);

  // A conversation's thread or a piece of work starts in the sandbox that access calls for now.
  const threadOptions = (server: ToolServer | undefined): ThreadStartParams => ({
    cwd: workspace,
    approvalPolicy: appApprovalsOnly,
    sandbox: isFull() ? "danger-full-access" : "workspace-write",
    baseInstructions: instructions(),
    config: {
      sandbox_workspace_write: { network_access: true },
      web_search: "live",
      agents: { enabled: false },
      skills: { include_instructions: false },
      features: { tool_call_mcp_elicitation: true },
      apps: { _default: { default_tools_approval_mode: "writes" } },
      ...toolsConfig(server),
      ...config,
    },
    ...(modelProvider && { modelProvider }),
  });

  const sideThreadOptions = (): ThreadStartParams => ({
    cwd: workspace,
    approvalPolicy: "never",
    sandbox: "read-only",
    baseInstructions: instructions(),
    ephemeral: true,
    config: { web_search: "disabled", agents: { enabled: false }, ...config },
    ...(modelProvider && { modelProvider }),
  });

  const failSideJobs = (detail: string): void => {
    for (const job of sideJobs.get().values()) job.finish(fail(engineFailed(detail)));
  };

  // Every notification on a side thread is a sign of life; Codex sends none while a tool call's arguments stream.
  const routeSideJob = (threadId: string, job: SideJob, notification: ServerNotification): void => {
    job.onActivity?.();
    if (notification.method === "item/completed" && notification.params.item.type === "agentMessage") {
      const { text } = notification.params.item;
      sideJobs.update((jobs) => new Map([...jobs, [threadId, { ...job, answer: text }]]));
    }
    if (notification.method !== "turn/completed") return;
    const { status, error } = notification.params.turn;
    if (status === "completed") {
      job.finish(ok(job.answer));
      return;
    }
    const failed = toFailure(error);
    job.finish(
      fail(
        error && failed.type === "failed"
          ? { code: failed.code, detail: failed.detail }
          : engineFailed(`Codex's turn ${status}.`),
      ),
    );
  };

  // Side jobs share one finish: off the list, and answered.
  const addSideJob = (threadId: string, onActivity?: () => void): Promise<Result<string, WorkFailure>> =>
    new Promise((resolve) => {
      const finish = (answer: Result<string, WorkFailure>): void => {
        sideJobs.update((jobs) => new Map([...jobs].filter(([id]) => id !== threadId)));
        resolve(answer);
      };
      sideJobs.update(
        (jobs) => new Map([...jobs, [threadId, { answer: "", finish, ...(onActivity && { onActivity }) }]]),
      );
    });

  const emit = (turn: TurnId, events: readonly EngineEvent[]): void => {
    for (const event of events) {
      const current = activeOf(turn);
      if (!current) return;
      current.queue.push(event);
      if (!terminalTypes.has(event.type)) continue;
      current.queue.end();
      dropActive(current.conversation);
    }
  };

  const route = (notification: ServerNotification): void => {
    if (notification.method === "account/rateLimits/updated") {
      usage.update((windows) => withUpdate(windows, notification.params.rateLimits));
      return;
    }
    const threadId = fieldOf(notification, "threadId");
    const sideJob = threadId === undefined ? undefined : sideJobs.get().get(threadId);
    if (threadId !== undefined && sideJob) {
      routeSideJob(threadId, sideJob, notification);
      return;
    }
    const conversation = conversationOfThread(threadId);
    if (conversation === undefined) return;
    if (notification.method === "item/completed" && notification.params.item.type === "contextCompaction") {
      injected.update((current) => new Map([...current].filter(([key]) => key !== conversation)));
    }
    const current = actives.get().get(conversation);
    if (!current) return;
    const { state, events } = toEngineEvents(current.state, notification);
    const isTurnScoped = fieldOf(notification, "turnId") !== undefined;
    setActive({ ...current, state, hasStarted: current.hasStarted || notification.method === "turn/started" });
    emit(current.id, isTurnScoped && events.length === 0 ? [{ type: "progress" }] : events);
  };

  const announce = (message: string, { model, reasoningEffort }: SessionModel): void => {
    settings.setSetting(modelSetting, model);
    if (reasoningEffort) settings.setSetting(effortSetting, reasoningEffort);
    info(message, { model, reasoningEffort });
  };

  // A side thread's tool calls carry its id, so they act in its conversation.
  const serverFor = (thread: ThreadId | undefined): ToolServer | undefined => {
    const server = tools?.();
    return server && thread !== undefined ? { ...server, url: `${server.url}/thread/${thread}` } : server;
  };

  const openThread = async (process: CodexProcess, thread: ThreadId | undefined): Promise<Result<string, string>> => {
    const setting = threadSettingFor(thread);
    const options = threadOptions(serverFor(thread));
    const stored = settings.setting(setting);
    if (stored) {
      const resumed = await process.call("thread/resume", { ...options, threadId: stored });
      if (resumed.ok) {
        announce("Codex resumed the conversation's session", resumed.value);
        return ok(resumed.value.thread.id);
      }
      log("Codex couldn't resume the conversation's session, so it starts a new one", resumed.failure.message);
    }
    const started = await process.call("thread/start", options);
    if (!started.ok) return fail(`Codex couldn't start a thread: ${started.failure.message}`);
    settings.setSetting(setting, started.value.thread.id);
    announce("Codex started a session for the conversation", started.value);
    return ok(started.value.thread.id);
  };

  const ensureThread = async (process: CodexProcess, thread: ThreadId | undefined): Promise<Result<string, string>> => {
    const conversation = conversationOf(thread);
    const known = codexThreads.get().get(conversation);
    if (known !== undefined) return ok(known);
    const pending = openingThreads.get().get(conversation);
    if (pending) return pending;
    const opened = generation.get();
    const opening = openThread(process, thread);
    openingThreads.update((current) => new Map([...current, [conversation, opening]]));
    const threadId = await opening;
    if (generation.get() !== opened) return fail(restartedDetail);
    openingThreads.update((current) => new Map([...current].filter(([key]) => key !== conversation)));
    if (threadId.ok) codexThreads.update((current) => new Map([...current, [conversation, threadId.value]]));
    return threadId;
  };

  const openSession = async (): Opening => {
    const opened = generation.get();
    const isCurrent = (): boolean => generation.get() === opened;
    const isGivenUp = createCell(false);
    const server = tools?.();
    const started = await startCodexProcess({
      codexHome,
      workspace,
      environment: server ? { [toolsTokenVariable]: server.token, [serverUrlVariable]: server.origin } : {},
      onNotification: (notification) => {
        if (isCurrent()) route(notification);
      },
      onElicitation: (parameters) => (isCurrent() ? onElicitation(parameters) : Promise.resolve(declined)),
      onExit: (description) => {
        if (!isCurrent() || isGivenUp.get()) return;
        session.set(undefined);
        codexThreads.set(new Map());
        openingThreads.set(new Map());
        failSideJobs(description);
        for (const current of actives.get().values()) {
          emit(current.id, [{ type: "failed", code: "engine_failed", detail: description }]);
        }
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
    injected.set(new Map());
    return ok({ process });
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
    failSideJobs(restartedDetail);
    const opening = session.get();
    session.set(undefined);
    codexThreads.set(new Map());
    openingThreads.set(new Map());
    wedged.set(new Set());
    return opening;
  };

  const beginTurn = async (
    turn: TurnId,
    thread: ThreadId | undefined,
    inputs: readonly Input[],
    stale: Opening | undefined,
    isBusy: boolean,
  ): Promise<CodexTurn | undefined> => {
    await shutDown(stale, (process) => (isBusy ? process.kill() : process.stop()));
    const opened = await ensureSession();
    if (!opened.ok) {
      emit(turn, [{ type: "failed", ...opened.failure }]);
      return undefined;
    }
    const { process } = opened.value;
    const threadId = await ensureThread(process, thread);
    if (!threadId.ok) {
      emit(turn, [{ type: "failed", code: "engine_failed", detail: threadId.failure }]);
      return undefined;
    }
    const conversation = conversationOf(thread);
    const inMind = context?.(thread) ?? "";
    if (inMind !== "" && inMind !== injected.get().get(conversation)) {
      const injecting = await process.call("thread/inject_items", {
        threadId: threadId.value,
        items: [{ type: "message", role: "developer", content: [{ type: "input_text", text: inMind }] }],
      });
      if (injecting.ok) injected.update((current) => new Map([...current, [conversation, inMind]]));
      else log("Codex didn't take what's in Ari's mind", injecting.failure.message);
    }
    // Every turn says its sandbox, since a conversation's thread lives on across a change of access: a change applies
    // from the next turn, and never to one already running.
    const started = await process.call("turn/start", {
      threadId: threadId.value,
      clientUserMessageId: inputs[0]?.messageId ?? null,
      input: inputs.flatMap((input) => toUserInputs(workspace, input, log)),
      summary: "auto",
      sandboxPolicy: isFull() ? fullAccess : workspaceSandbox,
      ...readChoice(settings.setting),
    });
    if (started.ok) return { threadId: threadId.value, turnId: started.value.turn.id };
    emit(turn, [{ type: "failed", code: "engine_failed", detail: started.failure.message }]);
    return undefined;
  };

  const declineWaiting = (turn?: TurnId): void => {
    const waiting = [...approvals.get()].filter(([, approval]) => turn === undefined || approval.turn === turn);
    approvals.update((current) => new Map([...current].filter(([key]) => waiting.every(([given]) => given !== key))));
    for (const [, approval] of waiting) approval.respond(false);
  };

  const onElicitation = (
    parameters: McpServerElicitationRequestParams,
  ): Promise<McpServerElicitationRequestResponse> => {
    info("Codex asks for approval", {
      server: parameters.serverName,
      mode: parameters.mode,
      message: parameters.message,
      meta: parameters._meta,
    });
    const conversation = conversationOfThread(parameters.threadId);
    const current = conversation === undefined ? undefined : actives.get().get(conversation);
    const fields = toApprovalFields(parameters);
    if (!current || !fields) return Promise.resolve(declined);
    approvalCount.set(approvalCount.get() + 1);
    const key = `approval-${String(approvalCount.get())}`;
    return new Promise((resolve) => {
      approvals.update(
        (waiting) =>
          new Map([
            ...waiting,
            [
              key,
              {
                turn: current.id,
                respond: (isAllowed: boolean) => {
                  resolve(toElicitationResponse(parameters, isAllowed));
                },
              },
            ],
          ]),
      );
      emit(current.id, [{ type: "approval", key, fields }]);
    });
  };

  // Lets go of a conversation's turn at once: no more of its events, and its approvals declined.
  const letGo = (conversation: string): ActiveTurn | undefined => {
    const current = actives.get().get(conversation);
    if (!current) return undefined;
    dropActive(conversation);
    declineWaiting(current.id);
    current.queue.end();
    return current;
  };

  const letGoOfAll = (): void => {
    for (const conversation of actives.get().keys()) letGo(conversation);
    declineWaiting();
  };

  // Asks Codex to stop a turn we let go of, as best it can.
  const stopQuietly = (left: ActiveTurn): void => {
    void (async () => {
      const codexTurn = await left.codexTurn;
      const opened = await session.get();
      if (!codexTurn || !opened?.ok) return;
      const stopped = await opened.value.process.call("turn/interrupt", codexTurn);
      if (!stopped.ok) log("Codex didn't stop a turn it was let go of", stopped.failure.message);
    })();
  };

  return {
    start: (turn, inputs, thread) => {
      const conversation = conversationOf(thread);
      const queue = createAsyncQueue<EngineEvent>();
      const isStuck = actives.get().has(conversation) || wedged.get().has(conversation);
      // Restarting Codex would cut off every other conversation's turn, so it waits until nothing else runs.
      const isRestarting = !isOtherActive(conversation) && (isStuck || isRefreshing.get());
      const stale = isRestarting ? detachSession() : undefined;
      if (isRestarting) isRefreshing.set(false);
      const left = letGo(conversation);
      if (left && !isRestarting) stopQuietly(left);
      setActive({
        id: turn,
        conversation,
        queue,
        codexTurn: beginTurn(turn, thread, inputs, stale, isRestarting && isStuck),
        hasStarted: false,
        state: initialTurnState,
      });
      return queue;
    },

    steer: async (turn, input) => {
      const current = activeOf(turn);
      if (!current || current.state.isCompacting) return "refused";
      const codexTurn = await current.codexTurn;
      const opened = await session.get();
      const latest = activeOf(turn);
      if (!latest || !codexTurn || !opened?.ok) return "refused";
      setActive({
        ...latest,
        state: { ...latest.state, steered: new Set([...latest.state.steered, input.messageId]) },
      });
      const steered = await opened.value.process.call("turn/steer", {
        threadId: codexTurn.threadId,
        expectedTurnId: codexTurn.turnId,
        clientUserMessageId: input.messageId,
        input: [...toUserInputs(workspace, input, log)],
      });
      if (steered.ok) return "taken";
      log("Codex didn't take a steer, so the message waits as Next", steered.failure.message);
      return "refused";
    },

    approve: (turn, key, isAllowed) => {
      const approval = approvals.get().get(key);
      if (approval?.turn !== turn) return;
      approvals.update((waiting) => new Map([...waiting].filter(([waitingKey]) => waitingKey !== key)));
      approval.respond(isAllowed);
    },

    work: async (prompt, run, { choice, onActivity, signal } = {}) => {
      const opened = await ensureSession();
      if (!opened.ok) return fail(opened.failure);
      const { process } = opened.value;
      const server = tools?.();
      const started = await process.call("thread/start", {
        ...threadOptions(server && { ...server, url: `${server.url}/work/${run}` }),
        approvalPolicy: "never",
        ephemeral: true,
      });
      if (!started.ok) return fail(engineFailed(`Codex couldn't start a work thread: ${started.failure.message}`));
      const threadId = started.value.thread.id;
      const finished = addSideJob(threadId, onActivity);
      const turn = await process.call("turn/start", {
        threadId,
        input: [{ type: "text", text: prompt, text_elements: [] }],
        ...(choice ?? readChoice(settings.setting)),
      });
      if (!turn.ok) {
        sideJobs
          .get()
          .get(threadId)
          ?.finish(fail(engineFailed(`Codex didn't start the work: ${turn.failure.message}`)));
        return finished;
      }
      const interrupt = (): void => {
        void process.call("turn/interrupt", { threadId, turnId: turn.value.turn.id });
      };
      if (signal?.aborted === true) interrupt();
      else signal?.addEventListener("abort", interrupt, { once: true });
      return finished;
    },

    usageResetsAt: () => resetOf(usage.get()),

    complete: async (prompt, schema, choice) => {
      const opened = await ensureSession();
      if (!opened.ok) return fail(opened.failure.detail);
      const { process } = opened.value;
      const started = await process.call("thread/start", sideThreadOptions());
      if (!started.ok) return fail(`Codex couldn't start a side thread: ${started.failure.message}`);
      const threadId = started.value.thread.id;
      const finished = addSideJob(threadId);
      const turn = await process.call("turn/start", {
        threadId,
        input: [{ type: "text", text: prompt, text_elements: [] }],
        outputSchema: schema as JsonValue,
        ...(choice ?? readChoice(settings.setting)),
      });
      if (!turn.ok)
        sideJobs
          .get()
          .get(threadId)
          ?.finish(fail(engineFailed(`Codex didn't start: ${turn.failure.message}`)));
      const answered = await finished;
      if (!answered.ok) return fail(answered.failure.detail);
      try {
        return ok(JSON.parse(answered.value) as unknown);
      } catch {
        return fail(`Codex didn't answer in JSON: ${answered.value}`);
      }
    },

    interrupt: async (turn) => {
      const current = activeOf(turn);
      if (!current) return;
      declineWaiting(turn);
      const codexTurn = await current.codexTurn;
      const opened = await session.get();
      if (!codexTurn || !opened?.ok) return;
      const hasStarted = activeOf(turn)?.hasStarted ?? true;
      const attempt = async ([turnId = "", ...rest]: readonly string[]): Promise<void> => {
        const interrupted = await opened.value.process.call("turn/interrupt", {
          threadId: codexTurn.threadId,
          turnId,
        });
        if (interrupted.ok) return;
        if (rest.length === 0) throw new Error(`Codex didn't interrupt the turn: ${interrupted.failure.message}`);
        await attempt(rest);
      };
      await attempt(hasStarted ? [codexTurn.turnId, ""] : ["", codexTurn.turnId]);
    },

    refresh: () => {
      isRefreshing.set(true);
      return Promise.resolve();
    },

    models: async () => {
      const opened = await ensureSession();
      if (!opened.ok) return fail(opened.failure.detail);
      const listPage = async (
        cursor: string | null,
        listed: readonly ModelOption[],
      ): Promise<Result<readonly ModelOption[], string>> => {
        const page = await opened.value.process.call("model/list", { cursor, includeHidden: false });
        if (!page.ok) return fail(`Codex couldn't list its models: ${page.failure.message}`);
        const all = [
          ...listed,
          ...page.value.data.filter(({ hidden }) => !hidden).map((model) => toModelOption(model)),
        ];
        return page.value.nextCursor ? listPage(page.value.nextCursor, all) : ok(all);
      };
      return listPage(null, []);
    },

    restart: async () => {
      letGoOfAll();
      await shutDown(detachSession(), (process) => process.kill());
    },

    // While other conversations run, a restart would cut them off: the conversation's turn is let go of at once,
    // Codex is asked to stop it, and the next turn there restarts Codex if it's still stuck and nothing else runs.
    reset: async (thread) => {
      const conversation = conversationOf(thread);
      if (!isOtherActive(conversation)) {
        letGoOfAll();
        await shutDown(detachSession(), (process) => process.kill());
        return;
      }
      const left = letGo(conversation);
      wedged.update((current) => new Set([...current, conversation]));
      if (left) stopQuietly(left);
    },

    close: async () => {
      letGoOfAll();
      await shutDown(detachSession(), (process) => process.stop());
    },
  };
};
