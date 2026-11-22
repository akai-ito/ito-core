import { toTimestamp, type Clock } from "#clock.ts";
import type { DeskKeeper } from "#desk/desk.ts";
import type { Store } from "#store/store.ts";
import { textOf } from "#tools/input.ts";
import type { Tool } from "#tools/mcp.ts";

// Kumo's line at the top of the Desk and its mood, set by judgement whenever the moment changes. It never notifies.
export type DeskLine = {
  readonly tool: Tool;
  readonly inMindText: () => string;
};

export type DeskLineOptions = {
  readonly store: Pick<Store, "desk">;
  readonly desk: Pick<DeskKeeper, "setLine">;
  readonly clock: Clock;
};

const hourMs = 60 * 60 * 1000;

// How long ago, in the words Kumo would use: "just now", "3 hours ago", "2 days ago".
const ago = (sinceMs: number): string => {
  if (sinceMs < hourMs) return "within the hour";
  if (sinceMs < 24 * hourMs) {
    const hours = Math.floor(sinceMs / hourMs);
    return `${String(hours)} hour${hours === 1 ? "" : "s"} ago`;
  }
  const days = Math.floor(sinceMs / (24 * hourMs));
  return `${String(days)} day${days === 1 ? "" : "s"} ago`;
};

// Their home screen shows only Kumo's face without a line, so an empty one is said, not left out.
const emptyLine = [
  "<desk_line>",
  "Your line under your face on their Desk is empty, so their home screen has nothing from you. Set one with",
  "set_desk_line whenever you have something for them about now.",
  "</desk_line>",
].join("\n");

export const knownMoods = ["bright", "calm", "cosy", "focused", "drowsy", "proud", "concerned"] as const;

const longestLine = 140;

export const createDeskLine = ({ store, desk, clock }: DeskLineOptions): DeskLine => ({
  tool: {
    name: "set_desk_line",
    title: "Set your line on the Desk",
    description:
      "Set your line under your face on their Desk, the first thing they read when they open Ito, with your mood. " +
      "Make it worth reading: something for them about now, in your own voice, such as encouragement before " +
      "something real (“Halcyon at 2. You've done the work.”), a thought about their day, a fitting quote, or " +
      "something fun. Never a status report or a count: the Desk already shows what waits on them and what's " +
      "next. Change it when its moment passes. Empty text clears it. It never notifies.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: `A sentence or two, at most ${String(longestLine)} characters.` },
        mood: { type: "string", description: `One word, such as ${knownMoods.join(", ")}.` },
      },
      required: ["text", "mood"],
      additionalProperties: false,
    },
    call: (input) => {
      const text = textOf(input, "text").replaceAll(/\s+/gu, " ").trim();
      if (text.length > longestLine) {
        return Promise.resolve({ text: `Keep it to ${String(longestLine)} characters.`, isError: true });
      }
      if (text === "") {
        desk.setLine(undefined);
        return Promise.resolve({ text: "Cleared your line." });
      }
      const mood = textOf(input, "mood").trim().toLowerCase();
      if (!/^[a-z]{1,24}$/u.test(mood)) {
        return Promise.resolve({
          text: `Give your mood in one word, such as ${knownMoods.join(", ")}.`,
          isError: true,
        });
      }
      desk.setLine({ text, mood, at: toTimestamp(clock.now()) });
      return Promise.resolve({ text: "It's at the top of their Desk." });
    },
  },
  inMindText: () => {
    const line = store.desk().line;
    if (line === undefined) return emptyLine;
    return [
      "<desk_line>",
      `Your line on their Desk, set ${line.at}, ${ago(clock.now() - Date.parse(line.at))}: “${line.text}” ` +
        `(${line.mood}). Change it once its moment has passed.`,
      "</desk_line>",
    ].join("\n");
  },
});
