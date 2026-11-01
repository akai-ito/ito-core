import { toTimestamp, type Clock } from "#clock.ts";
import { toLocal } from "#desk/day.ts";
import type { Nights } from "#day/nights.ts";
import { clockOf, hourMs } from "#day/time.ts";
import type { Settings } from "#store/store.ts";
import { textOf } from "#tools/input.ts";
import type { Tool, ToolResult } from "#tools/mcp.ts";

// What Kumo knows they're doing now: the Focus their phone is in, when they've added Ito to it, and what they've
// told Kumo, such as "building tonight", until it's stale. Kumo's lines, plans and check-ins read it.
export type Status = {
  // A device's Focus turned on, or off when `focus` is undefined.
  readonly setFocus: (device: string, focus: FocusKind | undefined) => void;
  readonly focus: () => { readonly kind: FocusKind; readonly since: number } | undefined;
  // "Now: …", for a prompt; empty when Kumo knows nothing.
  readonly lines: () => readonly string[];
  // Whether their Sleep Focus is on.
  readonly isAsleep: () => boolean;
  // Why they're likely to build tonight, from what they said or their Focus, if they are.
  readonly likely: () => string | undefined;
  readonly tool: Tool;
};

export type FocusKind = "sleep" | "work" | "fitness" | "personal" | "other";

export const focusSetting = "status_focus";

export const saidSetting = "status_said";

type Focused = { readonly kind: FocusKind; readonly since: string };

type Said = { readonly text: string; readonly since: string; readonly until: string };

const focusNames: Readonly<Record<FocusKind, string>> = {
  sleep: "Sleep",
  work: "Work",
  fitness: "Fitness",
  personal: "Personal",
  other: "a",
};

// A Focus that's never said to be off stops counting after this long, in case its device went quiet.
const staleFocusMs = 16 * hourMs;
const saidForMs = 4 * hourMs;
const longestSaidMs = 18 * hourMs;
const eveningMinutes = 19 * 60;

const failed = (text: string): ToolResult => ({ text, isError: true });

const isBuilding = (text: string): boolean => /\b(?:build|building|coding|code|hack|hacking|ship)/iu.test(text);

export const createStatus = (settings: Settings, clock: Clock, timeZone: string, nights: Nights): Status => {
  const read = <Value>(key: string, empty: Value): Value => {
    const saved = settings.setting(key);
    return saved === undefined ? empty : (JSON.parse(saved) as Value);
  };

  const devices = (): Readonly<Record<string, Focused>> => read<Readonly<Record<string, Focused>>>(focusSetting, {});

  const focus = (): { readonly kind: FocusKind; readonly since: number } | undefined => {
    const now = clock.now();
    const [latest] = Object.values(devices())
      .map(({ kind, since }) => ({ kind, since: Date.parse(since) }))
      .filter(({ since }) => since > now - staleFocusMs)
      .toSorted((left, right) => right.since - left.since);
    return latest;
  };

  const said = (): Said | undefined => {
    const saved = read<Said | undefined>(saidSetting, undefined);
    return saved && Date.parse(saved.until) > clock.now() ? saved : undefined;
  };

  return {
    setFocus: (device, kind) => {
      const now = clock.now();
      const rest = Object.fromEntries(Object.entries(devices()).filter(([id]) => id !== device));
      settings.setSetting(
        focusSetting,
        JSON.stringify(kind === undefined ? rest : { ...rest, [device]: { kind, since: toTimestamp(now) } }),
      );
      // A Focus changing is a sign of them; Sleep coming on is when the night stopped.
      nights.touch(now);
      if (kind !== "sleep") return;
      const night = nights.nightOf(now);
      if (nights.get(night)?.stop !== undefined && nights.get(night)?.stoppedAt === undefined) {
        nights.change(night, (current) => ({ ...current, stoppedAt: toTimestamp(now) }));
      }
    },
    focus,
    lines: () => {
      const focused = focus();
      const told = said();
      return [
        ...(focused
          ? [`Now: their ${focusNames[focused.kind]} Focus has been on since ${clockOf(focused.since, timeZone)}.`]
          : []),
        ...(told ? [`They told you at ${clockOf(Date.parse(told.since), timeZone)}: ${told.text}`] : []),
      ];
    },
    isAsleep: () => focus()?.kind === "sleep",
    likely: () => {
      const told = said();
      if (told && isBuilding(told.text)) return `they told you: ${told.text}`;
      const focused = focus();
      const isEvening = toLocal(clock.now(), timeZone).minutes >= eveningMinutes;
      return isEvening && focused?.kind === "work" ? "their Work Focus is on this evening" : undefined;
    },
    tool: {
      name: "set_status",
      title: "Note what they're doing",
      description:
        "When they tell you what they're doing now or next, such as building tonight, off to the gym or out for " +
        "dinner, note it in a few words. It's kept for four hours, or until the time you give, so your lines, " +
        "plans and check-ins fit the moment.",
      inputSchema: {
        type: "object",
        properties: {
          text: { type: "string", description: "A few words, such as “Building tonight”." },
          until: { type: "string", description: "An instant with its offset, when it stops being true." },
        },
        required: ["text"],
        additionalProperties: false,
      },
      call: (input) => {
        const text = textOf(input, "text").replaceAll(/\s+/gu, " ").trim();
        if (text === "") return Promise.resolve(failed("Say what they're doing, in a few words."));
        const now = clock.now();
        const given = Date.parse(textOf(input, "until"));
        const until = Number.isNaN(given) ? now + saidForMs : Math.min(Math.max(given, now), now + longestSaidMs);
        settings.setSetting(
          saidSetting,
          JSON.stringify({ text: text.slice(0, 80), since: toTimestamp(now), until: toTimestamp(until) }),
        );
        nights.touch(now);
        return Promise.resolve({ text: `Noted until ${clockOf(until, timeZone)}.` });
      },
    },
  };
};
