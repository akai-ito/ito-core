import type { MessageId, TurnId } from "#conversation/ids.ts";

export type TurnPhase = "running" | "stopping" | "asking";

export type LiveTurn = {
  readonly id: TurnId;
  readonly phase: TurnPhase;
  readonly hasStartedReply: boolean;
};

export type Conversation = {
  readonly turn: LiveTurn | undefined;
  readonly next: readonly MessageId[];
};

export type Route =
  | { readonly kind: "start"; readonly inputs: readonly MessageId[] }
  | { readonly kind: "steer"; readonly turn: TurnId }
  | { readonly kind: "queue"; readonly behind: TurnId };

export const route = (conversation: Conversation, message: MessageId): Route => {
  const { turn, next } = conversation;
  if (!turn) return { kind: "start", inputs: [...next, message] };
  return turn.phase !== "running" || next.length > 0
    ? { kind: "queue", behind: turn.id }
    : { kind: "steer", turn: turn.id };
};

export const isAdjustingAfterRead = (turn: LiveTurn): boolean => turn.hasStartedReply;
