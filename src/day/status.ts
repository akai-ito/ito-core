import { toTimestamp, type Clock } from "#clock.ts";
import { toLocal, toMinutes } from "#desk/day.ts";
import type { Nights } from "#day/nights.ts";
import { atLocal, clockOf, hourMs, lengthOf, nextDay } from "#day/time.ts";
import { notBeforeOf } from "#http/settings.ts";
import type { HeldStatus } from "#protocol/types.ts";
import type { Settings } from "#store/store.ts";
import { textOf } from "#tools/input.ts";
import type { Tool, ToolResult } from "#tools/mcp.ts";
import type { Info } from "#turns/turns.ts";

// What Kumo knows they're doing now: the Focus their phone is in, when they've added Ito to it, and what they've
// told Kumo, such as "building tonight", until it's stale. Kumo's lines, plans and check-ins read it.
export type Status = {
  // A device's Focus turned on, or off when `focus` is undefined. The same Focus said again changes nothing.
  readonly setFocus: (device: string, focus: FocusKind | undefined) => void;
  // What counts of one device's Focus now, for the app.
  readonly held: (device: string) => HeldStatus;
  // "Now: …", for a prompt; empty when Kumo knows nothing.
  readonly lines: () => readonly string[];
  // Whether their Sleep Focus is on.
  readonly isAsleep: () => boolean;
  // Why they're likely to build tonight, from what they said or their Focus, if they are.
  readonly likely: () => string | undefined;
  readonly tool: Tool;
};

export type StatusOptions = {
  readonly settings: Settings;
  readonly clock: Clock;
  readonly timeZone: string;
  readonly nights: Nights;
  readonly info: Info;
};

export type FocusKind = "sleep" | "work" | "fitness" | "personal" | "other";

export const focusSetting = "status_focus";

export const saidSetting = "status_said";

// `heard` is when the device last said so; a Focus saved before it was kept counts as heard when it began.
type Focused = { readonly kind: FocusKind; readonly since: string; readonly heard?: string };

type Held = { readonly kind: FocusKind; readonly since: number; readonly heard: number; readonly until: number };

type Said = { readonly text: string; readonly since: string; readonly until: string };

// Whose Focus, as a prompt says it: "their Sleep Focus", or for one they didn't say, "a Focus of theirs".
const focusNames: Readonly<Record<FocusKind, string>> = {
  sleep: "their Sleep Focus",
  work: "their Work Focus",
  fitness: "their Fitness Focus",
  personal: "their Personal Focus",
  other: "a Focus of theirs",
};

// A Focus that's never said to be off stops counting, in case its device went quiet: a Sleep Focus at the morning
// after it came on, and within 12 hours; any other after 16 hours.
const longestSleepMs = 12 * hourMs;
const longestFocusMs = 16 * hourMs;
const saidForMs = 4 * hourMs;
const longestSaidMs = 18 * hourMs;
const eveningMinutes = 19 * 60;

const failed = (text: string): ToolResult => ({ text, isError: true });

const isBuilding = (text: string): boolean => /\b(?:build|building|coding|code|hack|hacking|ship)/iu.test(text);

export const createStatus = ({ settings, clock, timeZone, nights, info }: StatusOptions): Status => {
  const read = <Value>(key: string, empty: Value): Value => {
    const saved = settings.setting(key);
    return saved === undefined ? empty : (JSON.parse(saved) as Value);
  };

  const devices = (): Readonly<Record<string, Focused>> => read<Readonly<Record<string, Focused>>>(focusSetting, {});

  const saveDevices = (next: Readonly<Record<string, Focused>>): void => {
    settings.setSetting(focusSetting, JSON.stringify(next));
  };

  // The first time the local clock shows their morning after an instant.
  const morningAfter = (at: number): number => {
    const minutes = toMinutes(notBeforeOf(settings));
    const { day } = toLocal(at, timeZone);
    const sameDay = atLocal(day, minutes, timeZone);
    return sameDay > at ? sameDay : atLocal(nextDay(day), minutes, timeZone);
  };

  const toHeld = ({ kind, since, heard }: Focused): Held => {
    const began = Date.parse(since);
    return {
      kind,
      since: began,
      heard: heard === undefined ? began : Date.parse(heard),
      until: kind === "sleep" ? Math.min(morningAfter(began), began + longestSleepMs) : began + longestFocusMs,
    };
  };

  // A device's Focus, while it still counts.
  const counting = (device: string): Held | undefined => {
    const saved = devices()[device];
    const held = saved && toHeld(saved);
    return held && held.until > clock.now() ? held : undefined;
  };

  const focus = (): Held | undefined => {
    const [latest] = Object.keys(devices())
      .flatMap((device) => counting(device) ?? [])
      .toSorted((left, right) => right.since - left.since);
    return latest;
  };

  const said = (): Said | undefined => {
    const saved = read<Said | undefined>(saidSetting, undefined);
    return saved && Date.parse(saved.until) > clock.now() ? saved : undefined;
  };

  const setFocus = (device: string, kind: FocusKind | undefined): void => {
    const now = clock.now();
    const before = counting(device);
    const { [device]: saved, ...rest } = devices();
    // Said again, such as when the app reconnects: only when it was last heard changes.
    if (saved !== undefined && before?.kind === kind) {
      saveDevices({ ...rest, [device]: { ...saved, heard: toTimestamp(now) } });
      return;
    }
    saveDevices(kind === undefined ? rest : { ...rest, [device]: { kind, since: toTimestamp(now) } });
    if (before === undefined && kind === undefined) return;
    info("A Focus changed", { device, focus: kind ?? "off", ...(before && { was: before.kind }) });
    // A Focus changing is a sign of them; Sleep coming on is when the night stopped.
    nights.touch(now);
    if (kind !== "sleep") return;
    const night = nights.nightOf(now);
    if (nights.get(night)?.stop !== undefined && nights.get(night)?.stoppedAt === undefined) {
      nights.change(night, (current) => ({ ...current, stoppedAt: toTimestamp(now) }));
    }
  };

  return {
    setFocus,
    held: (device) => {
      const held = counting(device);
      return held
        ? {
            focus: held.kind,
            since: toTimestamp(held.since),
            heard: toTimestamp(held.heard),
            until: toTimestamp(held.until),
          }
        : {};
    },
    lines: () => {
      const focused = focus();
      const told = said();
      return [
        ...(focused
          ? [
              `Now: ${focusNames[focused.kind]} has been on since ${clockOf(focused.since, timeZone)}, ` +
                `last heard ${lengthOf(clock.now() - focused.heard)} ago.`,
            ]
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
