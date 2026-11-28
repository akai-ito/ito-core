import type { DatabaseSync } from "node:sqlite";
import type { Attachments } from "#attachments/attachments.ts";
import { createCell } from "#cell.ts";
import { toTimestamp, type Clock } from "#clock.ts";
import { lastLine } from "#desk/desk.ts";
import type { Question, QuestionAnswer, QuestionReply, QuestionState } from "#protocol/types.ts";
import { fail, ok, type Result } from "#result.ts";
import type { Store } from "#store/store.ts";
import { fieldOf, stringsOf, textOf } from "#tools/input.ts";
import type { Tool, ToolResult } from "#tools/mcp.ts";
import type { Info } from "#turns/turns.ts";
import type { VoiceLoop } from "#voice/loop.ts";
import type { Tracks } from "#work/tracks.ts";

// Understanding you: what Kumo would like them to explain, as quiet questions on its learning tracks. Each says what
// Kumo already understands, the missing piece and why it would help, with honest possibilities to tap. Nothing about
// a question is due, overdue or loud: it never reaches the Desk or a notification. An answer, tapped, written or
// spoken, is enough: it becomes evidence on its track, and Kumo files what it learned in the background, with no
// follow-up. Kumo settles a question it learned the answer to elsewhere, and drops one that no longer helps.
export type Questions = {
  // The open questions: those not set aside first, oldest first, then those they said "Not now" to.
  readonly open: () => readonly Question[];
  // The questions answered or settled lately, newest first.
  readonly recent: () => readonly Question[];
  readonly answer: (id: string, reply: QuestionReply) => Result<Question, string>;
  readonly notNow: (id: string) => Result<Question, string>;
  readonly tools: readonly Tool[];
  readonly inMindText: () => string;
  // Resolves once the answers being heard and filed now are done.
  readonly settled: () => Promise<void>;
  readonly close: () => void;
};

export type QuestionsOptions = {
  readonly database: DatabaseSync;
  readonly store: Pick<Store, "recordQuestion" | "findAttachment" | "keepAttachment" | "subscribe">;
  readonly attachments: Pick<Attachments, "pathOf">;
  readonly voice: Pick<VoiceLoop, "readiness" | "transcribe">;
  readonly tracks: Pick<Tracks, "find" | "answered">;
  readonly clock: Clock;
  readonly identifiers: { readonly question: () => string };
  readonly work: (prompt: string) => Promise<Result<string, string>>;
  readonly info: Info;
};

// A few at a time, so the page stays quiet.
const openPerTrack = 5;
const mostOptions = 6;
const dayMs = 24 * 60 * 60 * 1000;
const recentMs = 14 * dayMs;
// What they answered, or Kumo settled, lately is never asked again.
const rememberedMs = 90 * dayMs;
const inMindKept = 10;
const sameWords = 0.6;

const limits = { understood: 500, missing: 200, why: 200, option: 80, note: 200 } as const;

// Words too common to tell two questions apart.
const commonWords: ReadonlySet<string> = new Set([
  "the",
  "and",
  "you",
  "your",
  "what",
  "when",
  "how",
  "for",
  "with",
  "that",
  "this",
  "are",
  "does",
  "about",
  "would",
  "most",
  "more",
  "which",
  "who",
  "why",
  "can",
]);

// A spoken answer is short, so how far through it the voice is goes untold.
const ignore = (): void => undefined;

const failed = (text: string): ToolResult => ({ text, isError: true });

const lineOf = (value: unknown, field: string): string => textOf(value, field).replaceAll(/\s+/gu, " ").trim();

const clip = (text: string, length: number): string => (text.length > length ? `${text.slice(0, length - 1)}…` : text);

const dayOf = (at: string): string => at.slice(0, 10);

const wordsOf = (text: string): ReadonlySet<string> =>
  new Set(
    (text.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? []).filter((word) => word.length > 2 && !commonWords.has(word)),
  );

// Whether two questions ask the same thing: most of their telling words are shared.
const isSameAsk = (left: string, right: string): boolean => {
  const one = wordsOf(left);
  const other = wordsOf(right);
  const shared = [...one].filter((word) => other.has(word)).length;
  const all = one.size + other.size - shared;
  return all === 0 ? left.trim().toLowerCase() === right.trim().toLowerCase() : shared / all >= sameWords;
};

const stateWords: Readonly<Record<QuestionState, string>> = {
  open: "open",
  answered: "answered",
  settled: "settled",
  dropped: "dropped",
};

// What they said, in a line: the options they tapped, none fit or not sure, and their words.
export const answerWords = (answer: QuestionAnswer, length = 160): string =>
  [
    ...(answer.picked === undefined ? [] : [answer.picked.join(", ")]),
    ...(answer.none_fit === true ? ["none of the options fit"] : []),
    ...(answer.not_sure === true ? ["not sure"] : []),
    ...(answer.text === undefined ? [] : [`“${clip(answer.text.replaceAll(/\s+/gu, " ").trim(), length)}”`]),
  ].join("; ");

type Given = Omit<QuestionAnswer, "at">;

// Their reply, checked against the question.
const toGiven = (question: Question, reply: QuestionReply): Result<Given, string> => {
  const picked = [...new Set((reply.picked ?? []).map((option) => option.trim()).filter((option) => option !== ""))];
  const text = reply.text?.trim() ?? "";
  const audio = reply.audio?.trim() ?? "";
  const stranger = picked.find((option) => !question.options.includes(option));
  if (stranger !== undefined) return fail(`“${stranger}” isn't one of this question's options.`);
  if (text !== "" && audio !== "") return fail("Send your words as text or as a recording, not both.");
  if (reply.none_fit === true && picked.length > 0) return fail("None fit doesn't go with options you picked.");
  const given: Given = {
    ...(picked.length > 0 && { picked }),
    ...(text !== "" && { text }),
    ...(audio !== "" && { audio }),
    ...(reply.none_fit === true && { none_fit: true as const }),
    ...(reply.not_sure === true && { not_sure: true as const }),
  };
  return Object.keys(given).length === 0
    ? fail("Pick an option, say it in your words, or say none fit or not sure.")
    : ok(given);
};

// What was sent, to tell the same answer sent again, such as a retry: a spoken answer's heard words weren't sent.
const sentOf = (answer: Given): string =>
  JSON.stringify([
    answer.picked ?? [],
    answer.audio === undefined ? (answer.text ?? "") : "",
    answer.audio ?? "",
    answer.none_fit === true,
    answer.not_sure === true,
  ]);

const filingPrompt = (question: Question, answer: QuestionAnswer, track: string): string =>
  [
    `They answered one of your questions in Understanding you, on your ${track} track.`,
    `What you understood: ${question.understood}`,
    `What you asked: ${question.missing}`,
    `Why it would help: ${question.why}`,
    ...(question.options.length > 0 ? [`The options you offered: ${question.options.join(" · ")}`] : []),
    ...(answer.picked === undefined ? [] : [`They picked: ${answer.picked.join(" · ")}`]),
    ...(answer.none_fit === true ? ["They said none of your options fit."] : []),
    ...(answer.not_sure === true ? ["They said they're not sure."] : []),
    ...(answer.text === undefined
      ? []
      : [
          answer.audio === undefined
            ? `In their words: "${answer.text}"`
            : `They said it aloud; what the server heard, which may have small slips: "${answer.text}"`,
        ]),
    "File what you learned where it belongs in memory, as the memory style says: usually How to help you, or the",
    "page the area lives on, in their words where you can. Keep what happened, how they feel and your own reading",
    "apart: a feeling is theirs only when they said it, and an option they didn't pick, or a guess they weren't",
    "sure of, is not a fact.",
    "Let the answer be enough: don't ask them more about it, message them, add a card, or set a wake-up for it.",
    "If it also answers another of your open questions, settle that one with settle_question.",
    "End with one line, for them to read, saying what you took from it, such as “Weekends start slow: nothing",
    "booked before noon.”",
  ].join("\n");

export const createQuestions = (options: QuestionsOptions): Questions => {
  const { database, store, attachments, voice, tracks, clock, identifiers, work, info } = options;
  const now = (): string => toTimestamp(clock.now());
  const isClosed = createCell(false);
  const hearing = createCell<string | undefined>(undefined);
  const pending = createCell<Promise<void>>(Promise.resolve());

  const all = (): readonly Question[] =>
    (
      database.prepare("SELECT body FROM questions ORDER BY position").all() as unknown as readonly {
        readonly body: string;
      }[]
    ).map(({ body }) => JSON.parse(body) as Question);

  const find = (id: string): Question | undefined => {
    const row = database.prepare("SELECT body FROM questions WHERE id = ?").get(id) as
      { readonly body: string } | undefined;
    return row ? (JSON.parse(row.body) as Question) : undefined;
  };

  const save = (question: Question): Question => {
    database
      .prepare(
        `INSERT INTO questions (id, position, body) VALUES (?, (SELECT COALESCE(MAX(position), 0) + 1 FROM questions), ?)
         ON CONFLICT (id) DO UPDATE SET body = excluded.body`,
      )
      .run(question.id, JSON.stringify(question));
    store.recordQuestion(question);
    return question;
  };

  // A question in a new state, keeping only the fields that state has.
  const moveTo = (
    before: Question,
    state: QuestionState,
    extra: Partial<Pick<Question, "later_at" | "unheard" | "answer" | "filed" | "note">> = {},
  ): Question => ({
    id: before.id,
    track: before.track,
    state,
    understood: before.understood,
    missing: before.missing,
    why: before.why,
    options: before.options,
    asked_at: before.asked_at,
    changed_at: now(),
    ...extra,
  });

  const background = (job: () => Promise<void>): void => {
    const running = (async (): Promise<void> => {
      try {
        await job();
      } catch (error) {
        info("An answer in Understanding you couldn't be taken in", { error: String(error) });
      }
    })();
    void pending.update(async (previous) => {
      await Promise.all([previous, running]);
    });
  };

  // An answer they've given in full is evidence on its track, and Kumo files what it learned, quietly.
  const takeIn = (question: Question): void => {
    const { answer } = question;
    if (!answer) return;
    tracks.answered(
      question.track,
      `You answered “${clip(question.missing, 80)}”: ${answerWords(answer, 100)}`,
      question.id,
    );
    background(async () => {
      const filed = await work(filingPrompt(question, answer, tracks.find(question.track)?.name ?? "learning"));
      if (!filed.ok) {
        info("An answer in Understanding you couldn't be filed", { question: question.id, reason: filed.failure });
        return;
      }
      const line = lastLine(filed.value);
      const current = find(question.id);
      if (line !== "" && current?.state === "answered") save({ ...current, filed: line, changed_at: now() });
    });
  };

  const waitingToBeHeard = (): Question | undefined =>
    all().find(({ state, answer }) => state === "answered" && answer?.audio !== undefined && answer.text === undefined);

  // Spoken answers are heard on the server's GPU, one at a time; while the voice is away they wait for it.
  const hearNext = async (): Promise<void> => {
    if (isClosed.get() || hearing.get() !== undefined) return;
    const next = waitingToBeHeard();
    const audio = next?.answer?.audio;
    if (!next || audio === undefined || voice.readiness().state !== "ready") return;
    hearing.set(next.id);
    const heard = await voice.transcribe(audio, attachments.pathOf(audio), undefined, ignore);
    hearing.set(undefined);
    if (isClosed.get()) return;
    const current = find(next.id);
    if (current?.state === "answered" && current.answer !== undefined && current.answer.text === undefined) {
      if (heard.ok) {
        const text = heard.value.segments
          .map((segment) => segment.text.trim())
          .filter(Boolean)
          .join(" ");
        if (text === "") save(moveTo(current, "open", { unheard: "Nothing could be heard in your recording." }));
        else takeIn(save({ ...current, answer: { ...current.answer, text }, changed_at: now() }));
      } else if (heard.failure.code === "unavailable" || heard.failure.code === "cancelled") {
        // It waits for the voice to be ready again.
        return;
      } else {
        info("A spoken answer couldn't be heard", { question: current.id, reason: heard.failure.detail });
        save(moveTo(current, "open", { unheard: `Your recording couldn't be heard: ${heard.failure.detail}` }));
      }
    }
    await hearNext();
  };

  const hear = (): void => {
    background(hearNext);
  };

  const settled = async (): Promise<void> => {
    const current = pending.get();
    await current;
    if (pending.get() !== current) await settled();
  };

  const unsubscribe = store.subscribe(({ event }) => {
    if (event.type === "voice.status" && event.state === "ready") hear();
  });
  hear();

  const openNow = (): readonly Question[] => {
    const open = all().filter(({ state }) => state === "open");
    return [
      ...open.filter(({ later_at: later }) => later === undefined),
      ...open.filter(({ later_at: later }) => later !== undefined),
    ];
  };

  const recent = (): readonly Question[] => {
    const since = toTimestamp(clock.now() - recentMs);
    return all()
      .filter(({ state, changed_at: changed }) => (state === "answered" || state === "settled") && changed >= since)
      .toReversed()
      .toSorted((left, right) => right.changed_at.localeCompare(left.changed_at));
  };

  const trackName = (question: Question): string => tracks.find(question.track)?.name ?? question.track;

  const describe = (question: Question): string => {
    const track = trackName(question);
    switch (question.state) {
      case "open": {
        return (
          `${question.id} (${track}), asked ${dayOf(question.asked_at)}: ${question.missing} ` +
          `You understood: ${question.understood} Why: ${question.why}` +
          (question.options.length > 0 ? ` Options: ${question.options.join(" · ")}.` : "") +
          (question.later_at === undefined ? "" : ` They said not now on ${dayOf(question.later_at)}.`) +
          (question.unheard === undefined ? "" : " Their spoken answer couldn't be heard.")
        );
      }
      case "answered": {
        const said = question.answer === undefined ? "" : answerWords(question.answer);
        return (
          `${question.id} (${track}), answered ${dayOf(question.changed_at)}: ${question.missing} → ` +
          `${said === "" ? "being heard" : said}${question.filed === undefined ? "" : `. You filed: ${question.filed}`}`
        );
      }
      case "settled":
      case "dropped": {
        return (
          `${question.id} (${track}), ${stateWords[question.state]} ${dayOf(question.changed_at)}: ` +
          `${question.missing}${question.note === undefined ? "" : ` → ${question.note}`}`
        );
      }
    }
  };

  // An open question, for a tool that settles or drops it.
  const openOne = (input: unknown): Question | string => {
    const id = lineOf(input, "question");
    const question = find(id);
    if (!question) return `There's no question ${id}.`;
    return question.state === "open" ? question : `${id} is already ${stateWords[question.state]}.`;
  };

  const tools: readonly Tool[] = [
    {
      name: "add_question",
      title: "Ask something for Understanding you",
      description:
        "Ask them something you'd like them to explain, in Understanding you: a quiet page in Ito, grown out of " +
        "your learning tracks, where it waits with no due date and never notifies them or reaches the Desk. Ask " +
        "only what their own explanation can give you, such as what makes a weekend restful for them. First " +
        "recover what you can from your conversations, memory and sources, and ask only for the missing piece. Say " +
        "what you already understand and why the answer would help. When writing an answer would be effort, offer " +
        "a few honest possibilities as options for them to recognise or correct. Keep what happened, how they feel " +
        "and your own reading apart, and never offer a feeling as a fact. Keep to the few that matter: a track " +
        `holds at most ${String(openPerTrack)} open questions, and asking what you already asked gives you that one.`,
      inputSchema: {
        type: "object",
        properties: {
          track: { type: "string", description: "The track it belongs to, by id." },
          understood: {
            type: "string",
            description:
              "What you already understand, in a sentence or two, said to them: “You keep Sunday mornings free " +
              "and run long on Saturdays.”",
          },
          missing: {
            type: "string",
            description:
              "The missing piece, as one short question: “What makes a weekend feel restful rather than busy?”",
          },
          why: {
            type: "string",
            description: "Why it would help, in a line: “So the weekends I plan leave you rested, not just full.”",
          },
          options: {
            type: "array",
            items: { type: "string" },
            maxItems: mostOptions,
            description:
              `Up to ${String(mostOptions)} honest possibilities, a few words each, for them to tap; leave it out ` +
              "when only their words will do.",
          },
        },
        required: ["track", "understood", "missing", "why"],
        additionalProperties: false,
      },
      call: (input) => {
        const track = tracks.find(lineOf(input, "track"));
        if (!track) return Promise.resolve(failed("There's no such track: open one with open_track first."));
        const understood = lineOf(input, "understood");
        const missing = lineOf(input, "missing");
        const why = lineOf(input, "why");
        const offered = [
          ...new Set(stringsOf(input, "options").map((option) => option.replaceAll(/\s+/gu, " ").trim())),
        ];
        const choices = offered.filter((option) => option !== "");
        const tooLong = (
          [
            ["understood", understood],
            ["missing", missing],
            ["why", why],
          ] as const
        ).find(([field, text]) => text === "" || text.length > limits[field]);
        if (tooLong) {
          return Promise.resolve(failed(`Give ${tooLong[0]} in ${String(limits[tooLong[0]])} characters or fewer.`));
        }
        if (choices.some((option) => option.length > limits.option)) {
          return Promise.resolve(failed(`Keep each option to ${String(limits.option)} characters or fewer.`));
        }
        const remembered = toTimestamp(clock.now() - rememberedMs);
        const asked = all().find(
          (question) =>
            (question.state === "open" ||
              ((question.state === "answered" || question.state === "settled") && question.changed_at >= remembered)) &&
            isSameAsk(question.missing, missing),
        );
        if (asked) {
          return Promise.resolve({ text: `You've already asked that: ${describe(asked)}` });
        }
        const waiting = all().filter((question) => question.state === "open" && question.track === track.id);
        if (waiting.length >= openPerTrack) {
          return Promise.resolve(
            failed(
              `${track.name} already has ${String(openPerTrack)} open questions. Drop one that no longer helps, or ` +
                "let them answer first.",
            ),
          );
        }
        const at = now();
        const question = save({
          id: identifiers.question(),
          track: track.id,
          state: "open",
          understood,
          missing,
          why,
          options: choices,
          asked_at: at,
          changed_at: at,
        });
        return Promise.resolve({
          text: `Added ${question.id} to ${track.name}. It waits quietly for them in Understanding you.`,
        });
      },
    },
    {
      name: "settle_question",
      title: "Settle a question",
      description:
        "Settle an open question in Understanding you once you've learned its answer elsewhere, such as in the " +
        "chat or their mail, with a short note on where. File what you learned in memory as usual.",
      inputSchema: {
        type: "object",
        properties: {
          question: { type: "string" },
          note: {
            type: "string",
            description: "Where you learned it, in a line for them: “You said in the chat that sleep comes first.”",
          },
        },
        required: ["question", "note"],
        additionalProperties: false,
      },
      call: (input) => {
        const question = openOne(input);
        if (typeof question === "string") return Promise.resolve(failed(question));
        const note = lineOf(input, "note");
        if (note === "" || note.length > limits.note) {
          return Promise.resolve(failed(`Say where you learned it, in ${String(limits.note)} characters or fewer.`));
        }
        save(moveTo(question, "settled", { note }));
        return Promise.resolve({ text: `Settled ${question.id}.` });
      },
    },
    {
      name: "drop_question",
      title: "Drop a question",
      description:
        "Drop an open question in Understanding you that no longer helps, such as one about a plan that has " +
        "passed. Never drop one only because it has waited: questions are meant to wait.",
      inputSchema: {
        type: "object",
        properties: {
          question: { type: "string" },
          why: { type: "string", description: "Why, in a line." },
        },
        required: ["question", "why"],
        additionalProperties: false,
      },
      call: (input) => {
        const question = openOne(input);
        if (typeof question === "string") return Promise.resolve(failed(question));
        const why = lineOf(input, "why");
        if (why === "" || why.length > limits.note) {
          return Promise.resolve(failed(`Say why, in ${String(limits.note)} characters or fewer.`));
        }
        save(moveTo(question, "dropped", { note: why }));
        return Promise.resolve({ text: `Dropped ${question.id}.` });
      },
    },
    {
      name: "list_questions",
      title: "List your questions",
      description:
        "List the questions waiting in Understanding you, with what you understood, the missing piece and why, " +
        "and what they answered or you settled lately; give track for one track's only.",
      inputSchema: {
        type: "object",
        properties: { track: { type: "string", description: "Only this track's, by id." } },
        additionalProperties: false,
      },
      call: (input) => {
        const track = fieldOf(input, "track") === undefined ? undefined : lineOf(input, "track");
        if (track !== undefined && !tracks.find(track)) return Promise.resolve(failed("There's no such track."));
        const mine = (question: Question): boolean => track === undefined || question.track === track;
        const open = openNow().filter(mine);
        const lately = recent().filter(mine);
        if (open.length === 0 && lately.length === 0) {
          return Promise.resolve({ text: "No questions are waiting, and none were answered lately." });
        }
        return Promise.resolve({
          text: [
            ...(open.length === 0
              ? ["No questions are waiting."]
              : ["Waiting:", ...open.map((q) => `- ${describe(q)}`)]),
            ...(lately.length === 0 ? [] : ["Answered or settled lately:", ...lately.map((q) => `- ${describe(q)}`)]),
          ].join("\n"),
        });
      },
    },
  ];

  return {
    open: openNow,
    recent,
    answer: (id, reply) => {
      const question = find(id);
      if (!question || question.state === "dropped") return fail("not_found");
      const given = toGiven(question, reply);
      if (!given.ok) return given;
      if (question.state !== "open") {
        return question.answer !== undefined && sentOf(question.answer) === sentOf(given.value)
          ? ok(question)
          : fail(`That question is already ${stateWords[question.state]}.`);
      }
      const { audio } = given.value;
      if (audio !== undefined && store.findAttachment(audio)?.attachment.kind !== "audio") {
        return fail("That recording isn't on the server: upload it first.");
      }
      // A voice that's loading hears it once it's ready; one that has failed can't, so it's not taken.
      if (audio !== undefined && voice.readiness().state === "failed") {
        return fail("The server's voice isn't running, so it can't hear a spoken answer now. Write it instead.");
      }
      if (audio !== undefined) store.keepAttachment(audio);
      const answered = save(moveTo(question, "answered", { answer: { at: now(), ...given.value } }));
      if (audio === undefined) takeIn(answered);
      else hear();
      return ok(answered);
    },
    notNow: (id) => {
      const question = find(id);
      if (!question || question.state === "dropped") return fail("not_found");
      if (question.state !== "open") return fail(`That question is already ${stateWords[question.state]}.`);
      return ok(save({ ...question, later_at: now(), changed_at: now() }));
    },
    tools,
    inMindText: () => {
      const open = openNow();
      if (open.length === 0) return "";
      return [
        "<questions>",
        "What you've asked them in Understanding you, waiting quietly. Don't bring these up in the chat; when they",
        "answer one anywhere else, settle it with settle_question:",
        ...open
          .slice(0, inMindKept)
          .map((question) => `- ${question.id} (${trackName(question)}): ${question.missing}`),
        ...(open.length > inMindKept ? [`…and ${String(open.length - inMindKept)} more (list_questions).`] : []),
        "</questions>",
      ].join("\n");
    },
    settled,
    close: () => {
      isClosed.set(true);
      unsubscribe();
    },
  };
};
