import { createCell } from "#cell.ts";
import { toMessageId } from "#conversation/ids.ts";
import { toStatus } from "#conversation/status.ts";
import type { Activity, EngineFailureCode } from "#engine/engine.ts";
import type { ScriptSource, TimedEvent, TurnScript } from "#engine/scripted/script-engine.ts";
import type { TurnStatus } from "#protocol/types.ts";
import type { LoggedEvent } from "#store/projection.ts";
import type { Transcript } from "./transcript-file.ts";

const activityCandidates: readonly Activity[] = [
  { kind: "thinking" },
  { kind: "web_search" },
  { kind: "command", action: "read" },
  { kind: "command", action: "search" },
  { kind: "command", action: "list" },
  { kind: "command", action: "run" },
  { kind: "file_change" },
  { kind: "compacting" },
];

const withDetail = (activity: Activity, detail: string | undefined): Activity => {
  if (!detail) return activity;
  if (activity.kind === "thinking") return { ...activity, heading: detail };
  return activity.kind === "web_search" ? { ...activity, query: detail } : activity;
};

const toActivity = (status: TurnStatus): Activity | undefined =>
  activityCandidates
    .map((candidate) => withDetail(candidate, status.detail))
    .find((candidate) => {
      const derived = toStatus(candidate);
      return derived.kind === status.kind && derived.label === status.label && derived.detail === status.detail;
    });

const loggedEvents = (transcript: Transcript): readonly LoggedEvent[] =>
  transcript.steps
    .flatMap((step) => ("event" in step && step.event.type !== "snapshot" ? [step.event] : []))
    .filter((event, index, events) => events.findIndex((other) => other.id === event.id) === index);

const isPartOf = (event: LoggedEvent, turn: string, messageTurns: ReadonlyMap<string, string>): boolean => {
  switch (event.type) {
    case "message.started": {
      return event.message.turn === turn;
    }
    case "message.delta":
    case "message.ended": {
      return messageTurns.get(event.message) === turn;
    }
    case "turn.status":
    case "message.read":
    case "turn.ended": {
      return event.turn === turn;
    }
    case "message.accepted":
    case "message.queued":
    case "turn.started": {
      return false;
    }
  }
};

const toTimed = (event: LoggedEvent): TimedEvent | undefined => {
  const at = Date.parse(event.at);
  switch (event.type) {
    case "turn.status": {
      const activity = toActivity(event);
      return activity && { at, event: { type: "activity", activity } };
    }
    case "message.started": {
      return { at, event: { type: "text.started", kind: event.message.kind ?? "reply" } };
    }
    case "message.delta": {
      return { at, event: { type: "text", text: event.text } };
    }
    case "message.ended": {
      return event.outcome === "completed" ? { at, event: { type: "text.ended" } } : undefined;
    }
    case "message.read": {
      return { at, event: { type: "input.read", messageId: toMessageId(event.message) } };
    }
    case "turn.ended": {
      if (event.outcome === "completed") return { at, event: { type: "ended" } };
      if (event.outcome !== "failed" || !event.error || event.error.code === "model_timeout") return;
      return {
        at,
        event: { type: "failed", code: event.error.code as EngineFailureCode, detail: event.error.detail ?? "" },
      };
    }
    case "message.accepted":
    case "message.queued":
    case "turn.started": {
      return;
    }
  }
};

const toScript = (events: readonly LoggedEvent[]): TurnScript => {
  const reads = new Set(events.filter((event) => event.type === "message.read").map((event) => event.message));
  const stopped = events.find((event) => event.type === "turn.ended" && event.outcome === "stopped");
  return {
    events: events.map((event) => toTimed(event)).filter((timed) => timed !== undefined),
    steer: (input) => ({ outcome: reads.has(input.messageId) ? "taken" : "refused" }),
    stoppedAt: (requestedAt) => (stopped ? Date.parse(stopped.at) : requestedAt),
  };
};

export const deriveScripts = (transcript: Transcript): readonly TurnScript[] => {
  const events = loggedEvents(transcript);
  const messageTurns = new Map(
    events.flatMap((event) =>
      event.type === "message.started" ? [[event.message.id, event.message.turn ?? ""] as const] : [],
    ),
  );
  return events
    .filter((event) => event.type === "turn.started")
    .map((event) => event.turn)
    .map((turn) => toScript(events.filter((event) => isPartOf(event, turn, messageTurns))));
};

export const createScriptQueue = (scripts: readonly TurnScript[]): ScriptSource => {
  const remaining = createCell(scripts);
  return () => {
    const [next, ...rest] = remaining.get();
    if (!next) throw new Error("The transcript has no script for another turn.");
    remaining.set(rest);
    return next;
  };
};
