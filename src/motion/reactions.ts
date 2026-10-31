import type { JsonSchema } from "#engine/engine.ts";
import type { Fields } from "#motion/changes.ts";
import { fieldOf } from "#tools/input.ts";

export type Reaction = { readonly changes: unknown; readonly summary: string; readonly note: string };

export const reactionSchema: JsonSchema = {
  type: "object",
  properties: {
    changes_json: { type: "string" },
    summary: { type: "string" },
    note: { type: "string" },
  },
  required: ["changes_json", "summary", "note"],
  additionalProperties: false,
};

export type Reacting = {
  readonly id: string;
  readonly kind: string;
  readonly title: string;
  readonly summary: string;
  readonly version: number;
  readonly content: Fields;
  readonly state: Fields;
  readonly taps: readonly string[];
};

export const toReactionPrompt = ({ id, kind, title, summary, version, content, state, taps }: Reacting): string =>
  [
    `You keep "${title}" (${id}, ${/^[aeiou]/u.test(kind) ? "an" : "a"} ${kind}) in motion for the person. On ` +
      `their phone, they just ${taps.join(", ")}.`,
    "Keep the thing true to that, quietly: nothing you write here goes into the chat.",
    "",
    "- Mark what a ticked to-do is about as booked, such as its stop, leg or place, and undo that for an untick.",
    "- Fit a place they put in the plan into the day it suits best, as a stop at a sensible time that names the",
    "  place, and set the place to picked.",
    "- Take a place they made an idea again, or passed on, out of the days, with anything only about it, such as",
    "  its to-do, and set the place to shortlisted or passed.",
    "- For a training session, set the week's note to a line on how the week is going and what's next.",
    "- Keep the summary current: what's left counts their ticks.",
    "- Change nothing else. If nothing follows from what they did, give an empty list and the summary as it is.",
    "",
    "Answer with changes_json: a JSON array of changes, each one of {set: id, fields: {…}}, {add: item, to: list,",
    'after?: id}, {move: id, to?: list, after?: id} or {remove: id}; a list is named by its field, such as "todo",',
    "or by its day's or week's id. Give the summary, and a note on what you did, in a few words, such as",
    '"Pisa train booked".',
    "",
    `The thing, at version ${String(version)}, with every id:`,
    JSON.stringify(content, undefined, 2),
    "",
    `Their ticks and choices, which win over the content's own: ${JSON.stringify(state)}`,
    `Its summary now: ${summary}`,
  ].join("\n");

export const toReaction = (answer: unknown): Reaction | undefined => {
  const changes = fieldOf(answer, "changes_json");
  const summary = fieldOf(answer, "summary");
  const note = fieldOf(answer, "note");
  if (typeof changes !== "string" || typeof summary !== "string" || typeof note !== "string") return undefined;
  try {
    return { changes: JSON.parse(changes) as unknown, summary: summary.trim(), note: note.trim() };
  } catch {
    return undefined;
  }
};
