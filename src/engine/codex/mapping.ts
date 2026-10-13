import type { ServerNotification } from "#engine/codex/bindings/ServerNotification.ts";
import type { CodexErrorInfo } from "#engine/codex/bindings/v2/CodexErrorInfo.ts";
import type { CommandAction } from "#engine/codex/bindings/v2/CommandAction.ts";
import type { ThreadItem } from "#engine/codex/bindings/v2/ThreadItem.ts";
import type { TurnError } from "#engine/codex/bindings/v2/TurnError.ts";
import type { Activity, EngineEvent, EngineFailureCode } from "#engine/engine.ts";
import { toMessageId } from "#conversation/ids.ts";

export type TurnState = {
  readonly openMessage: string | undefined;
  readonly steered: ReadonlySet<string>;
  readonly isCompacting: boolean;
  readonly summary: string;
  readonly heading: string | undefined;
};

export type Mapped = { readonly state: TurnState; readonly events: readonly EngineEvent[] };

export const initialTurnState: TurnState = {
  openMessage: undefined,
  steered: new Set(),
  isCompacting: false,
  summary: "",
  heading: undefined,
};

const unavailableErrors = new Set([
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

export const toFailureCode = (info: CodexErrorInfo | null): EngineFailureCode => {
  const name = errorName(info);
  if (name === "unauthorized") return "engine_signed_out";
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

const toCommandActivity = ([first]: readonly CommandAction[]): Activity => {
  switch (first?.type) {
    case "read": {
      return { kind: "command", action: "read" };
    }
    case "search": {
      return { kind: "command", action: "search" };
    }
    case "listFiles": {
      return { kind: "command", action: "list" };
    }
    case "unknown":
    case undefined: {
      return { kind: "command", action: "run" };
    }
  }
};

const toActivity = (item: ThreadItem): Activity | undefined => {
  switch (item.type) {
    case "reasoning": {
      return { kind: "thinking" };
    }
    case "commandExecution": {
      return toCommandActivity(item.commandActions);
    }
    case "fileChange": {
      return { kind: "file_change" };
    }
    case "webSearch": {
      return item.query ? { kind: "web_search", query: item.query } : { kind: "web_search" };
    }
    case "mcpToolCall": {
      return { kind: "tool", capability: item.server, operation: item.tool };
    }
    case "dynamicToolCall": {
      return { kind: "tool", capability: item.namespace ?? "tool", operation: item.tool };
    }
    case "contextCompaction": {
      return { kind: "compacting" };
    }
    case "userMessage":
    case "agentMessage":
    case "hookPrompt":
    case "functionCallOutput":
    case "plan":
    case "collabAgentToolCall":
    case "subAgentActivity":
    case "imageView":
    case "sleep":
    case "imageGeneration":
    case "enteredReviewMode":
    case "exitedReviewMode": {
      return undefined;
    }
  }
};

const headingOf = (summary: string): string | undefined =>
  /^\s*\*\*(?<heading>[^*]+)\*\*/u.exec(summary)?.groups?.heading;

const closing = (state: TurnState): readonly EngineEvent[] => (state.openMessage ? [{ type: "text.ended" }] : []);

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
  const activity = toActivity(item);
  return {
    state: {
      ...state,
      isCompacting: state.isCompacting || item.type === "contextCompaction",
      ...(item.type === "reasoning" && { summary: "", heading: undefined }),
    },
    events: activity ? [{ type: "activity", activity }] : [],
  };
};

const completeItem = (state: TurnState, item: ThreadItem): Mapped => {
  if (item.type === "agentMessage" && item.id === state.openMessage) {
    return { state: { ...state, openMessage: undefined }, events: [{ type: "text.ended" }] };
  }
  if (item.type === "contextCompaction") return { state: { ...state, isCompacting: false }, events: [] };
  return {
    state,
    events:
      item.type === "webSearch" && item.query
        ? [{ type: "activity", activity: { kind: "web_search", query: item.query } }]
        : [],
  };
};

const addSummary = (state: TurnState, delta: string): Mapped => {
  const summary = state.summary + delta;
  const heading = headingOf(summary);
  return heading && heading !== state.heading
    ? { state: { ...state, summary, heading }, events: [{ type: "activity", activity: { kind: "thinking", heading } }] }
    : { state: { ...state, summary }, events: [] };
};

const handledMethods = [
  "item/started",
  "item/completed",
  "item/agentMessage/delta",
  "item/reasoning/summaryPartAdded",
  "item/reasoning/summaryTextDelta",
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
      return { state: { ...state, summary: "" }, events: [] };
    }
    case "item/reasoning/summaryTextDelta": {
      return addSummary(state, notification.params.delta);
    }
    case "turn/completed": {
      return { state, events: toTurnEnd(notification.params.turn) };
    }
  }
};
