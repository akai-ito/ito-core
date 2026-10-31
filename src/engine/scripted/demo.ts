import { readFileSync } from "node:fs";
import type { Fetch } from "#capabilities/connect.ts";
import { createCell } from "#cell.ts";
import type { AskFields, Complete, EngineEvent, Input, StepFacts } from "#engine/engine.ts";
import { fail, ok } from "#result.ts";
import type { Act, CallTool, ScriptSource, TimedEvent } from "#engine/scripted/script-engine.ts";
import { florenceId, florencePictures, florenceTrip, type FlorencePictures } from "#protocol/tools/florence.ts";
import { sub20Id, sub20Training } from "#protocol/tools/sub20.ts";

const pieceMs = 70;

const shortReply = [
  "Here's a quick answer from the demo engine.",
  "",
  "- It streams a reply in small pieces, the way a real model does.",
  "- Send a message while it writes to try **steering**.",
  "- Include *busy* for a trail of steps, *long* for a long reply to stop, *fail* for a failure, *silent* for a timeout, *ask* for a question, or *approve* for an approval.",
  "- *remember* writes Alex's page in memory (again: edits it, and the old state moves to Earlier) and adds to today's journal; *recall* looks Alex up.",
  "- *trip* starts Florence with Janki in In motion, *training* a sub-20 5K block, and *booked* books the trip's Uffizi.",
].join("\n");

const longReply = Array.from(
  { length: 12 },
  (_, index) =>
    `**Part ${index + 1}.** This is a long reply from the demo engine, so you can tap Stop halfway through and see the reply keep what it had written.`,
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
  if (/\bapprove\b/u.test(text)) {
    return {
      kind: "approval",
      question: "Shall I go ahead?",
      options: [{ label: "Go ahead", acts: true }, { label: "Not now" }],
      allows_text: false,
      preview: "The demo engine would book a table for two, Saturday at 7:30.",
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
  };
};

const alex = "memory:people/alex";

const dayOf = (at: number): string => new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" }).format(at);

const rememberAlex =
  (now: number): Act["act"] =>
  async (callTool: CallTool) => {
    const existing = await callTool("read_page", { address: alex });
    const today = dayOf(now);
    const isNew = existing.isError === true;
    await (isNew
      ? callTool("write_page", {
          address: alex,
          title: "Alex",
          gist: "Someone you're seeing; taking it slow",
          circle: "dating",
          note: "Two dates so far",
          aliases: ["Alex R"],
          body: `Taking things slow; you've been on two dates (as of ${today}).`,
        })
      : callTool("edit_page", {
          address: alex,
          version: /version (?<version>\w+)/u.exec(existing.text)?.groups?.version ?? "",
          start_line: 1,
          end_line: 1,
          new_text: `Seeing each other a lot, and it's going really well (as of ${today}).\n\n## Earlier\n\n- ${today}: taking things slow.`,
          gist: "Someone you're seeing a lot; going really well",
          note: "Seeing each other a lot now",
        }));
    await callTool("journal", {
      text: "Talked about Alex; things are going well.",
      gist: "Things going well with Alex",
      note: "Talked about Alex",
    });
  };

const recallAlex: Act["act"] = async (callTool) => {
  await callTool("recall", { query: "Alex" });
};

type Script = { readonly events: readonly TimedEvent[]; readonly acts?: readonly Act[] };

const motionLine = (id: string): string =>
  ["```ari:motion", JSON.stringify({ motion: id, change: 1 }), "```"].join("\n");

const demoPictures = "https://example.org/ito-demo/";

const demoPicture = new URL("../../../protocol/transcripts/files/riverside.jpg", import.meta.url);

export const withDemoPictures =
  (fetcher: Fetch): Fetch =>
  (url, init) =>
    url.startsWith(demoPictures)
      ? Promise.resolve(new Response(readFileSync(demoPicture), { headers: { "Content-Type": "image/jpeg" } }))
      : fetcher(url, init);

const startTrip: Act["act"] = async (callTool) => {
  const kept = await Promise.all(
    florencePictures.map(async (name) => {
      const picture = await callTool("keep_image", { url: `${demoPictures}${name}.jpg` });
      return [name, String(picture.structured?.attachment)];
    }),
  );
  await callTool("start_motion", {
    id: florenceId,
    kind: "trip",
    title: "Florence with Janki",
    summary: "6–9 Nov · 4 to book",
    content: florenceTrip(Object.fromEntries(kept) as FlorencePictures),
    note: "Started the trip",
  });
};

const startTraining: Act["act"] = async (callTool) => {
  await callTool("start_motion", {
    id: sub20Id,
    kind: "training",
    title: "Sub-20 5K",
    summary: "Week 6 of 10 · intervals today",
    content: sub20Training,
    note: "Started the block",
  });
};

const bookUffizi: Act["act"] = async (callTool) => {
  const read = await callTool("read_motion", { id: florenceId });
  const version = Number(/version (?<version>\d+)/u.exec(read.text)?.groups?.version);
  const booking = { status: "booked", ref: "UF-2291" };
  await callTool("change_motion", {
    id: florenceId,
    version,
    changes: [
      { set: "book-uffizi", fields: { done: true } },
      { set: "uffizi", fields: { booking } },
      { set: "uffizi-place", fields: { status: "booked", booking } },
    ],
    summary: "6–9 Nov · 3 to book",
    note: "Booked the Uffizi, 8:15 Saturday",
  });
};

const fillDesk: Act["act"] = async (callTool) => {
  await callTool("add_card", {
    kind: "question",
    title: "Binned a Revolut mail",
    text: 'Binned "Your account update" from Revolut as a promotion. Right?',
    options: [{ label: "Right", acts: true }, { label: "Keep it" }],
    allows_text: true,
  });
  await callTool("add_card", {
    kind: "offer",
    title: "Italian practice?",
    text: "Italian keeps coming up. Want a 15-minute lesson on Tuesday and Thursday evenings?",
    options: [{ label: "Yes", acts: true }, { label: "Not now" }],
  });
};

const offerTimes: Act["act"] = async (callTool) => {
  await callTool("add_card", {
    kind: "times",
    title: "Times for a call with Citadel",
    purpose: "A first call with Sarah at Citadel",
    slots: [
      { start: "2026-11-13T09:00:00.000Z", end: "2026-11-13T09:30:00.000Z", note: "WFH day" },
      { start: "2026-11-13T12:30:00.000Z", end: "2026-11-13T13:00:00.000Z", note: "WFH day" },
      { start: "2026-11-14T17:30:00.000Z", end: "2026-11-14T18:00:00.000Z" },
    ],
  });
};

const showInvite: Act["act"] = async (callTool) => {
  await callTool("show_invite", {});
};

const showMail: Act["act"] = async (callTool) => {
  await callTool("show_mail", {});
};

const briefNow: Act["act"] = async (callTool) => {
  await callTool("brief_now", {});
};

const deskScript = (text: string, start: readonly TimedEvent[]): Script | undefined => {
  const chosen = [
    { pattern: /\bdesk\b/u, act: fillDesk, said: "I've put a question and an offer on your Desk." },
    { pattern: /\btimes\b/u, act: offerTimes, said: "Pick the times that are clear at work; they're on your Desk." },
    { pattern: /\bbriefing\b/u, act: briefNow, said: "Your briefing is at the top of the Desk." },
    { pattern: /\binvite\b/u, act: showInvite, said: "Poppy's invite is on your Desk." },
    { pattern: /\bmail\b/u, act: showMail, said: "A booking came in; there's a draft for you on the Desk." },
  ].find(({ pattern }) => pattern.test(text));
  if (!chosen) return undefined;
  const actAt = lastAt(start) + 300;
  const reply = writeMessage("reply", chosen.said, actAt + 1200);
  return { events: [...start, ...reply, ending(reply, { type: "ended" })], acts: [{ at: actAt, act: chosen.act }] };
};

export const demoAnswers: Complete = (_prompt, schema) => {
  const fields = Object.keys(schema.properties ?? {});
  if (fields.includes("lines")) {
    return Promise.resolve(
      ok({
        lines: [
          { text: "Poppy sent the Teams link for Thursday; it's on the event.", card: "" },
          { text: "Body: easy 30 minutes or rest; big afternoon.", card: "" },
        ],
        handled: 9,
      }),
    );
  }
  if (fields.includes("changed")) return Promise.resolve(ok({ changed: false, label: "" }));
  return Promise.resolve(fail("The demo answers nothing for that."));
};

const motionScript = (text: string, start: readonly TimedEvent[]): Script | undefined => {
  const chosen = [
    { pattern: /\btrip\b/u, act: startTrip, said: `I've started Florence with Janki.\n\n${motionLine(florenceId)}` },
    { pattern: /\btraining\b/u, act: startTraining, said: `All ten weeks are in.\n\n${motionLine(sub20Id)}` },
    { pattern: /\bbooked\b/u, act: bookUffizi, said: "Lovely: the Uffizi is booked for 8:15 on Saturday." },
  ].find(({ pattern }) => pattern.test(text));
  if (!chosen) return undefined;
  const actAt = lastAt(start) + 300;
  const reply = writeMessage("reply", chosen.said, actAt + 1200);
  return { events: [...start, ...reply, ending(reply, { type: "ended" })], acts: [{ at: actAt, act: chosen.act }] };
};

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
  const remembering = memoryScript(text, start, now) ?? motionScript(text, start) ?? deskScript(text, start);
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
