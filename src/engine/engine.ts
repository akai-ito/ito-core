import type { MessageId, TurnId } from "#conversation/ids.ts";
import type { Ask, ModelChoice, ModelOption, Step, StepKind } from "#protocol/types.ts";
import type { Result } from "#result.ts";

export type InputAttachment = { readonly kind: "image" | "file"; readonly name: string; readonly source: string };

export type Input = {
  readonly messageId: MessageId;
  readonly text: string;
  readonly attachments?: readonly InputAttachment[];
};

export type ToolServer = { readonly url: string; readonly origin: string; readonly token: string };

export const modelSetting = "agent_model";

export const accountSetting = "agent_account";

export const effortSetting = "agent_effort";

export const choiceSetting = "agent_choice";

export const readChoice = (read: (key: string) => string | undefined): ModelChoice | undefined => {
  const saved = read(choiceSetting);
  return saved === undefined ? undefined : (JSON.parse(saved) as ModelChoice);
};

export type AskFields = Pick<Ask, "kind" | "question" | "options" | "allows_text" | "attachments"> & {
  readonly preview?: string;
};

export type StepFacts = Omit<
  Step,
  "id" | "turn" | "kind" | "title" | "at" | "position" | "ended_at" | "outcome" | "duration_ms"
>;

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
  | { readonly type: "step.started"; readonly key: string; readonly kind: StepKind; readonly facts: StepFacts }
  | { readonly type: "step.updated"; readonly key: string; readonly facts: StepFacts }
  | {
      readonly type: "step.ended";
      readonly key: string;
      readonly outcome: "completed" | "failed";
      readonly facts: StepFacts;
    }
  | { readonly type: "text.started"; readonly kind: "reply" | "note" }
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "text.ended" }
  | { readonly type: "input.read"; readonly messageId: MessageId }
  | { readonly type: "failed"; readonly code: EngineFailureCode; readonly detail: string }
  | { readonly type: "ask"; readonly fields: AskFields }
  | { readonly type: "approval"; readonly key: string; readonly fields: AskFields }
  | { readonly type: "asked" }
  | { readonly type: "progress" }
  // The model's connection dropped and the engine is trying again, such as "Reconnecting... 2/5".
  | { readonly type: "reconnecting"; readonly detail: string }
  | { readonly type: "stopped" }
  | { readonly type: "ended" };

export type SteerOutcome = "taken" | "refused";

export type JsonSchema = Readonly<Record<string, unknown>>;

export type Complete = (prompt: string, schema: JsonSchema, choice?: ModelChoice) => Promise<Result<unknown, string>>;

// Why background work didn't finish: a turn's failure codes, and the technical cause.
export type WorkFailure = { readonly code: EngineFailureCode; readonly detail: string };

export type WorkOptions = {
  // The model and effort to work on, or else the one they chose.
  readonly choice?: ModelChoice;
  // Each sign of life while it works, such as text, reasoning or a tool starting, so its silence can be told.
  readonly onActivity?: () => void;
  // Aborting it interrupts the work.
  readonly signal?: AbortSignal;
};

export type Engine = {
  readonly start: (turn: TurnId, inputs: readonly Input[]) => AsyncIterable<EngineEvent>;
  readonly steer: (turn: TurnId, input: Input) => Promise<SteerOutcome>;
  readonly interrupt: (turn: TurnId) => Promise<void>;
  readonly approve: (turn: TurnId, key: string, isAllowed: boolean) => void;
  readonly complete: Complete;
  // Background work in a thread of its own, under a run that its tool calls carry.
  readonly work: (prompt: string, run: string, options?: WorkOptions) => Promise<Result<string, WorkFailure>>;
  // When the model provider's usage limit resets, in milliseconds, as it last said; undefined while it isn't
  // reached, or when it never said.
  readonly usageResetsAt: () => number | undefined;
  readonly restart: () => Promise<void>;
  readonly refresh: () => Promise<void>;
  readonly models: () => Promise<Result<readonly ModelOption[], string>>;
  readonly close: () => Promise<void>;
};

export const restartedDetail = "Codex restarted before it answered.";

// Background work held back while Kumo's model is paused by a usage limit: the one catch-up after takes it in.
export const pausedDetail = "Kumo's paused until its model's usage limit resets, and catches up then.";
