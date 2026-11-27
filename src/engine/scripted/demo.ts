import { readFileSync } from "node:fs";
import type { Fetch } from "#capabilities/connect.ts";
import { createCell } from "#cell.ts";
import type { AskFields, Complete, Engine, EngineEvent, Input, StepFacts } from "#engine/engine.ts";
import { fail, ok } from "#result.ts";
import type { Act, CallTool, ScriptSource, TimedEvent } from "#engine/scripted/script-engine.ts";
import type { ToolResult } from "#tools/mcp.ts";
import { florenceId, florencePictures, florenceTrip, type FlorencePictures } from "#protocol/tools/florence.ts";
import {
  hybridContent,
  hybridId,
  projectContent,
  projectId,
  quietRoles,
  roleContent,
  roleId,
  springContent,
  springId,
  springStory,
} from "#protocol/tools/in-motion.ts";
import { sub20Id, sub20Training } from "#protocol/tools/sub20.ts";

const pieceMs = 70;

const shortReply = [
  "Here's a quick answer from the demo engine.",
  "",
  "- It streams a reply in small pieces, the way a real model does.",
  "- Send a message while it writes to try **steering**.",
  "- Include *busy* for a trail of steps, *long* for a long reply to stop, *fail* for a failure, *silent* for a quiet turn that works until you stop it, *ask* for a question, or *approve* for an approval.",
  "- *remember* writes Alex's page in memory (again: edits it, and the old state moves to Earlier) and adds to today's journal; *recall* looks Alex up.",
  "- *trip* starts Florence with Mira in In motion, *training* a sub-20 5K block, and *booked* books the trip's Uffizi.",
  "- *motion* fills In motion with a role, a hybrid block, a project and a goal that ended unmet.",
  "- *plan* lays out a day with Kumo's plan and guesses.",
  "- *menu* answers with shape (a table with verdicts, picks with pictures, a total), *guide* makes a page with " +
    "things to spot, and *cards* shows an event, a place, a Desk question and a person as cards.",
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

const weekMs = 7 * 24 * 60 * 60 * 1000;

const florenceStarts = Date.parse("2026-11-06T00:00:00.000Z");

// How far to move the trip so it starts one to two weeks from now, on the same weekdays: a trip whose last day is over
// ends by itself, so the demo's would otherwise go straight to History.
const tripShift = (now: number): number => Math.max(0, Math.ceil((now + weekMs - florenceStarts) / weekMs)) * weekMs;

// `2026-11-06`, moved on by `shift`.
const dayAfter = (day: string, shift: number): string =>
  new Date(Date.parse(`${day}T00:00:00.000Z`) + shift).toISOString().slice(0, 10);

// Every day and local time in it, moved on by `shift`.
const movedOn = (value: unknown, shift: number): unknown => {
  if (typeof value === "string") {
    const dated = /^(?<day>\d{4}-\d{2}-\d{2})(?<rest>.*)$/su.exec(value)?.groups;
    return dated?.day === undefined ? value : `${dayAfter(dated.day, shift)}${dated.rest ?? ""}`;
  }
  if (Array.isArray(value)) return value.map((item: unknown) => movedOn(item, shift));
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([field, item]) => [field, movedOn(item, shift)]));
  }
  return value;
};

// "6–9 Nov", or "30 Nov–3 Dec" across a month.
const tripDates = (shift: number): string => {
  const [start, end] = [florenceStarts + shift, florenceStarts + shift + 3 * 24 * 60 * 60 * 1000].map(
    (time) => new Date(time),
  ) as [Date, Date];
  const month = (date: Date): string => date.toLocaleString("en-GB", { month: "short", timeZone: "UTC" });
  return month(start) === month(end)
    ? `${String(start.getUTCDate())}–${String(end.getUTCDate())} ${month(end)}`
    : `${String(start.getUTCDate())} ${month(start)}–${String(end.getUTCDate())} ${month(end)}`;
};

const startTrip: Act["act"] = async (callTool) => {
  const kept = await Promise.all(
    florencePictures.map(async (name) => {
      const picture = await callTool("keep_image", { url: `${demoPictures}${name}.jpg` });
      return [name, String(picture.structured?.attachment)];
    }),
  );
  const shift = tripShift(Date.now());
  const trip = florenceTrip(Object.fromEntries(kept) as FlorencePictures);
  await callTool("start_motion", {
    id: florenceId,
    kind: "trip",
    title: "Florence with Mira",
    summary: `${tripDates(shift)} · 4 to book`,
    salience: "loud",
    content: movedOn(trip, shift),
    note: "Started the trip",
  });
};

const startTraining: Act["act"] = async (callTool) => {
  await callTool("start_motion", {
    id: sub20Id,
    kind: "body",
    title: "Sub-20 5K",
    summary: "Week 6 of 10 · intervals today",
    salience: "normal",
    content: sub20Training,
    note: "Started the block",
  });
};

// Every 0.19 shape at once: three roles, loudest first, a hybrid block, a project, and a goal ended unmet.
const fillInMotion: Act["act"] = async (callTool) => {
  const now = Date.now();
  await callTool("start_motion", {
    id: roleId,
    kind: "career",
    title: "Northwind",
    summary: "Virtual 1 · Python PR review",
    salience: "loud",
    content: roleContent(now),
    note: "Added Northwind to the pipeline",
  });
  for (const [index, { id, content, summary }] of quietRoles.entries()) {
    await callTool("start_motion", {
      id,
      kind: "career",
      title: String(content.org),
      summary,
      salience: index === 0 ? "normal" : "quiet",
      content,
      note: "Added it to the pipeline",
    });
  }
  await callTool("start_motion", {
    id: hybridId,
    kind: "body",
    title: "Hybrid restart",
    summary: "Three done this week. Saturday's easy run is the last.",
    salience: "loud",
    content: hybridContent(now),
    note: "Started the block",
  });
  await callTool("start_motion", {
    id: projectId,
    kind: "project",
    title: "Ito 0.19 · Lived-in",
    summary: "Design round 2 of 4 · In motion",
    salience: "normal",
    content: projectContent,
    note: "Started the release",
  });
  await callTool("start_motion", {
    id: springId,
    kind: "body",
    title: "Sub-20 5K",
    summary: "Training incomplete",
    salience: "normal",
    content: springContent,
    note: "Kept the goal",
  });
  await callTool("finish_motion", {
    id: springId,
    outcome: "not_met",
    summary: "Training incomplete, race not booked; a fresh hybrid plan followed.",
    story: springStory,
    note: "Ended the goal, unmet",
  });
};

const bookUffizi: Act["act"] = async (callTool) => {
  const read = await callTool("read_motion", { id: florenceId });
  const version = Number(/version (?<version>\d+)/u.exec(read.text)?.groups?.version);
  // The trip's first day, as the demo moved it.
  const starts = /"start": "(?<start>\d{4}-\d{2}-\d{2})"/u.exec(read.text)?.groups?.start ?? "2026-11-06";
  const booking = { status: "booked", ref: "UF-2291" };
  await callTool("change_motion", {
    id: florenceId,
    version,
    changes: [
      { set: "book-uffizi", fields: { done: true } },
      { set: "uffizi", fields: { booking } },
      { set: "uffizi-place", fields: { status: "booked", booking } },
    ],
    summary: `${tripDates(Date.parse(`${starts}T00:00:00.000Z`) - florenceStarts)} · 3 to book`,
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
    title: "Times for a call with Northwind",
    purpose: "A first call with Clara at Northwind",
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

const showGettingStarted: Act["act"] = async (callTool) => {
  await callTool("show_getting_started", {});
};

const showWork: Act["act"] = async (callTool) => {
  await callTool("show_work", {});
};

const showDay: Act["act"] = async (callTool) => {
  await callTool("show_day", {});
};

const demoPictureOf = async (
  callTool: CallTool,
  name: string,
  alt: string,
): Promise<Readonly<Record<string, string>>> => {
  const kept = await callTool("keep_image", { url: `${demoPictures}${name}.jpg` });
  return {
    attachment: String(kept.structured?.attachment),
    alt,
    source_url: `https://example.org/ito-demo/about/${name}`,
    credit: "Ito demo picture",
  };
};

const block = (kind: string, value: unknown): string => ["```ari:" + kind, JSON.stringify(value), "```"].join("\n");

const verdict = (label: string, tone: string): Readonly<Record<string, string>> => ({ label, tone });

// A menu answered with shape: the table with verdicts, picks with pictures, the total, and choices. It comes as a
// message of Kumo's, since its pictures are kept as it goes.
const showMenu: Act["act"] = async (callTool) => {
  const dishes = [
    ["Clay pot glass noodles", "£9.50", "What people come for: smoky, peppery, crab all through it."],
    ["Langoustine laab", "£11", "Bright and sharp, so it cuts the richness of the noodles."],
    ["Lamb skewers", "£8", "Two skewers, easy to split, properly charred."],
    ["Wild ginger greens", "£6.50", "Something green, since you said not too heavy."],
    ["Sticky rice × 2", "£7", "For the laab's juices. You'll want the second."],
  ] as const;
  const picks = await Promise.all(
    dishes.map(async ([name, detail, why], index) => ({
      name,
      detail,
      why,
      image: await demoPictureOf(callTool, `dish-${String(index + 1)}`, name),
    })),
  );
  const text = [
    "Good menu. It's northern Thai, cooked over wood, all small plates to share: four or five between two, plus rice.",
    "",
    block("table", {
      columns: ["Dish", "My take"],
      rows: [
        {
          name: "Clay pot glass noodles",
          detail: "Pork belly, brown crab, white pepper",
          verdict: verdict("Must try", "strong"),
        },
        {
          name: "Langoustine laab",
          detail: "Minced, toasted rice, herbs, lime",
          verdict: verdict("Must try", "strong"),
        },
        {
          name: "Lamb & cumin skewers",
          detail: "Aged lamb, charred over wood",
          verdict: verdict("Recommended", "good"),
        },
        { name: "Jungle curry", detail: "Pork, fiery, no coconut", verdict: verdict("If you like heat", "quiet") },
        { name: "Isaan sausage", detail: "Fermented pork, ginger, peanut", verdict: verdict("Skip today", "quiet") },
        { name: "Sticky rice", detail: "Steamed in a basket", verdict: verdict("Best value", "neutral") },
      ],
    }),
    "",
    block("picks", { title: "What I'd order", picks }),
    "",
    block("number", {
      label: "Estimated for two",
      value: "£47",
      context: "Five plates and rice. £53 with the 12.5% service.",
    }),
    "",
    "Want a drink matched to it, or is that the lot? Say hi to [Alex](memory:people/alex).",
    "",
    block("choices", { options: ["Add drinks", "Lighter swap", "That's the lot"] }),
  ].join("\n");
  await callTool("post", { text });
  // In a thread, its line in their list of threads; in the main chat there's none to keep.
  await callTool("update_thread", { result: "Noodles, laab, skewers · £47 for two" });
};

const guideRoom = (
  id: string,
  title: string,
  detail: string,
  items: readonly (readonly [string, string, string])[],
) => ({
  id,
  title,
  detail,
  items: items.map(([item, name, where]) => ({ id: item, title: name, detail: where })),
});

// A page Kumo made: a gallery guide with rooms that fold, things to spot and a place for coffee.
const makeGuide: Act["act"] = async (callTool) => {
  const cover = await demoPictureOf(callTool, "gallery", "The gallery's dome");
  const casts = await demoPictureOf(callTool, "casts", "The Cast Courts");
  await callTool("make_made_page", {
    id: "gallery-guide",
    title: "Your guide to the gallery",
    summary: "3 rooms · 4 things to spot",
    cover,
    content: {
      intro: [
        "Two hours, three rooms, in walking order from the main door. Coffee halfway.",
        "",
        block("place", {
          name: "The gallery",
          address: "Cromwell Road, London",
          note: "open till 17:45",
          lat: 51.4966,
          lon: -0.1722,
        }),
      ].join("\n"),
      check: "Spotted",
      sections: [
        {
          ...guideRoom("cast-courts", "Cast Courts", "Room 46a–b · 25 min", [
            ["column", "Trajan's Column", "Cut in two to fit under the roof. Find the join."],
            ["fig-leaf", "David's fig leaf", "Not on him: it hangs in a case behind."],
          ]),
          image: casts,
          text: "Plaster copies of great monuments, made so people who couldn't travel could still stand in front of them.",
        },
        guideRoom("south-asia", "South Asia", "Room 41 · 20 min", [
          ["tiger", "Tipu's Tiger", "A wooden tiger with an organ inside."],
        ]),
        guideRoom("fashion", "Fashion", "Room 40 · 20 min", [
          ["mantua", "The silk mantua", "So wide you went through doors sideways."],
        ]),
        {
          id: "halfway",
          title: "Halfway",
          numbered: false,
          text: block("place", {
            name: "The Morris Room",
            address: "Cromwell Road, London",
            note: "the first museum café",
          }),
        },
      ],
    },
  });
  await callTool("update_thread", { result: "3 rooms in walking order · 4 to spot" });
};

// The Desk card a tool put up: its id from the result's data, or else from its words, which go on after it.
const cardIn = ({ structured, text }: ToolResult): string => {
  const card = structured?.card;
  return typeof card === "string" ? card : (/\bas (?<card>k_[\w-]+)/u.exec(text)?.groups?.card ?? "");
};

// Action cards: a question on the Desk shown in the chat, an event to add, a place with Directions, and a person.
const showCards: Act["act"] = async (callTool) => {
  const added = await callTool("add_card", {
    kind: "question",
    title: "Walk in, or book?",
    text: "The restaurant only books for six or more. Walk in and queue, or find somewhere that books?",
    options: [{ label: "Walk in", acts: true }, { label: "Find one that books" }],
  });
  const card = cardIn(added);
  const mailed = await callTool("show_mail", {});
  const draft = cardIn(mailed);
  await callTool("post", {
    text: [
      "Thursday works: you're free after your 17:00 call. Here's the evening, and one question.",
      "",
      block("event", {
        title: "Dinner with Theo",
        start: "2026-11-27T19:30:00+00:00",
        end: "2026-11-27T21:30:00+00:00",
        place: "Saffron Lane, Soho",
      }),
      "",
      block("place", {
        name: "Saffron Lane",
        address: "Greek Street, London",
        note: "open till 23:00",
        lat: 51.5136,
        lon: -0.1318,
      }),
      "",
      block("desk", { card }),
      "",
      block("person", { page: alex }),
      "",
      "And the hotel note, which is in your Drafts:",
      "",
      block("desk", { card: draft }),
    ].join("\n"),
  });
  await callTool("update_thread", { result: "Thursday 19:30 · one question left" });
};

const deskScript = (text: string, start: readonly TimedEvent[]): Script | undefined => {
  const chosen = [
    { pattern: /\bdesk\b/u, act: fillDesk, said: "I've put a question and an offer on your Desk." },
    { pattern: /\btimes\b/u, act: offerTimes, said: "Pick the times that are clear at work; they're on your Desk." },
    { pattern: /\binvite\b/u, act: showInvite, said: "Tess's invite is on your Desk." },
    { pattern: /\bmail\b/u, act: showMail, said: "A booking came in; there's a draft for you on the Desk." },
    { pattern: /\bstart\b/u, act: showGettingStarted, said: "I've read your mail. Here's what I found." },
    { pattern: /\bwork\b/u, act: showWork, said: "Here's my day so far, in my work on the Desk." },
    { pattern: /\bplan\b/u, act: showDay, said: "Here's the shape of today: my plan and my guesses are in Coming up." },
    { pattern: /\bmenu\b/u, act: showMenu, said: "That's what I'd get for two." },
    {
      pattern: /\bguide\b/u,
      act: makeGuide,
      said: `I've made you a guide, in walking order, with things to spot in each room.\n\n${block("made", { made: "gallery-guide" })}`,
    },
    { pattern: /\bcards\b/u, act: showCards, said: "That's Thursday sorted, bar the question." },
  ].find(({ pattern }) => pattern.test(text));
  if (!chosen) return undefined;
  const actAt = lastAt(start) + 300;
  const reply = writeMessage("reply", chosen.said, actAt + 1200);
  return { events: [...start, ...reply, ending(reply, { type: "ended" })], acts: [{ at: actAt, act: chosen.act }] };
};

export const demoWork =
  (callTool: CallTool): Engine["work"] =>
  async (prompt, run) => {
    if (prompt.includes("You asked them on the Desk")) {
      return ok("Noted; nothing more was needed.");
    }
    if (prompt.includes("They told you this was wrong")) return ok("Noted on How to help you for next time.");
    if (!prompt.includes("Post your first question")) {
      return fail({ code: "engine_failed", detail: "The demo does no background work." });
    }
    await callTool("post", { text: "While I read: what would make the next month a good one for you?" }, run);
    return ok("Asked.");
  };

export const demoAnswers: Complete = (_prompt, schema) => {
  const fields = Object.keys(schema.properties ?? {});
  if (fields.includes("changed")) return Promise.resolve(ok({ changed: false, label: "" }));
  // A share goes in a thread of its own.
  if (fields.includes("thread")) return Promise.resolve(ok({ thread: "", title: "Something you shared" }));
  return Promise.resolve(fail("The demo answers nothing for that."));
};

const motionScript = (text: string, start: readonly TimedEvent[]): Script | undefined => {
  const chosen = [
    { pattern: /\btrip\b/u, act: startTrip, said: `I've started Florence with Mira.\n\n${motionLine(florenceId)}` },
    { pattern: /\btraining\b/u, act: startTraining, said: `All ten weeks are in.\n\n${motionLine(sub20Id)}` },
    { pattern: /\bbooked\b/u, act: bookUffizi, said: "Lovely: the Uffizi is booked for 8:15 on Saturday." },
    { pattern: /\bmotion\b/u, act: fillInMotion, said: "In motion has a bit of everything now." },
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

// A conversation hears of the posts it didn't see, such as the demo's own, before the person's words. Those aren't
// theirs, so the demo never answers a word in them.
const postNote = /\(Meanwhile, your background work posted this here: “[\s\S]*?”\)/gu;

const scriptFor = (inputs: readonly Input[], now: number): Script => {
  const text = inputs
    .map((input) => input.text.replaceAll(postNote, ""))
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
      // A word that does something, such as *trip*, waits to be its own turn, as a real model would act on it,
      // rather than being taken into this one with only a "Got it".
      if (scriptFor([input], steeredAt).acts !== undefined) return { outcome: "refused" };
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
