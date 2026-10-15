import type { MessageId, TurnId } from "#conversation/ids.ts";
import type { Ask, Step, StepKind } from "#protocol/types.ts";

export type InputAttachment = { readonly kind: "image" | "file"; readonly name: string; readonly source: string };

export type Input = {
  readonly messageId: MessageId;
  readonly text: string;
  readonly attachments?: readonly InputAttachment[];
};

export type ToolServer = { readonly url: string; readonly token: string };

export const modelSetting = "agent_model";

export const accountSetting = "agent_account";

export type AskFields = Pick<Ask, "kind" | "question" | "options" | "allows_text" | "secret"> & {
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
  | { readonly type: "asked" }
  | { readonly type: "progress" }
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
