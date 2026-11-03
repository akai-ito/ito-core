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

export const knownMoods = ["bright", "calm", "cosy", "focused", "drowsy", "proud", "concerned"] as const;

const longestLine = 140;

export const createDeskLine = ({ store, desk, clock }: DeskLineOptions): DeskLine => ({
  tool: {
    name: "set_desk_line",
    title: "Set your line on the Desk",
    description:
      "Set your line under your face on their Desk, with your mood, or clear it with empty text. It never notifies.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: `A few words, at most ${String(longestLine)} characters.` },
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
    return line === undefined
      ? ""
      : `<desk_line>\nYour line on their Desk, set ${line.at}: “${line.text}” (${line.mood})\n</desk_line>`;
  },
});
