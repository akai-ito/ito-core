import type { ServerNotification } from "#engine/codex/bindings/ServerNotification.ts";
import type { CodexErrorInfo } from "#engine/codex/bindings/v2/CodexErrorInfo.ts";
import type { CommandAction } from "#engine/codex/bindings/v2/CommandAction.ts";
import type { FileUpdateChange } from "#engine/codex/bindings/v2/FileUpdateChange.ts";
import type { McpToolCallResult } from "#engine/codex/bindings/v2/McpToolCallResult.ts";
import type { TurnPlanStep } from "#engine/codex/bindings/v2/TurnPlanStep.ts";
import type { ThreadItem } from "#engine/codex/bindings/v2/ThreadItem.ts";
import type { TurnError } from "#engine/codex/bindings/v2/TurnError.ts";
import type { EngineEvent, EngineFailureCode, StepFacts } from "#engine/engine.ts";
import { toMessageId } from "#conversation/ids.ts";
import { askToolName } from "#asks/tool.ts";
import { memoryToolNames } from "#memory/tool-names.ts";
import { imageToolName } from "#replies/images.ts";
import { toolServerName } from "#tools/mcp.ts";
import { fieldOf } from "#tools/input.ts";

export type TurnState = {
  readonly openMessage: string | undefined;
  readonly steered: ReadonlySet<string>;
  readonly isCompacting: boolean;
  readonly summary: string;
  readonly hasPlan: boolean;
};

export type Mapped = { readonly state: TurnState; readonly events: readonly EngineEvent[] };

export const initialTurnState: TurnState = {
  openMessage: undefined,
  steered: new Set(),
  isCompacting: false,
  summary: "",
  hasPlan: false,
};

const unavailableErrors = new Set([
  "other",
  "serverOverloaded",
  "internalServerError",
  "flexUnavailable",
  "rateLimitExceeded",
  "httpConnectionFailed",
  "responseStreamConnectionFailed",
  "responseStreamDisconnected",
  "responseTooManyFailedAttempts",
]);

const refusalErrors = new Set(["cyberPolicy", "misalignmentPolicyViolation"]);

const errorName = (info: CodexErrorInfo | null): string =>
  typeof info === "string" ? info : info ? (Object.keys(info)[0] ?? "other") : "other";

const httpStatusOf = (info: CodexErrorInfo | null): number | undefined => {
  const [detail]: readonly unknown[] = info && typeof info === "object" ? Object.values(info) : [];
  const status: unknown = detail && typeof detail === "object" ? Reflect.get(detail, "httpStatusCode") : undefined;
  return typeof status === "number" ? status : undefined;
};

export const toFailureCode = (info: CodexErrorInfo | null): EngineFailureCode => {
  const name = errorName(info);
  if (name === "unauthorized" || httpStatusOf(info) === 401) return "engine_signed_out";
  if (name === "usageLimitExceeded") return "usage_limit";
  if (name === "contextWindowExceeded") return "context_full";
  if (refusalErrors.has(name)) return "refused";
  return unavailableErrors.has(name) ? "model_unavailable" : "engine_failed";
};

export const toFailure = (error: TurnError | null): EngineEvent => ({
  type: "failed",
  code: toFailureCode(error?.codexErrorInfo ?? null),
  detail: error ? [error.message, error.additionalDetails].filter(Boolean).join(" ") : "Codex failed the turn.",
});

type StepKind = Extract<EngineEvent, { readonly type: "step.started" }>["kind"];

const planKey = "plan";
const outputLimit = 2048;
const shellWrapper = /^(?:\/usr)?\/bin\/(?:bash|zsh|sh) -lc (["'])(?<inner>[\s\S]*)\1$/u;

const started = (key: string, kind: StepKind, facts: StepFacts): EngineEvent => ({
  type: "step.started",
  key,
  kind,
  facts,
});

const ended = (key: string, isCompleted: boolean, facts: StepFacts = {}): EngineEvent => ({
  type: "step.ended",
  key,
  outcome: isCompleted ? "completed" : "failed",
  facts,
});

const resultText = (result: McpToolCallResult | null): string =>
  (result?.content ?? [])
    .map((part) => fieldOf(part, "text"))
    .filter((text) => typeof text === "string")
    .join("\n");

const resultUrl = (result: McpToolCallResult | null): unknown => {
  const url = fieldOf(result?.structuredContent, "url");
  return typeof url === "string" ? url : undefined;
};

const emptyValues: ReadonlySet<unknown> = new Set([undefined, null, ""]);

const withoutEmpty = (facts: Readonly<Record<string, unknown>>): StepFacts =>
  Object.fromEntries(Object.entries(facts).filter(([, value]) => !emptyValues.has(value)));

const tailOf = (text: string): string => {
  const tail = text.length > outputLimit ? text.slice(-outputLimit) : text;
  return /^[\uDC00-\uDFFF]/u.test(tail) ? tail.slice(1) : tail;
};

const innerCommand = (command: string): string => {
  const inner = shellWrapper.exec(command)?.groups?.inner;
  return inner === undefined ? command : inner.replaceAll(String.raw`\"`, '"');
};

const toAction = (action: CommandAction): NonNullable<StepFacts["actions"]>[number] => {
  switch (action.type) {
    case "read": {
      return { type: "read", path: action.path };
    }
    case "search": {
      return withoutEmpty({ type: "search", query: action.query, path: action.path }) as { readonly type: "search" };
    }
    case "listFiles": {
      return withoutEmpty({ type: "list", path: action.path }) as { readonly type: "list" };
    }
    case "unknown": {
      return { type: "run" };
    }
  }
};

const countLines = (diff: string, sign: "+" | "-"): number =>
  diff.split("\n").filter((line) => line.startsWith(sign) && !line.startsWith(sign.repeat(3))).length;

const toFile = ({ path, kind, diff }: FileUpdateChange): NonNullable<StepFacts["files"]>[number] => {
  const counts = { lines_added: countLines(diff, "+"), lines_removed: countLines(diff, "-") };
  if (kind.type === "add") return { path, change: "added", ...counts };
  if (kind.type === "delete") return { path, change: "deleted", ...counts };
  return kind.move_path
    ? { path: kind.move_path, change: "moved", from: path, ...counts }
    : { path, change: "modified", ...counts };
};

const toPlanItems = (plan: readonly TurnPlanStep[]): NonNullable<StepFacts["items"]> =>
  plan.map(({ step, status }) => ({
    text: step,
    state: status === "completed" ? "done" : status === "inProgress" ? "in_progress" : "pending",
  }));

const searchFacts = (item: Extract<ThreadItem, { readonly type: "webSearch" }>): StepFacts => {
  const { action } = item;
  const queries = action?.type === "search" && action.queries && action.queries.length > 1 ? action.queries : undefined;
  const url = action?.type === "openPage" || action?.type === "findInPage" ? action.url : undefined;
  const pattern = action?.type === "findInPage" ? action.pattern : undefined;
  return withoutEmpty({ query: item.query, queries, url, pattern });
};

const summaryFacts = (summary: string): StepFacts => {
  const heading = /\*\*(?<heading>[^*]+)\*\*/u.exec(
    summary.split("\n\n").findLast((part) => part.startsWith("**")) ?? "",
  )?.groups?.heading;
  return withoutEmpty({ summary, heading });
};

const closing = (state: TurnState): readonly EngineEvent[] => (state.openMessage ? [{ type: "text.ended" }] : []);

const isAskCall = (item: Extract<ThreadItem, { readonly type: "mcpToolCall" }>): boolean =>
  item.server === toolServerName && item.tool === askToolName;

const quietToolNames: ReadonlySet<string> = new Set([...memoryToolNames, imageToolName]);

const isQuietCall = (item: Extract<ThreadItem, { readonly type: "mcpToolCall" }>): boolean =>
  item.server === toolServerName && quietToolNames.has(item.tool);

const startStep = (item: ThreadItem): EngineEvent | undefined => {
  switch (item.type) {
    case "reasoning": {
      return started(item.id, "thinking", {});
    }
    case "commandExecution": {
      return started(
        item.id,
        "command",
        withoutEmpty({
          command: innerCommand(item.command),
          cwd: item.cwd,
          actions: item.commandActions.map(toAction),
        }),
      );
    }
    case "fileChange": {
      return started(item.id, "file_change", { files: item.changes.map(toFile) });
    }
    case "webSearch": {
      return started(item.id, "web_search", searchFacts(item));
    }
    case "mcpToolCall": {
      return isAskCall(item) || isQuietCall(item)
        ? undefined
        : started(item.id, "tool", { capability: item.server, operation: item.tool, arguments: item.arguments });
    }
    case "dynamicToolCall": {
      return started(item.id, "tool", {
        capability: item.namespace ?? "tool",
        operation: item.tool,
        arguments: item.arguments,
      });
    }
    case "sleep": {
      return started(item.id, "wait", { wait_ms: item.durationMs });
    }
    case "imageView": {
      return started(item.id, "image_view", { path: item.path });
    }
    case "contextCompaction": {
      return started(item.id, "compacting", {});
    }
    case "userMessage":
    case "agentMessage":
    case "hookPrompt":
    case "functionCallOutput":
    case "plan":
    case "collabAgentToolCall":
    case "subAgentActivity":
    case "imageGeneration":
    case "enteredReviewMode":
    case "exitedReviewMode": {
      return undefined;
    }
  }
};

const endStep = (item: ThreadItem): EngineEvent | undefined => {
  switch (item.type) {
    case "reasoning": {
      return ended(item.id, true, summaryFacts(item.summary.join("\n\n")));
    }
    case "commandExecution": {
      return ended(
        item.id,
        typeof item.exitCode === "number",
        withoutEmpty({
          exit_code: item.exitCode,
          output: item.aggregatedOutput ? tailOf(item.aggregatedOutput) : undefined,
        }),
      );
    }
    case "fileChange": {
      return ended(item.id, item.status === "completed", { files: item.changes.map(toFile) });
    }
    case "webSearch": {
      return ended(item.id, true, searchFacts(item));
    }
    case "mcpToolCall": {
      const isCompleted = item.status === "completed";
      if (isAskCall(item)) return isCompleted ? { type: "asked" } : undefined;
      if (isQuietCall(item)) return undefined;
      return ended(
        item.id,
        isCompleted,
        withoutEmpty({
          detail: item.error?.message ?? (isCompleted ? undefined : resultText(item.result)),
          url: resultUrl(item.result),
        }),
      );
    }
    case "dynamicToolCall": {
      return ended(item.id, item.success !== false);
    }
    case "sleep":
    case "imageView":
    case "contextCompaction": {
      return ended(item.id, true);
    }
    case "userMessage":
    case "agentMessage":
    case "hookPrompt":
    case "functionCallOutput":
    case "plan":
    case "collabAgentToolCall":
    case "subAgentActivity":
    case "imageGeneration":
    case "enteredReviewMode":
    case "exitedReviewMode": {
      return undefined;
    }
  }
};

const startItem = (state: TurnState, item: ThreadItem): Mapped => {
  if (item.type === "userMessage") {
    if (!item.clientId || !state.steered.has(item.clientId)) return { state, events: [] };
    return {
      state: { ...state, openMessage: undefined },
      events: [...closing(state), { type: "input.read", messageId: toMessageId(item.clientId) }],
    };
  }
  if (item.type === "agentMessage") {
    return {
      state: { ...state, openMessage: item.id },
      events: [...closing(state), { type: "text.started", kind: item.phase === "commentary" ? "note" : "reply" }],
    };
  }
  const step = startStep(item);
  return {
    state: {
      ...state,
      isCompacting: state.isCompacting || item.type === "contextCompaction",
      ...(item.type === "reasoning" && { summary: "" }),
    },
    events: step ? [step] : [],
  };
};

const completeItem = (state: TurnState, item: ThreadItem): Mapped => {
  if (item.type === "agentMessage" && item.id === state.openMessage) {
    return { state: { ...state, openMessage: undefined }, events: [{ type: "text.ended" }] };
  }
  const step = endStep(item);
  return {
    state: item.type === "contextCompaction" ? { ...state, isCompacting: false } : state,
    events: step ? [step] : [],
  };
};

const addSummary = (state: TurnState, key: string, text: string): Mapped => {
  const summary = state.summary + text;
  return { state: { ...state, summary }, events: [{ type: "step.updated", key, facts: summaryFacts(summary) }] };
};

const updatePlan = (state: TurnState, explanation: string | null, plan: readonly TurnPlanStep[]): Mapped => {
  const facts = withoutEmpty({ explanation, items: toPlanItems(plan) });
  return state.hasPlan
    ? { state, events: [{ type: "step.updated", key: planKey, facts }] }
    : { state: { ...state, hasPlan: true }, events: [started(planKey, "plan", facts)] };
};

const handledMethods = [
  "item/started",
  "item/completed",
  "item/agentMessage/delta",
  "item/reasoning/summaryPartAdded",
  "item/reasoning/summaryTextDelta",
  "item/fileChange/patchUpdated",
  "turn/plan/updated",
  "turn/completed",
] as const;

type HandledNotification = Extract<ServerNotification, { readonly method: (typeof handledMethods)[number] }>;

const isHandled = (notification: ServerNotification): notification is HandledNotification =>
  (handledMethods as readonly string[]).includes(notification.method);

const toTurnEnd = ({
  status,
  error,
}: Extract<HandledNotification, { readonly method: "turn/completed" }>["params"]["turn"]): readonly EngineEvent[] => {
  switch (status) {
    case "completed": {
      return [{ type: "ended" }];
    }
    case "interrupted": {
      return [{ type: "stopped" }];
    }
    case "failed": {
      return [toFailure(error)];
    }
    case "inProgress": {
      return [];
    }
  }
};

export const toEngineEvents = (state: TurnState, notification: ServerNotification): Mapped => {
  if (!isHandled(notification)) return { state, events: [] };
  switch (notification.method) {
    case "item/started": {
      return startItem(state, notification.params.item);
    }
    case "item/completed": {
      return completeItem(state, notification.params.item);
    }
    case "item/agentMessage/delta": {
      const { itemId, delta } = notification.params;
      return { state, events: itemId === state.openMessage ? [{ type: "text", text: delta }] : [] };
    }
    case "item/reasoning/summaryPartAdded": {
      return { state: state.summary ? { ...state, summary: `${state.summary}\n\n` } : state, events: [] };
    }
    case "item/reasoning/summaryTextDelta": {
      return addSummary(state, notification.params.itemId, notification.params.delta);
    }
    case "item/fileChange/patchUpdated": {
      const { itemId, changes } = notification.params;
      return { state, events: [{ type: "step.updated", key: itemId, facts: { files: changes.map(toFile) } }] };
    }
    case "turn/plan/updated": {
      return updatePlan(state, notification.params.explanation, notification.params.plan);
    }
    case "turn/completed": {
      return { state, events: toTurnEnd(notification.params.turn) };
    }
  }
};
