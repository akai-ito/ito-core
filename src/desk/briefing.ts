import { createCell } from "#cell.ts";
import { toTimestamp, type Cancel, type Clock } from "#clock.ts";
import type { DeskKeeper } from "#desk/desk.ts";
import type { Complete, JsonSchema } from "#engine/engine.ts";
import { notBeforeOf } from "#http/settings.ts";
import type { Identifiers } from "#identifiers.ts";
import type { Presence } from "#notifications/presence.ts";
import type { Briefing, BriefingLine } from "#protocol/types.ts";
import type { Store } from "#store/store.ts";
import { fieldOf, textOf } from "#tools/input.ts";
import type { Info } from "#turns/turns.ts";

export type Briefings = { readonly briefNow: () => Promise<void>; readonly close: () => void };

export type BriefingOptions = {
  readonly store: Store;
  readonly desk: DeskKeeper;
  readonly clock: Clock;
  readonly timeZone: string;
  readonly presence: Pick<Presence, "isWatched" | "onWatched">;
  readonly complete: Complete;
  readonly isBusy: () => boolean;
  readonly identifiers: Identifiers;
  readonly info: Info;
};

export const briefedSetting = "briefing_day";

const minuteMs = 60 * 1000;
const recheckMs = 5 * minuteMs;
const dropAtMinutes = 14 * 60;

const briefingSchema: JsonSchema = {
  type: "object",
  properties: {
    lines: {
      type: "array",
      items: {
        type: "object",
        properties: { text: { type: "string" }, card: { type: "string" } },
        required: ["text", "card"],
        additionalProperties: false,
      },
    },
    handled: { type: "integer" },
  },
  required: ["lines", "handled"],
  additionalProperties: false,
};

type Local = { readonly day: string; readonly minutes: number };

export const toLocal = (now: number, timeZone: string): Local => {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(now)
      .map(({ type, value }) => [type, value]),
  );
  return {
    day: `${String(parts.year)}-${String(parts.month)}-${String(parts.day)}`,
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
  };
};

const toMinutes = (time: string): number => {
  const [hours = "7", minutes = "30"] = time.split(":", 2);
  return Number(hours) * 60 + Number(minutes);
};

const untilMinutes = (now: number, local: Local, target: number): number => {
  const startOfMinute = now - (now % minuteMs);
  const delay = (target - local.minutes) * minuteMs - (now - startOfMinute);
  return delay > 0 ? delay : delay + 24 * 60 * minuteMs;
};

export const toBriefingPrompt = (material: readonly string[], day: string): string =>
  [
    "You are the person's assistant, writing their morning briefing for their phone's home screen. Bring only what",
    "needs them or changed their plans, most important first, each a short plain line. Nothing for what went fine,",
    "and no greeting. If nothing matters today, give no lines: a quiet day gets no briefing.",
    "",
    `Today is ${day}.`,
    ...material,
    "",
    'Answer with lines, each with its text and the id of the card it\'s about (or ""), and handled: how many small',
    "things were done without them.",
  ].join("\n");

export const createBriefings = ({
  store,
  desk,
  clock,
  timeZone,
  presence,
  complete,
  isBusy,
  identifiers,
  info,
}: BriefingOptions): Briefings => {
  const timer = createCell<Cancel | undefined>(undefined);
  const dropper = createCell<Cancel | undefined>(undefined);
  const isWriting = createCell(false);
  const isClosed = createCell(false);

  const local = (): Local => toLocal(clock.now(), timeZone);
  const notBefore = (): number => toMinutes(notBeforeOf(store));

  const material = (): readonly string[] => {
    const waiting = store.desk().waiting;
    const since = store.desk().briefing?.at ?? toTimestamp(clock.now() - 24 * 60 * minuteMs);
    const posts = store.postsSince(since).map((post) => `- ${post.text}`);
    const done = store
      .listDone(undefined, 50)
      .entries.filter((entry) => entry.at > since)
      .map((entry) => `- ${entry.text}`);
    return [
      ...(waiting.length > 0 ? ["Waiting on them:", ...waiting.map((card) => `- ${card.title} (${card.id})`)] : []),
      ...(posts.length > 0 ? ["What you told them:", ...posts] : []),
      ...(done.length > 0 ? ["Done without them:", ...done] : []),
      ...(store.desk().coming_up.length > 0
        ? ["Coming up:", ...store.desk().coming_up.map((item) => `- ${item.start} ${item.title}`)]
        : []),
    ];
  };

  const toLines = (answer: unknown): readonly BriefingLine[] => {
    const given = fieldOf(answer, "lines");
    const cards = new Set(store.desk().waiting.map(({ id }) => id));
    return (Array.isArray(given) ? (given as readonly unknown[]) : []).flatMap((line) => {
      const text = textOf(line, "text").trim();
      const card = textOf(line, "card").trim();
      return text === "" ? [] : { text, ...(cards.has(card) && { card }) };
    });
  };

  const scheduleDrop = (): void => {
    dropper.get()?.();
    const delay = untilMinutes(clock.now(), local(), dropAtMinutes);
    dropper.set(
      clock.after(delay, () => {
        if (store.desk().briefing) desk.setBriefing(undefined);
      }),
    );
  };

  const write = async (): Promise<void> => {
    if (isWriting.get()) return;
    isWriting.set(true);
    try {
      const { day } = local();
      const answered = await complete(toBriefingPrompt(material(), day), briefingSchema);
      if (isClosed.get()) return;
      if (!answered.ok) {
        info("Kumo couldn't write the morning briefing", { error: answered.failure });
        return;
      }
      store.setSetting(briefedSetting, day);
      const lines = toLines(answered.value);
      if (lines.length === 0) return;
      const handled = fieldOf(answered.value, "handled");
      const [first, ...rest] = lines;
      if (!first) return;
      const briefing: Briefing = {
        id: identifiers.briefing(),
        kind: "morning",
        at: toTimestamp(clock.now()),
        lines: [first, ...rest],
        handled: typeof handled === "number" && handled >= 0 ? Math.floor(handled) : 0,
      };
      desk.setBriefing(briefing);
      scheduleDrop();
    } finally {
      isWriting.set(false);
    }
  };

  const isDue = (): boolean => {
    const { day, minutes } = local();
    return store.setting(briefedSetting) !== day && minutes >= notBefore() && minutes < dropAtMinutes;
  };

  const schedule = (delay: number): void => {
    timer.get()?.();
    if (isClosed.get()) return;
    timer.set(
      clock.after(delay, () => {
        void check();
      }),
    );
  };

  const check = async (): Promise<void> => {
    if (isClosed.get()) return;
    if (!isDue()) {
      schedule(untilMinutes(clock.now(), local(), notBefore()));
      return;
    }
    if (isBusy() && !presence.isWatched()) {
      schedule(recheckMs);
      return;
    }
    await write();
    schedule(untilMinutes(clock.now(), local(), notBefore()));
  };

  const unwatch = presence.onWatched(() => {
    if (isDue()) void check();
  });
  void check();

  return {
    briefNow: write,
    close: () => {
      isClosed.set(true);
      unwatch();
      timer.get()?.();
      dropper.get()?.();
    },
  };
};
