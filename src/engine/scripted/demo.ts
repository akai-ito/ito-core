import type { EngineEvent, Input } from "#engine/engine.ts";
import type { ScriptSource, TimedEvent } from "#engine/scripted/script-engine.ts";

const pieceMs = 70;

const shortReply = [
  "Here's a quick answer from the demo engine.",
  "",
  "- It streams a reply in small pieces, the way a real model does.",
  "- Send a message while it writes to try **steering**.",
  "- Include *long* for a long reply to stop, *fail* for a failure, or *silent* for a timeout.",
].join("\n");

const longReply = Array.from(
  { length: 12 },
  (_, index) =>
    `**Part ${index + 1}.** This is a long reply from the demo engine, so you can tap Stop halfway through and see the text cut exactly where it was on your screen.`,
).join("\n\n");

const toPieces = (text: string): readonly string[] => text.match(/\S+\s*/g) ?? [text];

const writeMessage = (kind: "reply" | "note", text: string, startAt: number): readonly TimedEvent[] => {
  const pieces = toPieces(text);
  return [
    { at: startAt, event: { type: "text.started", kind } },
    ...pieces.map((piece, index) => ({
      at: startAt + (index + 1) * pieceMs,
      event: { type: "text", text: piece } as const,
    })),
    { at: startAt + (pieces.length + 1) * pieceMs, event: { type: "text.ended" } },
  ];
};

const lastAt = (events: readonly TimedEvent[]): number => Math.max(...events.map(({ at }) => at));

const ending = (events: readonly TimedEvent[], event: EngineEvent): TimedEvent => ({
  at: lastAt(events) + pieceMs,
  event,
});

const opening = (input: string, now: number): readonly TimedEvent[] => {
  const query = input.slice(0, 60);
  return [
    { at: now + 200, event: { type: "step.started", key: "thinking", kind: "thinking", facts: {} } },
    {
      at: now + 450,
      event: {
        type: "step.updated",
        key: "thinking",
        facts: { heading: "Reading your message", summary: "**Reading your message**\n\nWorking out what you need." },
      },
    },
    { at: now + 650, event: { type: "step.ended", key: "thinking", outcome: "completed", facts: {} } },
    ...writeMessage("note", "Let me put that together.", now + 700),
    { at: now + 1500, event: { type: "step.started", key: "search", kind: "web_search", facts: { query } } },
    { at: now + 2300, event: { type: "step.ended", key: "search", outcome: "completed", facts: { query } } },
  ];
};

const scriptFor = (inputs: readonly Input[], now: number): readonly TimedEvent[] => {
  const text = inputs
    .map((input) => input.text)
    .join("\n")
    .toLowerCase();
  const start = opening(text, now);
  if (text.includes("silent")) return start;
  if (text.includes("fail")) {
    return [
      ...start,
      ending(start, { type: "failed", code: "model_unavailable", detail: "The demo engine was asked to fail." }),
    ];
  }
  const reply = writeMessage("reply", text.includes("long") ? longReply : shortReply, lastAt(start) + 800);
  return [...start, ...reply, ending(reply, { type: "ended" })];
};

export const demoScripts: ScriptSource = (_turn, inputs, now) => {
  const events = scriptFor(inputs, now);
  return {
    events,
    steer: (input, steeredAt) => {
      const replyAt = Math.max(steeredAt + 600, lastAt(events) + pieceMs);
      return {
        outcome: "taken",
        events: [
          { at: steeredAt + 300, event: { type: "input.read", messageId: input.messageId } },
          ...writeMessage("reply", `Got it: ${input.text}`, replyAt),
        ],
      };
    },
    stoppedAt: (requestedAt) => requestedAt + 150,
  };
};
