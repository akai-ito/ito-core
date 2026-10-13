import type { MessageId, TurnId } from "#conversation/ids.ts";

export type Input = { readonly messageId: MessageId; readonly text: string };

export type Activity =
  | { readonly kind: "thinking"; readonly heading?: string }
  | { readonly kind: "web_search"; readonly query?: string }
  | { readonly kind: "command"; readonly action: "read" | "search" | "list" | "run" }
  | { readonly kind: "file_change" }
  | { readonly kind: "tool"; readonly capability: string; readonly operation: string }
  | { readonly kind: "compacting" };

export type EngineFailureCode =
  | "model_timeout"
  | "model_unavailable"
  | "usage_limit"
  | "engine_signed_out"
  | "context_full"
  | "engine_failed"
  | "refused"
  | "internal";

export type EngineEvent =
  | { readonly type: "activity"; readonly activity: Activity }
  | { readonly type: "text.started"; readonly kind: "reply" | "note" }
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "text.ended" }
  | { readonly type: "input.read"; readonly messageId: MessageId }
  | { readonly type: "failed"; readonly code: EngineFailureCode; readonly detail: string }
  | { readonly type: "stopped" }
  | { readonly type: "ended" };

export type SteerOutcome = "taken" | "refused";

export type Engine = {
  readonly start: (turn: TurnId, inputs: readonly Input[]) => AsyncIterable<EngineEvent>;
  readonly steer: (turn: TurnId, input: Input) => Promise<SteerOutcome>;
  readonly interrupt: (turn: TurnId) => Promise<void>;
  readonly restart: () => Promise<void>;
  readonly close: () => Promise<void>;
};
