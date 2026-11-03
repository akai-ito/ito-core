import type { DeskKeeper, NewCard } from "#desk/desk.ts";
import type { AskOption, Message, Slot } from "#protocol/types.ts";
import { fieldOf, textOf } from "#tools/input.ts";
import type { Tool, ToolResult } from "#tools/mcp.ts";

export type WorkToolsOptions = {
  // Messages them in the conversation; every message notifies them, and an urgent one breaks through Focus.
  readonly post: (text: string, isUrgent: boolean) => Message;
  readonly desk: DeskKeeper;
  // Whether a learning track is open, by id.
  readonly isTrack: (id: string) => boolean;
};

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

const toCard = (input: unknown): NewCard | string => {
  const title = lineOf(input, "title");
  if (title === "") return "Give the card a title of one line.";
  const kind = lineOf(input, "kind");
  const text = lineOf(input, "text");
  const options = toOptions(fieldOf(input, "options"));
  const common = { title, allows_text: fieldOf(input, "allows_text") === true };
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

export const createWorkTools = ({ post, desk, isTrack }: WorkToolsOptions): readonly Tool[] => [
  {
    name: "post",
    title: "Message them",
    audience: "work",
    description:
      "Message the person in the conversation, such as a snag in their plans or how something went: it notifies " +
      "their phone at once, and their Focus decides whether it makes a sound. One message per thing, in plain words; " +
      "say nothing when nothing's worth their attention.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "One or two lines, plain words." },
        urgent: {
          type: "boolean",
          description: "Only when it can't wait: it's sent time-sensitive, so it breaks through their Focus.",
        },
      },
      required: ["text"],
      additionalProperties: false,
    },
    call: (input) => {
      const text = textOf(input, "text").trim();
      if (text === "") return Promise.resolve(failed("Give the message's text."));
      const message = post(text, fieldOf(input, "urgent") === true);
      return Promise.resolve({ text: `Sent as ${message.id}.` });
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
      },
      required: ["kind", "title"],
      additionalProperties: false,
    },
    call: (input) => {
      const card = toCard(input);
      if (typeof card === "string") return Promise.resolve(failed(card));
      const added = desk.addCard(card);
      return Promise.resolve({ text: `Put ${added.title} on the Desk as ${added.id}.` });
    },
  },
  {
    name: "clear_card",
    title: "Take a card off the Desk",
    audience: "work",
    description:
      "Take a question, offer or times card off Waiting on you once it's settled without them, such as when " +
      "they answered it in their own mail. It's recorded in their Done list with the reason.",
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
      if (!card) return Promise.resolve(failed(`No card ${id} is waiting on them.`));
      if (card.kind === "draft" || card.kind === "invite") {
        return Promise.resolve(failed("A draft goes with drop_draft, and an invite once it's answered."));
      }
      const reason = lineOf(input, "reason");
      desk.removeCard(card.id);
      desk.addDone({
        text: `Took “${card.title}” off Waiting on you`,
        ...(reason !== "" && { reason }),
        ...(card.motion !== undefined && { motion: card.motion }),
        quiet: false,
      });
      return Promise.resolve({ text: `Took ${card.title} off the Desk.` });
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
