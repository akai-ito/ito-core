import { createCell } from "#cell.ts";
import type { DeskKeeper, NewCard } from "#desk/desk.ts";
import type { AskOption, Slot } from "#protocol/types.ts";
import type { Store } from "#store/store.ts";
import { contextRun } from "#tools/context.ts";
import { fieldOf, textOf } from "#tools/input.ts";
import type { Tool, ToolResult } from "#tools/mcp.ts";

export type WorkToolsOptions = {
  readonly store: Pick<Store, "postMessage">;
  readonly desk: DeskKeeper;
  readonly markUrgent?: (isUrgent: boolean) => void;
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

const notUrgent = (): void => undefined;

export const createWorkTools = ({ store, desk, markUrgent = notUrgent }: WorkToolsOptions): readonly Tool[] => {
  const posted = createCell<ReadonlySet<string>>(new Set());
  return [
    {
      name: "post",
      title: "Post into the conversation",
      audience: "work",
      description:
        "Post one short message into the conversation, for something the person should know now, such as a " +
        "snag in their plans. At most once per piece of work.",
      inputSchema: {
        type: "object",
        properties: {
          text: { type: "string", description: "One or two lines, plain words." },
          urgent: {
            type: "boolean",
            description: "Only when it can't wait: the notification sounds whatever the hour.",
          },
        },
        required: ["text"],
        additionalProperties: false,
      },
      call: (input) => {
        const run = contextRun() ?? "";
        const text = textOf(input, "text").trim();
        if (text === "") return Promise.resolve(failed("Give the message's text."));
        if (posted.get().has(run)) return Promise.resolve(failed("You've already posted once for this work."));
        posted.update((current) => new Set([...current, run]));
        markUrgent(fieldOf(input, "urgent") === true);
        const message = store.postMessage(text);
        markUrgent(false);
        return Promise.resolve({ text: `Posted into the conversation as ${message.id}.` });
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
          purpose: { type: "string", description: "times: such as “A first call with Sarah at Citadel”." },
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
      name: "done",
      title: "Record what you did",
      audience: "work",
      description: "Record one thing you did without the person, for their Done list, with why in a line.",
      inputSchema: {
        type: "object",
        properties: { text: { type: "string" }, reason: { type: "string" } },
        required: ["text"],
        additionalProperties: false,
      },
      call: (input) => {
        const text = lineOf(input, "text");
        if (text === "") return Promise.resolve(failed("Say what you did."));
        const reason = lineOf(input, "reason");
        const entry = desk.addDone({ text, ...(reason !== "" && { reason }), quiet: false });
        return Promise.resolve({ text: `Recorded ${entry.id}.` });
      },
    },
  ];
};
