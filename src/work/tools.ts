import { systemClock, toTimestamp, type Clock } from "#clock.ts";
import { ownCardChange, stillActing, type CardAnswer, type DeskKeeper, type NewCard } from "#desk/desk.ts";
import type { AskOption, Card, Message, Slot } from "#protocol/types.ts";
import { fieldOf, textOf } from "#tools/input.ts";
import type { Tool, ToolResult } from "#tools/mcp.ts";

export type WorkToolsOptions = {
  // Messages them in the main chat, or in a side thread; every message notifies them, and an urgent one breaks
  // through their Focus. A thread that isn't there gives undefined.
  readonly post: (text: string, isUrgent: boolean, place: PostPlace) => Message | undefined;
  readonly desk: DeskKeeper;
  // Whether a learning track is open, by id.
  readonly isTrack: (id: string) => boolean;
  readonly clock?: Clock;
};

// Where a post goes: an existing thread, a new thread with this title, or the main chat.
export type PostPlace = { readonly thread?: string; readonly newThread?: string };

const failed = (text: string): ToolResult => ({ text, isError: true });

const lineOf = (value: unknown, field: string): string => textOf(value, field).replaceAll(/\s+/gu, " ").trim();

const toOptions = (value: unknown): readonly AskOption[] =>
  (Array.isArray(value) ? (value as readonly unknown[]) : []).flatMap((option) => {
    const label = lineOf(option, "label");
    return label === "" ? [] : { label, ...(fieldOf(option, "acts") === true && { acts: true as const }) };
  });

const toSlots = (value: unknown): readonly Slot[] =>
  (Array.isArray(value) ? (value as readonly unknown[]) : []).flatMap((slot) => {
    const start = lineOf(slot, "start");
    const end = lineOf(slot, "end");
    const note = lineOf(slot, "note");
    return start === "" || end === "" ? [] : { start, end, ...(note !== "" && { note }) };
  });

// When a card stops mattering, as a timestamp, or the reason it can't be one.
const toUntil = (input: unknown, now: number): string | { readonly until?: string } => {
  const given = lineOf(input, "until");
  if (given === "") return {};
  const at = Date.parse(given);
  // With its offset, so it means one moment wherever the server runs.
  if (Number.isNaN(at) || !/T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/iu.test(given)) {
    return "Give until as a time with its offset, such as 2026-11-21T19:00:00Z.";
  }
  return at <= now ? "That until has already passed: the card wouldn't help any more." : { until: toTimestamp(at) };
};

const toCard = (input: unknown, now: number): NewCard | string => {
  const title = lineOf(input, "title");
  if (title === "") return "Give the card a title of one line.";
  const kind = lineOf(input, "kind");
  const text = lineOf(input, "text");
  const options = toOptions(fieldOf(input, "options"));
  const until = toUntil(input, now);
  if (typeof until === "string") return until;
  const motion = lineOf(input, "motion");
  const common = {
    title,
    allows_text: fieldOf(input, "allows_text") === true,
    ...until,
    ...(motion !== "" && { motion }),
  };
  switch (kind) {
    case "question": {
      return text === ""
        ? "A question card needs its question as text."
        : { ...common, kind, options: [...options], question: { text } };
    }
    case "offer": {
      if (text === "") return "An offer card needs its offer as text.";
      return {
        ...common,
        kind,
        options: options.length > 0 ? [...options] : [{ label: "Yes", acts: true }, { label: "Not now" }],
        offer: { text },
      };
    }
    case "times": {
      const slots = toSlots(fieldOf(input, "slots"));
      const purpose = lineOf(input, "purpose");
      if (purpose === "" || slots.length === 0) return "A times card needs its purpose and one to five slots.";
      return {
        ...common,
        kind,
        allows_text: true,
        options: options.length > 0 ? [...options] : [{ label: "Draft it", acts: true }],
        times: { purpose, slots: slots.slice(0, 5) },
      };
    }
    default: {
      return "A card is a question, an offer or times to check. Drafts and invites come from mail and the calendar.";
    }
  }
};

// A waiting card as the input that would make it, so a change gives only what's new.
const inputOf = (card: Card): Readonly<Record<string, unknown>> => ({
  kind: card.kind,
  title: card.title,
  allows_text: card.allows_text,
  options: card.options,
  ...(card.motion !== undefined && { motion: card.motion }),
  ...(card.until !== undefined && { until: card.until }),
  ...(card.question && { text: card.question.text }),
  ...(card.offer && { text: card.offer.text }),
  ...(card.times && { purpose: card.times.purpose, slots: card.times.slots }),
});

const toAnswer = (input: unknown): CardAnswer | string => {
  const option = lineOf(input, "option");
  const text = textOf(input, "text").trim();
  const slots = fieldOf(input, "slots");
  const given = [option !== "", text !== "", Array.isArray(slots)].filter(Boolean).length;
  if (given !== 1) return "Give their answer as one of option, slots or text.";
  if (option !== "") return { option };
  if (text !== "") return { text };
  const indexes = (slots as readonly unknown[]).filter(
    (index): index is number => Number.isSafeInteger(index) && (index as number) >= 0,
  );
  return indexes.length === 0 ? "Give slots as the indexes of the times that are clear, from 0." : { slots: indexes };
};

// What waits on them now, after a change, so Kumo can tell the Desk is as it means it to be.
const waitingNow = (desk: DeskKeeper): string => {
  const waiting = desk.cards();
  return waiting.length === 0
    ? "Nothing waits on them now."
    : `${String(waiting.length)} wait${waiting.length === 1 ? "s" : ""} on them now: ${waiting
        .map(({ id, title }) => `${title} (${id})`)
        .join(", ")}.`;
};

const untilSchema = {
  type: "string",
  description:
    "When it stops mattering, as a time with its offset, such as the evening a question about getting to an " +
    "event is for: it leaves the Desk by itself then. Leave it out for a card that waits however long it takes.",
};

export const createWorkTools = ({ post, desk, isTrack, clock = systemClock }: WorkToolsOptions): readonly Tool[] => [
  {
    name: "post",
    title: "Message them",
    audience: "work",
    description:
      "Message the person, such as a snag in their plans or how something went: it notifies their phone at once, and " +
      "their Focus decides whether it makes a sound. One message per thing, in plain words; say nothing when nothing's " +
      "worth their attention. What's about one of their open threads goes in that thread (`thread`), which moves to " +
      "the end of their chat with your line; something new that will need its own back-and-forth, such as a booking " +
      "you're chasing, can start a thread (`new_thread`). Everything else goes in the main chat.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "One or two lines, plain words." },
        thread: { type: "string", description: "The id of the open thread it's about, from <threads>." },
        new_thread: { type: "string", description: "Start a thread for it with this title, of one to five words." },
        urgent: {
          type: "boolean",
          description:
            "Only for what truly can't wait, such as a same-day change, a security alert, or something blocked on " +
            "them with a deadline: it's sent time-sensitive, so it breaks through their Focus.",
        },
      },
      required: ["text"],
      additionalProperties: false,
    },
    call: (input) => {
      const text = textOf(input, "text").trim();
      if (text === "") return Promise.resolve(failed("Give the message's text."));
      const thread = textOf(input, "thread").trim();
      const newThread = textOf(input, "new_thread").replaceAll(/\s+/gu, " ").trim();
      if (thread !== "" && newThread !== "")
        return Promise.resolve(failed("Post in a thread, or start one: not both."));
      if (newThread.split(" ").length > 5) return Promise.resolve(failed("A thread's title is one to five words."));
      const message = post(text, fieldOf(input, "urgent") === true, {
        ...(thread !== "" && { thread }),
        ...(newThread !== "" && { newThread }),
      });
      if (!message) return Promise.resolve(failed(`There's no thread ${thread}.`));
      return Promise.resolve({
        text: message.thread === undefined ? `Sent as ${message.id}.` : `Sent as ${message.id}, in ${message.thread}.`,
      });
    },
  },
  {
    name: "add_card",
    title: "Put a card on the Desk",
    audience: "work",
    description:
      "Put a card in Waiting on you: a `question` when you're not sure (such as whether a mail you binned was right), " +
      "an `offer` of something you'd take on (such as lessons for something that keeps coming up), or `times` for them " +
      "to check against their work calendar.",
    inputSchema: {
      type: "object",
      properties: {
        kind: { enum: ["question", "offer", "times"] },
        title: { type: "string", description: "One line, such as “Binned a Revolut mail”." },
        text: { type: "string", description: "question and offer: what you're asking or offering." },
        options: {
          type: "array",
          items: {
            type: "object",
            properties: { label: { type: "string" }, acts: { type: "boolean" } },
            required: ["label"],
            additionalProperties: false,
          },
        },
        allows_text: { type: "boolean" },
        purpose: { type: "string", description: "times: such as “A first call with Clara at Northwind”." },
        slots: {
          type: "array",
          items: {
            type: "object",
            properties: { start: { type: "string" }, end: { type: "string" }, note: { type: "string" } },
            required: ["start", "end"],
            additionalProperties: false,
          },
        },
        until: untilSchema,
      },
      required: ["kind", "title"],
      additionalProperties: false,
    },
    call: (input) => {
      const card = toCard(input, clock.now());
      if (typeof card === "string") return Promise.resolve(failed(card));
      const added = desk.addCard(card);
      return Promise.resolve({
        text: `Put ${added.title} on the Desk as ${added.id}. ${waitingNow(desk)}`,
        structured: { card: added.id },
      });
    },
  },
  {
    name: "change_card",
    title: "Change a card on the Desk",
    description:
      "Change a question, offer or times card while it waits, such as its words once things moved on, new times, " +
      "or when it stops mattering; give only what changes. It keeps its place, marked changed. A draft changes " +
      "by drafting it again; an invite is answered or cleared.",
    inputSchema: {
      type: "object",
      properties: {
        card: { type: "string", description: "The card's id, such as k_…" },
        title: { type: "string" },
        text: { type: "string", description: "question and offer: what you're asking or offering now." },
        options: {
          type: "array",
          items: {
            type: "object",
            properties: { label: { type: "string" }, acts: { type: "boolean" } },
            required: ["label"],
            additionalProperties: false,
          },
        },
        allows_text: { type: "boolean" },
        purpose: { type: "string", description: "times: what the times are for." },
        slots: {
          type: "array",
          items: {
            type: "object",
            properties: { start: { type: "string" }, end: { type: "string" }, note: { type: "string" } },
            required: ["start", "end"],
            additionalProperties: false,
          },
        },
        until: untilSchema,
      },
      required: ["card"],
      additionalProperties: false,
    },
    call: (input) => {
      const id = lineOf(input, "card");
      const card = desk.cards().find((waiting) => waiting.id === id);
      if (!card) return Promise.resolve(failed(`No card ${id} is waiting on them. ${waitingNow(desk)}`));
      if (desk.isOwnCard(card)) return Promise.resolve(failed(ownCardChange(card)));
      const given = Object.fromEntries(
        Object.entries(input as Readonly<Record<string, unknown>>).filter(([field]) => field !== "card"),
      );
      if (Object.keys(given).length === 0) return Promise.resolve(failed("Give what changes."));
      const fresh = toCard({ ...inputOf(card), ...given }, clock.now());
      if (typeof fresh === "string") return Promise.resolve(failed(fresh));
      const changed = desk.changeCard(id, fresh);
      if (!changed.ok) return Promise.resolve(failed(changed.failure));
      const { title, question, offer, times, options, until } = changed.value;
      const shows = [
        question?.text ?? offer?.text ?? times?.purpose,
        times && `${String(times.slots.length)} time${times.slots.length === 1 ? "" : "s"}`,
        options.length > 0 && `options ${options.map(({ label }) => label).join(", ")}`,
        until !== undefined && `leaves by itself at ${until}`,
      ].filter(Boolean);
      return Promise.resolve({ text: `It shows ${title}: ${shows.join("; ")}.` });
    },
  },
  {
    name: "answer_card",
    title: "Answer a card for them",
    description:
      "Answer a card on their Desk for them, once they've settled it with you in the chat, with what they said: " +
      "only ever their own answer, never your guess. A draft, an invite or one of Ito's own questions is acted on " +
      "as their tap would be, such as dropping the draft or accepting the invite; any other card is settled at once " +
      "and recorded in Done, and acting on it is up to you.",
    inputSchema: {
      type: "object",
      properties: {
        card: { type: "string", description: "The card's id, such as k_…" },
        option: { type: "string", description: "The label of the option they chose." },
        slots: {
          type: "array",
          items: { type: "integer", minimum: 0 },
          description: "times: the indexes of the times that are clear for them, from 0.",
        },
        text: { type: "string", description: "Their answer in a line, when no option fits; for a draft, the change." },
      },
      required: ["card"],
      additionalProperties: false,
    },
    call: (input) => {
      const answer = toAnswer(input);
      if (typeof answer === "string") return Promise.resolve(failed(answer));
      const id = lineOf(input, "card");
      const card = desk.cards().find((waiting) => waiting.id === id);
      const answered = desk.answerFor(id, answer);
      if (!answered.ok) return Promise.resolve(failed(answered.failure));
      return Promise.resolve({
        text:
          answered.value === "acting"
            ? `Answered ${card?.title ?? id} for them; it's being acted on as their tap would be, and leaves the Desk ` +
              "once that's done, or comes back saying why it couldn't."
            : `Answered ${card?.title ?? id} for them and took it off the Desk. Nothing else acts on it, so do what ` +
              `follows yourself. ${waitingNow(desk)}`,
      });
    },
  },
  {
    name: "clear_card",
    title: "Take a card off the Desk",
    description:
      "Take any card off Waiting on you once it's settled or can't help any more, such as a question they answered " +
      "in the chat or in their own mail, a draft they sent, binned or replaced, or a plan whose moment passed. It's " +
      "recorded in their Done list with the reason. It only leaves the Desk: a draft stays wherever it is in their " +
      "mail, and nothing is sent or deleted.",
    inputSchema: {
      type: "object",
      properties: {
        card: { type: "string", description: "The card's id, such as k_…" },
        reason: { type: "string", description: "Why it's settled, in a line." },
      },
      required: ["card", "reason"],
      additionalProperties: false,
    },
    call: (input) => {
      const id = lineOf(input, "card");
      const card = desk.cards().find((waiting) => waiting.id === id);
      if (!card) return Promise.resolve(failed(`No card ${id} is waiting on them. ${waitingNow(desk)}`));
      if (card.state === "working") return Promise.resolve(failed(stillActing(card)));
      const reason = lineOf(input, "reason");
      desk.removeCard(card.id);
      desk.addDone({
        text: `Took “${card.title}” off Waiting on you`,
        ...(reason !== "" && { reason }),
        ...(card.motion !== undefined && { motion: card.motion }),
        quiet: false,
      });
      const caveat =
        card.kind === "draft"
          ? " The draft itself is untouched: if it's still in their Drafts and should go, drop_draft takes it out."
          : card.kind === "invite"
            ? " The invite itself is unanswered: if it's still waiting in their calendar, it comes back on the next " +
              "look, so answer it with answer_card instead."
            : "";
      return Promise.resolve({ text: `Took ${card.title} off the Desk.${caveat} ${waitingNow(desk)}` });
    },
  },
  {
    name: "done",
    title: "Record what you did",
    audience: "work",
    description:
      "Record one thing you did without the person, for their Done list, with why in a line, so they can see it " +
      "and tell you when you got it wrong. Name the track when it's in an area you're learning.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string" },
        reason: { type: "string" },
        track: { type: "string", description: "The learning track it belongs to, by id." },
      },
      required: ["text"],
      additionalProperties: false,
    },
    call: (input) => {
      const text = lineOf(input, "text");
      if (text === "") return Promise.resolve(failed("Say what you did."));
      const reason = lineOf(input, "reason");
      const track = lineOf(input, "track");
      if (track !== "" && !isTrack(track)) return Promise.resolve(failed(`There's no track ${track}.`));
      const entry = desk.addDone({
        text,
        ...(reason !== "" && { reason }),
        ...(track !== "" && { track }),
        quiet: false,
      });
      return Promise.resolve({ text: `Recorded ${entry.id}.` });
    },
  },
];
