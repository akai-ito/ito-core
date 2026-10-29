import type { AskFields } from "#engine/engine.ts";
import type { AskOption } from "#protocol/types.ts";
import { fail, ok, type Result } from "#result.ts";
import type { Tool, ToolResult } from "#tools/mcp.ts";
import type { Turns } from "#turns/turns.ts";

export const askToolName = "ask";

const maxOptions = 6;
const maxLabelLength = 80;

const fieldOf = (value: unknown, field: string): unknown =>
  value && typeof value === "object" ? Reflect.get(value, field) : undefined;

const textOf = (value: unknown, field: string): string => {
  const text = fieldOf(value, field);
  return typeof text === "string" ? text.trim() : "";
};

const toOption = (value: unknown): AskOption | undefined => {
  const label = textOf(value, "label");
  if (label === "" || label.length > maxLabelLength) return undefined;
  const description = textOf(value, "description");
  return {
    label,
    ...(description && { description }),
    ...(fieldOf(value, "acts") === true && { acts: true }),
  };
};

export const toAskFields = (input: unknown): Result<AskFields, string> => {
  const question = textOf(input, "question");
  if (question === "") return fail("An ask needs a question.");
  const given = fieldOf(input, "options");
  const listed: readonly unknown[] = Array.isArray(given) ? given : [];
  const options = listed.map((option) => toOption(option));
  if (options.length > maxOptions) return fail(`An ask takes at most ${maxOptions} options.`);
  const valid = options.filter((option) => option !== undefined);
  if (valid.length < options.length) return fail(`Every option needs a label of at most ${maxLabelLength} characters.`);
  const isApproval = fieldOf(input, "kind") === "approval";
  const actingCount = valid.filter((option) => option.acts).length;
  if (isApproval && actingCount !== 1) return fail("An approval needs options, exactly one of them with acts: true.");
  const preview = textOf(input, "preview");
  return ok({
    kind: isApproval ? "approval" : "question",
    question,
    options: isApproval
      ? valid
      : valid.map((option) => ({
          label: option.label,
          ...(option.description && { description: option.description }),
        })),
    allows_text: valid.length === 0 || fieldOf(input, "allows_text") !== false,
    ...(isApproval && preview && { preview }),
  });
};

type Asking = Pick<Turns, "ask">;

const askFrom = (turns: Asking, input: unknown): ToolResult => {
  const fields = toAskFields(input);
  if (!fields.ok) return { text: fields.failure, isError: true };
  const asked = turns.ask(fields.value);
  return asked.ok
    ? { text: "Asked. Stop here: their answer arrives as their next message.", structured: { ask: asked.value.id } }
    : { text: "There's no turn to ask from right now.", isError: true };
};

export const createAskTool = (turns: Asking): Tool => ({
  name: askToolName,
  title: "Ask the person",
  description:
    "Ask the person something only they can tell you: which of several things they meant, a choice, or a " +
    "detail. Before anything consequential, such as booking, buying, sending or deleting, ask for their " +
    "approval: kind approval, a preview of exactly what would happen, and acts: true on the option that goes " +
    "ahead. Apps that change things, such as a calendar or mail, ask for approval themselves when they run, so " +
    "don't ask first for those. Never ask for a password or a code. Asking ends your turn, and their answer arrives as their next message. Don't ask what you can find out yourself.",
  inputSchema: {
    type: "object",
    properties: {
      question: { type: "string", description: "The question, in plain words." },
      options: {
        type: "array",
        maxItems: maxOptions,
        description: "Suggested answers, most likely first. Leave out for an answer they type.",
        items: {
          type: "object",
          properties: {
            label: { type: "string", description: "A short answer." },
            description: { type: "string", description: "A little more about it, if it helps." },
            acts: { type: "boolean", description: "Approvals only: true on the one option that goes ahead." },
          },
          required: ["label"],
        },
      },
      allows_text: { type: "boolean", description: "Whether they can type their own answer too. Defaults to true." },
      kind: { type: "string", enum: ["question", "approval"], description: "Defaults to question." },
      preview: { type: "string", description: "Approvals only: exactly what would happen." },
    },
    required: ["question"],
    additionalProperties: false,
  },
  call: (input) => Promise.resolve(askFrom(turns, input)),
});
