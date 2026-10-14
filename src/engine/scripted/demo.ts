import { createCell } from "#cell.ts";
import type { EngineEvent, Input, StepFacts } from "#engine/engine.ts";
import type { ScriptSource, TimedEvent } from "#engine/scripted/script-engine.ts";

const pieceMs = 70;

const shortReply = [
  "Here's a quick answer from the demo engine.",
  "",
  "- It streams a reply in small pieces, the way a real model does.",
  "- Send a message while it writes to try **steering**.",
  "- Include *busy* for a trail of steps, *long* for a long reply to stop, *fail* for a failure, or *silent* for a timeout.",
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

type Started = Extract<EngineEvent, { readonly type: "step.started" }>;

const startStep = (key: string, kind: Started["kind"], facts: StepFacts): EngineEvent => ({
  type: "step.started",
  key,
  kind,
  facts,
});

const updatePlan = (facts: StepFacts): EngineEvent => ({ type: "step.updated", key: "plan", facts });

const endStep = (key: string, facts: StepFacts = {}): EngineEvent => ({
  type: "step.ended",
  key,
  outcome: "completed",
  facts,
});

const planOf = (states: readonly ("pending" | "in_progress" | "done")[]): StepFacts => ({
  items: ["Read your notes", "Check Saturday's forecast", "Update the notes"].map((text, index) => ({
    text,
    state: states[index] ?? "pending",
  })),
});

const busyTrail = (startAt: number): readonly TimedEvent[] =>
  [
    startStep("plan", "plan", planOf(["in_progress"])),
    startStep("read", "command", {
      command: 'cat notes.md && grep -n "run" notes.md',
      actions: [
        { type: "read", path: "notes.md" },
        { type: "search", query: "run", path: "notes.md" },
      ],
    }),
    endStep("read", { exit_code: 0, output: "Saturday: long run at 7:30\n1:Saturday: long run at 7:30\n" }),
    updatePlan(planOf(["done", "in_progress"])),
    startStep("search", "command", {
      command: 'grep -rn "umbrella" notes/',
      actions: [{ type: "search", query: "umbrella", path: "notes/" }],
    }),
    endStep("search", { exit_code: 1 }),
    startStep("tool", "tool", {
      capability: "weather",
      operation: "forecast",
      arguments: { place: "London", day: "Saturday" },
    }),
    endStep("tool"),
    startStep("wait", "wait", { wait_ms: 1500 }),
    endStep("wait"),
    updatePlan(planOf(["done", "done", "in_progress"])),
    startStep("edit", "file_change", {
      files: [{ path: "notes.md", change: "modified", lines_added: 2, lines_removed: 1 }],
    }),
    endStep("edit"),
    updatePlan(planOf(["done", "done", "done"])),
  ].map((event, index) => ({ at: startAt + index * 450, event }));

const scriptFor = (inputs: readonly Input[], now: number): readonly TimedEvent[] => {
  const text = inputs
    .map((input) => input.text)
    .join("\n")
    .toLowerCase();
  const opened = opening(text, now);
  const start = text.includes("busy") ? [...opened, ...busyTrail(lastAt(opened) + 300)] : opened;
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
  const scheduledUntil = createCell(lastAt(events));
  return {
    events,
    steer: (input, steeredAt) => {
      const replyAt = Math.max(steeredAt + 600, scheduledUntil.get() + pieceMs);
      const reply = writeMessage("reply", `Got it: ${input.text}`, replyAt);
      scheduledUntil.set(lastAt(reply));
      return {
        outcome: "taken",
        events: [{ at: steeredAt + 300, event: { type: "input.read", messageId: input.messageId } }, ...reply],
      };
    },
    stoppedAt: (requestedAt) => requestedAt + 150,
  };
};
