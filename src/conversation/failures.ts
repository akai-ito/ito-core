import type { EngineFailureCode } from "#engine/engine.ts";
import type { Error as ErrorBody } from "#protocol/types.ts";

export type TurnFailureCode = EngineFailureCode | "server_disk_full";

export type CommandFailureCode =
  | "invalid_request"
  | "token_rejected"
  | "pairing_code_rejected"
  | "not_found"
  | "id_conflict"
  | "too_large"
  | "slow_down"
  | "unavailable"
  | "internal";

const turnMessages: Readonly<Record<TurnFailureCode, string>> = {
  model_timeout: "The model stopped responding.",
  model_unavailable: "The model service isn't responding right now.",
  usage_limit: "Your plan's usage limit has been reached.",
  engine_signed_out: "Codex isn't signed in on your server. Run ito login there.",
  context_full: "This conversation is too long for the model to take in.",
  engine_failed: "Codex stopped unexpectedly.",
  server_disk_full: "Your server is out of disk space.",
  refused: "The model declined this request.",
  internal: "The server hit an unexpected error; Details has the cause.",
};

const commandMessages: Readonly<Record<CommandFailureCode, string>> = {
  invalid_request: "The request isn't valid.",
  token_rejected: "The server didn't accept this token.",
  pairing_code_rejected: "That pairing code has expired or was already used.",
  not_found: "The server doesn't know that.",
  id_conflict: "A different message was already sent with this id.",
  too_large: "The message is longer than the server accepts.",
  slow_down: "Too many attempts; wait a moment and try again.",
  unavailable: "The server is starting or shutting down.",
  internal: "The server hit an unexpected error; Details has the cause.",
};

export const toTurnError = (code: TurnFailureCode, detail: string): ErrorBody => ({
  code,
  message: turnMessages[code],
  detail,
});

export const toWatchdogError = (silenceMs: number, isWriting: boolean): ErrorBody => {
  const seconds = Math.round(silenceMs / 1000);
  return {
    code: "model_timeout",
    message: `The model didn't respond for ${seconds} seconds.`,
    detail: `No progress from the engine for ${seconds} seconds while it was ${isWriting ? "writing" : "working"}.`,
  };
};

export const toCommandError = (code: CommandFailureCode, detail?: string, message?: string): ErrorBody => ({
  code,
  message: message ?? commandMessages[code],
  ...(detail && { detail }),
});
