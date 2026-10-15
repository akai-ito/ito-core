import { createCell } from "#cell.ts";
import { toMessageId } from "#conversation/ids.ts";
import { factsOf } from "#conversation/steps.ts";
import type { EngineFailureCode } from "#engine/engine.ts";
import type { ScriptSource, TimedEvent, TurnScript } from "#engine/scripted/script-engine.ts";
import type { LoggedEvent } from "#store/projection.ts";
import type { Transcript } from "./transcript-file.ts";

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
    case "step.started":
    case "step.updated":
    case "step.ended": {
      return event.step.turn === turn;
    }
    case "ask.started": {
      return event.ask.turn === turn;
    }
    case "ask.ended": {
      return false;
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
    case "ask.started": {
      const { kind, question, options, allows_text, preview, secret } = event.ask;
      const fields = { kind, question, options, allows_text, ...(preview && { preview }), secret };
      return { at, event: { type: "ask", fields } };
    }
    case "turn.status":
    case "ask.ended": {
      return;
    }
    case "step.started": {
      const { step } = event;
      return { at, event: { type: "step.started", key: step.id, kind: step.kind, facts: factsOf(step) } };
    }
    case "step.updated": {
      return { at, event: { type: "step.updated", key: event.step.id, facts: factsOf(event.step) } };
    }
    case "step.ended": {
      const { step } = event;
      const outcome = step.outcome === "failed" ? "failed" : "completed";
      return { at, event: { type: "step.ended", key: step.id, outcome, facts: factsOf(step) } };
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

type MessageEnded = Extract<LoggedEvent, { readonly type: "message.ended" }>;

const standInsFor = (events: readonly LoggedEvent[]): ReadonlySet<string> => {
  const written = new Set(events.filter((event) => event.type === "message.delta").map((event) => event.message));
  return new Set(
    events
      .filter(
        (event): event is MessageEnded =>
          event.type === "message.ended" &&
          event.length === 0 &&
          (event.outcome === "failed" || event.outcome === "interrupted") &&
          !written.has(event.message),
      )
      .map((event) => event.message),
  );
};

const isAboutMessage = (event: LoggedEvent, messages: ReadonlySet<string>): boolean =>
  (event.type === "message.started" && messages.has(event.message.id)) ||
  (event.type === "message.ended" && messages.has(event.message));

const isEndedByTheLoop = (event: LoggedEvent, turnEnd: LoggedEvent | undefined): boolean => {
  if (event.type !== "step.ended") return false;
  const { outcome, ended_at: endedAt } = event.step;
  const isTurnsOwnEnd =
    turnEnd?.type === "turn.ended" &&
    turnEnd.outcome !== "completed" &&
    outcome === turnEnd.outcome &&
    endedAt === turnEnd.at;
  return outcome === "stopped" || outcome === "interrupted" || isTurnsOwnEnd;
};

const toScript = (events: readonly LoggedEvent[]): TurnScript => {
  const reads = new Set(events.filter((event) => event.type === "message.read").map((event) => event.message));
  const stopped = events.find((event) => event.type === "turn.ended" && event.outcome === "stopped");
  const turnEnd = events.find((event) => event.type === "turn.ended");
  const standIns = standInsFor(events);
  return {
    events: events
      .filter((event) => !isAboutMessage(event, standIns) && !isEndedByTheLoop(event, turnEnd))
      .map((event) => toTimed(event))
      .filter((timed) => timed !== undefined),
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
