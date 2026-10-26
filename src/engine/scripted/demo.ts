import { createCell } from "#cell.ts";
import type { AskFields, EngineEvent, Input, StepFacts } from "#engine/engine.ts";
import type { Act, CallTool, ScriptSource, TimedEvent } from "#engine/scripted/script-engine.ts";

const pieceMs = 70;

const shortReply = [
  "Here's a quick answer from the demo engine.",
  "",
  "- It streams a reply in small pieces, the way a real model does.",
  "- Send a message while it writes to try **steering**.",
  "- Include *busy* for a trail of steps, *long* for a long reply to stop, *fail* for a failure, *silent* for a timeout, *ask* for a question, *approve* for an approval, or *secret* for a secret question.",
  "- *remember* writes Alex's page in memory (again, and the old state moves to Earlier) and adds to today's journal; *recall* looks Alex up.",
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

const askFor = (text: string): AskFields | undefined => {
  if (/\bsecret\b/u.test(text)) {
    return {
      kind: "question",
      question: "The demo engine needs a code. What is it?",
      options: [],
      allows_text: true,
      secret: true,
    };
  }
  if (/\bapprove\b/u.test(text)) {
    return {
      kind: "approval",
      question: "Shall I go ahead?",
      options: [{ label: "Go ahead", acts: true }, { label: "Not now" }],
      allows_text: false,
      preview: "The demo engine would book a table for two, Saturday at 7:30.",
      secret: false,
    };
  }
  if (!/\bask\b/u.test(text)) return undefined;
  return {
    kind: "question",
    question: "Which Juno did you mean?",
    options: [
      { label: "Clapham", description: "Abbeville Road, SW4" },
      { label: "Soho", description: "Greek Street, W1" },
    ],
    allows_text: true,
    secret: false,
  };
};

const alex = "memory:people/alex";

const dayOf = (at: number): string => new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" }).format(at);

const rememberAlex =
  (now: number): Act["act"] =>
  async (callTool: CallTool) => {
    const existing = await callTool("read_page", { address: alex });
    const today = dayOf(now);
    const body = existing.isError
      ? `Taking things slow; you've been on two dates (as of ${today}).`
      : `Seeing each other a lot, and it's going really well (as of ${today}).\n\n## Earlier\n\n- ${today}: taking things slow.`;
    await callTool("remember", { address: alex, title: "Alex", aliases: ["Alex R"], body });
    await callTool("journal", { text: "Talked about Alex; things are going well." });
  };

const recallAlex: Act["act"] = async (callTool) => {
  await callTool("recall", { query: "Alex" });
};

type Script = { readonly events: readonly TimedEvent[]; readonly acts?: readonly Act[] };

const memoryScript = (text: string, start: readonly TimedEvent[], now: number): Script | undefined => {
  const isRemembering = /\bremember\b/u.test(text);
  if (!isRemembering && !/\brecall\b/u.test(text)) return undefined;
  const actAt = lastAt(start) + 300;
  const reply = writeMessage(
    "reply",
    isRemembering ? "I've updated Alex's page, and added to today's journal." : "Here's what I remember about Alex.",
    actAt + 1200,
  );
  return {
    events: [...start, ...reply, ending(reply, { type: "ended" })],
    acts: [{ at: actAt, act: isRemembering ? rememberAlex(now) : recallAlex }],
  };
};

const scriptFor = (inputs: readonly Input[], now: number): Script => {
  const text = inputs
    .map((input) => input.text)
    .join("\n")
    .toLowerCase();
  const opened = opening(text, now);
  const start = text.includes("busy") ? [...opened, ...busyTrail(lastAt(opened) + 300)] : opened;
  if (text.includes("silent")) return { events: start };
  const remembering = memoryScript(text, start, now);
  if (remembering) return remembering;
  const fields = askFor(text);
  if (fields) {
    const askedAt = lastAt(start) + 300;
    return {
      events: [
        ...start,
        { at: askedAt, event: { type: "ask", fields } },
        { at: askedAt + pieceMs, event: { type: "ended" } },
      ],
    };
  }
  if (text.includes("fail")) {
    return {
      events: [
        ...start,
        ending(start, { type: "failed", code: "model_unavailable", detail: "The demo engine was asked to fail." }),
      ],
    };
  }
  const attached = inputs.flatMap((input) => input.attachments ?? []);
  const seen =
    attached.length > 0
      ? `I can see ${attached.map((attachment) => `${attachment.name} (${attachment.kind === "image" ? "a photo" : "a file"})`).join(" and ")}.\n\n`
      : "";
  const reply = writeMessage("reply", seen + (text.includes("long") ? longReply : shortReply), lastAt(start) + 800);
  return { events: [...start, ...reply, ending(reply, { type: "ended" })] };
};

export const demoScripts: ScriptSource = (_turn, inputs, now) => {
  const { events, acts } = scriptFor(inputs, now);
  const scheduledUntil = createCell(lastAt(events));
  return {
    events,
    ...(acts && { acts }),
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
