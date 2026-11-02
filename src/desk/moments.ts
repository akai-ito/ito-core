import { createCell } from "#cell.ts";
import type { Cancel, Clock } from "#clock.ts";
import { dayMs, minuteMs, startOfDay, toLocal, toMinutes, toSpoken, untilMinutes } from "#desk/day.ts";
import type { DeskKeeper, MomentHandler } from "#desk/desk.ts";
import type { Complete, JsonSchema } from "#engine/engine.ts";
import { notBeforeOf } from "#http/settings.ts";
import type { Identifiers } from "#identifiers.ts";
import type { Presence } from "#notifications/presence.ts";
import type { CalendarItem, Card, Desk, ModelChoice, Moment } from "#protocol/types.ts";
import type { Store } from "#store/store.ts";
import { fieldOf, textOf } from "#tools/input.ts";
import type { Info } from "#turns/turns.ts";

// Kumo's line for the moment: it changes only when the moment does (the day's first calm moment, something that
// matters arriving, a change to the day) and is otherwise left to all quiet. Each line is also a message.
// A line written elsewhere, such as a check-in on tonight's commitment, said as Kumo's line for the moment.
export type Line = {
  readonly kind: Moment["kind"];
  readonly text: string;
  readonly detail?: string;
  readonly options?: readonly string[];
  readonly allowsText?: boolean;
  readonly replyLabel?: string;
  // One notification goes out if it's still unread after a short grace.
  readonly matters: boolean;
  readonly isUrgent?: boolean;
  // How its answers are handled; otherwise Kumo acts on them in the background.
  readonly handler?: MomentHandler;
};

export type Moments = {
  // Something they should know now, from background work: it goes into Kumo's next line. While getting
  // started it goes straight into the conversation. Answers how, for the tool's result.
  readonly tell: (text: string, isUrgent: boolean) => string;
  // Says a line now, after any being written.
  readonly say: (line: Line) => Promise<Moment>;
  // Writes the day's first line now, whatever the time, for the demo.
  readonly dayNow: () => Promise<void>;
  readonly close: () => void;
};

export type MomentsOptions = {
  readonly store: Store;
  readonly desk: DeskKeeper;
  readonly clock: Clock;
  readonly timeZone: string;
  readonly presence: Pick<Presence, "isWatched" | "onWatched">;
  readonly complete: Complete;
  // The person's own model, thinking modestly: lines are few a day and the voice matters.
  readonly choice: () => Promise<ModelChoice | undefined>;
  readonly isBusy: () => boolean;
  readonly isGettingStarted: () => boolean;
  readonly identifiers: Identifiers;
  readonly lead: () => string;
  // A line that matters: one notification goes out if it's still unread after a short grace.
  readonly notify: (moment: string, isUrgent: boolean) => void;
  readonly info: Info;
  // Before the day's first line: lays out the day, such as Kumo's plan, and says what the line should know.
  readonly beforeDay?: () => Promise<readonly string[]>;
  // What Kumo knows they're doing now, such as their Focus, for its lines.
  readonly now?: () => readonly string[];
};

export const dayWrittenSetting = "moment_day";

// A burst, such as a mail's card and its news, makes one line: it waits for a quiet spell, but not for long.
export const gatherMs = 20 * 1000;
const gatherLimitMs = 2 * 60 * 1000;
const recheckMs = 5 * minuteMs;
const retryMs = 15 * minuteMs;
export const readHoldMs = 3 * 60 * minuteMs;
const maxOptions = 3;
const latestDone = 5;

type Told = { readonly kind: "told"; readonly text: string; readonly isUrgent: boolean };

type CardNews = { readonly kind: "card"; readonly card: string };

type Change = { readonly kind: "change"; readonly text: string };

type News = Told | CardNews | Change;

const toldOf = (news: readonly News[]): readonly Told[] => news.filter((item): item is Told => item.kind === "told");

const cardsOf = (news: readonly News[]): readonly CardNews[] =>
  news.filter((item): item is CardNews => item.kind === "card");

const changesOf = (news: readonly News[]): readonly Change[] =>
  news.filter((item): item is Change => item.kind === "change");

type Written = {
  readonly text: string;
  readonly detail: string;
  readonly options: readonly string[];
  readonly reply: boolean;
  readonly important: boolean;
};

const momentSchema: JsonSchema = {
  type: "object",
  properties: {
    text: { type: "string" },
    detail: { type: "string" },
    options: { type: "array", items: { type: "string" } },
    reply: { type: "boolean" },
    important: { type: "boolean" },
  },
  required: ["text", "detail", "options", "reply", "important"],
  additionalProperties: false,
};

const toWritten = (answer: unknown): Written => {
  const given = fieldOf(answer, "options");
  const options = (Array.isArray(given) ? (given as readonly unknown[]) : [])
    .filter((option): option is string => typeof option === "string" && option.trim() !== "")
    .map((option) => option.trim())
    .filter((option, index, all) => all.indexOf(option) === index)
    .slice(0, maxOptions);
  return {
    text: textOf(answer, "text").trim(),
    detail: textOf(answer, "detail").replaceAll(/\s+/gu, " ").trim(),
    options,
    reply: fieldOf(answer, "reply") === true,
    important: fieldOf(answer, "important") === true,
  };
};

const timeOf = (when: string, timeZone: string): string =>
  /^\d{4}-\d{2}-\d{2}$/u.test(when)
    ? new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", weekday: "short", day: "numeric", month: "short" }).format(
        Date.parse(when),
      )
    : new Intl.DateTimeFormat("en-GB", {
        timeZone,
        weekday: "short",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      }).format(Date.parse(when));

const cardDetail = (card: Card, timeZone: string): string | undefined => {
  if (card.question) return card.question.text;
  if (card.offer) return card.offer.text;
  if (card.times) return card.times.purpose;
  if (card.draft) return `to ${card.draft.to.join(", ")}: ${card.draft.subject}`;
  if (card.invite) return `${card.invite.event.title}, ${timeOf(card.invite.event.start, timeZone)}`;
  return undefined;
};

const whoseOf = (item: CalendarItem): string => {
  if (item.guess) return ` (your guess: ${item.guess.activity})`;
  return item.calendar.kumo ? " (your block)" : "";
};

const eventLine = (item: CalendarItem, timeZone: string): string =>
  `- ${timeOf(item.start, timeZone)} ${item.title}${item.location ? ` at ${item.location}` : ""}${whoseOf(item)}`;

// The message holds the line's words, and its quieter line after them.
export const messageOf = (text: string, detail: string | undefined): string =>
  detail === undefined || detail === "" ? text : `${text}\n\n${detail}`;

// What's left of today on their own calendars, by event, for noticing a change to the day.
const agendaOf = (items: readonly CalendarItem[], from: number, until: number): ReadonlyMap<string, string> =>
  new Map(
    items
      .filter(({ all_day: allDay, calendar, start }) => {
        const begins = Date.parse(start);
        return !allDay && !calendar.kumo && begins >= from && begins < until;
      })
      .map((item) => [item.uid, `${item.start}|${item.end}|${item.title}|${item.status ?? "confirmed"}`]),
  );

export const toChanges = (
  before: readonly CalendarItem[],
  after: readonly CalendarItem[],
  now: number,
  timeZone: string,
): readonly string[] => {
  const until = startOfDay(now, timeZone) + dayMs;
  const was = agendaOf(before, now, until);
  const is = agendaOf(after, now, until);
  const named = (uid: string): CalendarItem | undefined =>
    after.find((item) => item.uid === uid) ?? before.find((item) => item.uid === uid);
  return [...new Set([...was.keys(), ...is.keys()])].flatMap((uid) => {
    const item = named(uid);
    if (!item || was.get(uid) === is.get(uid)) return [];
    if (!was.has(uid)) return `New today: ${timeOf(item.start, timeZone)} ${item.title}`;
    if (!is.has(uid)) return `No longer today: ${item.title}`;
    const [startedAt] = (was.get(uid) ?? "").split("|", 1);
    return startedAt === item.start
      ? `Changed: ${item.title}, ${item.status ?? "confirmed"}`
      : `Moved: ${item.title}, now ${timeOf(item.start, timeZone)}`;
  });
};

const whyOf = (kind: Moment["kind"]): string => {
  switch (kind) {
    case "day": {
      return "It's the first calm moment of their day: give the day its shape.";
    }
    case "news": {
      return "Something that matters just came in.";
    }
    case "change": {
      return "Their day just changed.";
    }
    case "checkin": {
      return "A commitment they made is coming due.";
    }
    case "drift": {
      return "Their week's time has drifted from what matters.";
    }
    case "question": {
      return "You have one small question for them.";
    }
  }
};

export const toMomentPrompt = (lead: string, now: string, kind: Moment["kind"], material: readonly string[]): string =>
  [
    `You are ${lead}, their chief of staff. Write your line for this moment: one or two sentences at the top of`,
    "their Desk in Ito, which also go into the conversation.",
    `It's ${now}. ${whyOf(kind)}`,
    "",
    ...material,
    "",
    "- Say what matters most right now, in plain, warm words, as you would in person. Be honest.",
    "- Don't repeat the cards or the calendar below your line; they can see them. Order and connect them: what",
    "  comes first, what can wait, how it fits their day.",
    "- Only what's here: never invent a fact, a time or a feeling.",
    "- If nothing needs saying, leave text empty: a quiet moment gets no line.",
    "",
    ...(kind === "day"
      ? [
          "- Name the day's shape, such as A free Sunday, with a quiet plan under it. If last night ran past the line",
          "  they set and you moved things for it, say so plainly and kindly, never scolding, such as You stopped at",
          "  2:10, so I moved the run to the evening.",
        ]
      : []),
    "",
    "detail: for the day's first line, when you've planned blocks under the day, their parts in one short line",
    "joined with · , such as Easy run · groceries and proper meals · 2h prep · in bed by 00:30 so Monday works;",
    "empty otherwise.",
    "options: up to three short replies they could tap, only when a quick answer fits, such as Ask me tonight.",
    "reply: true when a typed answer fits, such as how something went. important: true only when it can't wait",
    "until they next open Ito.",
  ].join("\n");

export const createMoments = ({
  store,
  desk,
  clock,
  timeZone,
  presence,
  complete,
  choice,
  isBusy,
  isGettingStarted,
  identifiers,
  lead,
  notify,
  info,
  beforeDay = () => Promise.resolve([]),
  now: nowLines = () => [],
}: MomentsOptions): Moments => {
  const pending = createCell<readonly News[]>([]);
  const gathering = createCell<{ readonly since: number; readonly cancel: Cancel } | undefined>(undefined);
  const dayTimer = createCell<Cancel | undefined>(undefined);
  const checking = createCell<Promise<void> | undefined>(undefined);
  const holdTimer = createCell<Cancel | undefined>(undefined);
  const midnight = createCell<Cancel | undefined>(undefined);
  const queue = createCell<Promise<void>>(Promise.resolve());
  const known = createCell<Desk>(store.desk());
  const isClosed = createCell(false);

  const local = (): ReturnType<typeof toLocal> => toLocal(clock.now(), timeZone);

  const material = (news: readonly News[], before: readonly string[] = []): readonly string[] => {
    const current = store.desk();
    const fresh = new Set(cardsOf(news).map(({ card }) => card));
    const told = toldOf(news).map(({ text }) => `- ${text}`);
    const changes = changesOf(news).map(({ text }) => `- ${text}`);
    const handled = desk.today().filter(({ quiet }) => !quiet);
    const previous = current.moment;
    return [
      ...nowLines(),
      ...before,
      ...(told.length > 0 ? ["What your background work said they should know now:", ...told] : []),
      ...(changes.length > 0 ? ["What changed in their day:", ...changes] : []),
      ...(current.waiting.length > 0
        ? [
            "Waiting on them on the Desk:",
            ...current.waiting.map((card) => {
              const detail = cardDetail(card, timeZone);
              return `- ${card.title}${detail ? ` (${detail})` : ""}${fresh.has(card.id) ? " [new]" : ""}`;
            }),
          ]
        : []),
      ...(current.coming_up.length > 0
        ? ["Coming up:", ...current.coming_up.map((item) => eventLine(item, timeZone))]
        : []),
      ...(handled.length > 0
        ? [
            `Done without them today: ${String(handled.length)}, the latest:`,
            ...handled.slice(0, latestDone).map(({ text }) => `- ${text}`),
          ]
        : []),
      ...(previous ? [`Your line before this one: ${previous.text}`] : []),
    ];
  };

  // Puts a line on the Desk and in the conversation, with how it's answered.
  const show = (line: Line): Moment => {
    const detail = line.detail?.trim() ?? "";
    const message = store.postMessage(messageOf(line.text, detail), "moment");
    const moment: Moment = {
      id: identifiers.moment(),
      kind: line.kind,
      at: message.at,
      text: line.text,
      ...(detail !== "" && { detail }),
      message: message.id,
      options: (line.options ?? []).slice(0, maxOptions).map((label) => ({ label })),
      allows_text: line.allowsText === true,
      ...(line.allowsText === true && line.replyLabel !== undefined && { reply_label: line.replyLabel }),
    };
    desk.setMoment(moment);
    if (line.handler) desk.handleMoment(moment.id, line.handler);
    if (line.matters) notify(moment.id, line.isUrgent === true);
    return moment;
  };

  const holdUntil = (moment: Moment | undefined): void => {
    holdTimer.get()?.();
    holdTimer.set(undefined);
    if (moment?.read_at === undefined) return;
    const delay = Math.max(0, Date.parse(moment.read_at) + readHoldMs - clock.now());
    holdTimer.set(
      clock.after(delay, () => {
        const current = store.desk().moment;
        if (current?.id === moment.id && current.state !== "working") desk.setMoment(undefined);
      }),
    );
  };

  // A new day: what Kumo handled starts again from nothing, and yesterday's line gives way.
  const scheduleMidnight = (): void => {
    midnight.get()?.();
    const delay = untilMinutes(clock.now(), timeZone, 0);
    midnight.set(
      clock.after(delay, () => {
        desk.recount();
        const current = store.desk().moment;
        if (current && current.state !== "working" && toLocal(Date.parse(current.at), timeZone).day !== local().day)
          desk.setMoment(undefined);
        scheduleMidnight();
      }),
    );
  };

  const post = async (kind: Moment["kind"], news: readonly News[]): Promise<void> => {
    const told = toldOf(news);
    const isUrgent = told.some((item) => item.isUrgent);
    const before = kind === "day" ? await beforeDay() : [];
    if (isClosed.get()) return;
    const now = toSpoken(clock.now(), timeZone);
    const prompt = toMomentPrompt(lead(), now, kind, material(news, before));
    const answered = await complete(prompt, momentSchema, await choice());
    if (isClosed.get()) return;
    if (!answered.ok) info("Kumo couldn't write its line for the moment", { error: answered.failure });
    // What the background work said in its own words still reaches them when the line couldn't be written.
    const written: Written = answered.ok
      ? toWritten(answered.value)
      : { text: told.map((item) => item.text).join(" "), detail: "", options: [], reply: false, important: true };
    if (kind === "day" && answered.ok) store.setSetting(dayWrittenSetting, local().day);
    if (written.text === "") return;
    show({
      kind,
      text: written.text,
      detail: written.detail,
      options: written.options,
      allowsText: written.reply,
      matters: written.important || told.length > 0 || cardsOf(news).length > 0,
      isUrgent,
    });
  };

  const settled = async (job: Promise<void>): Promise<void> => {
    try {
      await job;
    } catch (error) {
      info("Kumo's line for the moment failed", { error: String(error) });
    }
  };

  // Writes one line at a time; news that comes in meanwhile makes the next one.
  const write = (kind: Moment["kind"] | undefined): Promise<void> => {
    const previous = queue.get();
    const run = async (): Promise<void> => {
      await previous;
      if (isClosed.get()) return;
      const waiting = new Set(store.desk().waiting.map(({ id }) => id));
      // A card answered before the line was written is no longer news.
      const news = pending.get().filter((item) => item.kind !== "card" || waiting.has(item.card));
      pending.set([]);
      if (kind === undefined && news.length === 0) return;
      await post(kind ?? (changesOf(news).length === news.length ? "change" : "news"), news);
    };
    const job = run();
    queue.set(settled(job));
    return job;
  };

  const gather = (isUrgent: boolean): void => {
    const now = clock.now();
    const current = gathering.get();
    current?.cancel();
    const since = current?.since ?? now;
    const delay = isUrgent ? 0 : Math.max(0, Math.min(gatherMs, since + gatherLimitMs - now));
    gathering.set({
      since,
      cancel: clock.after(delay, () => {
        gathering.set(undefined);
        void write(undefined);
      }),
    });
  };

  const add = (item: News): void => {
    pending.update((current) => [...current, item]);
    gather(item.kind === "told" && item.isUrgent);
  };

  const morning = (): number => toMinutes(notBeforeOf(store));

  const untilMorning = (): number => untilMinutes(clock.now(), timeZone, morning());

  const isDayDue = (): boolean => {
    const { day, minutes } = local();
    return !isGettingStarted() && store.setting(dayWrittenSetting) !== day && minutes >= morning();
  };

  const scheduleDay = (delay: number): void => {
    dayTimer.get()?.();
    if (isClosed.get()) return;
    dayTimer.set(
      clock.after(delay, () => {
        void checkDay();
      }),
    );
  };

  const lookAtDay = async (): Promise<void> => {
    if (isClosed.get()) return;
    if (!isDayDue()) {
      scheduleDay(untilMorning());
      return;
    }
    if (isBusy() && !presence.isWatched()) {
      scheduleDay(recheckMs);
      return;
    }
    gathering.get()?.cancel();
    gathering.set(undefined);
    try {
      await write("day");
    } catch {
      // The queue logs a line that failed; it's tried again in a while.
    }
    scheduleDay(isDayDue() ? retryMs : untilMorning());
  };

  // One look at a time: opening Ito while the day's line is being written doesn't write a second.
  const checkDay = (): Promise<void> => {
    const running = checking.get();
    if (running) return running;
    const next = (async (): Promise<void> => {
      try {
        await lookAtDay();
      } finally {
        checking.set(undefined);
      }
    })();
    checking.set(next);
    return next;
  };

  const onDesk = (after: Desk): void => {
    const before = known.get();
    known.set(after);
    if (JSON.stringify(after.moment) !== JSON.stringify(before.moment)) holdUntil(after.moment);
    if (isGettingStarted()) return;
    const had = new Set(before.waiting.map(({ id }) => id));
    for (const card of after.waiting) {
      if (!had.has(card.id) && card.quiet !== true) add({ kind: "card", card: card.id });
    }
    for (const text of toChanges(before.coming_up, after.coming_up, clock.now(), timeZone)) {
      add({ kind: "change", text });
    }
  };

  const unsubscribe = store.subscribe(({ event }) => {
    if (event.type === "desk.changed") onDesk(event.desk);
  });
  const unwatch = presence.onWatched(() => {
    if (isDayDue()) void checkDay();
  });
  holdUntil(known.get().moment);
  scheduleMidnight();
  void checkDay();

  return {
    tell: (text, isUrgent) => {
      if (isGettingStarted()) {
        const message = store.postMessage(text);
        return `Posted into the conversation as ${message.id}.`;
      }
      add({ kind: "told", text, isUrgent });
      return "It's in your next line at the top of their Desk, which also goes into the conversation.";
    },
    say: (line) => {
      const previous = queue.get();
      const job = (async (): Promise<Moment> => {
        await previous;
        return show(line);
      })();
      const done = async (): Promise<void> => {
        await job;
      };
      queue.set(settled(done()));
      return job;
    },
    dayNow: () => write("day"),
    close: () => {
      isClosed.set(true);
      unsubscribe();
      unwatch();
      for (const timer of [dayTimer, holdTimer, midnight]) timer.get()?.();
      gathering.get()?.cancel();
    },
  };
};
