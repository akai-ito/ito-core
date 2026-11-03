import { randomUUID } from "node:crypto";
import { createCell } from "#cell.ts";
import { toTimestamp, type Cancel, type Clock } from "#clock.ts";
import { atLocal, nextDay, toLocal, toSpoken } from "#desk/day.ts";
import { lastLine, type DeskKeeper } from "#desk/desk.ts";
import type { Identifiers } from "#identifiers.ts";
import type { CalendarItem, Repeat, WakeUp, WakeUpChange, WakeUpSource, Weekday } from "#protocol/types.ts";
import { fail, ok, type Result } from "#result.ts";
import type { WakeUpStore } from "#store/wakeups.ts";
import { fieldOf, stringsOf, textOf } from "#tools/input.ts";
import type { Tool, ToolResult } from "#tools/mcp.ts";
import type { Info } from "#turns/turns.ts";

// Wake-ups: a concrete time Kumo will wake and look at something, what it's for and why, one-off or repeating, who
// made it and where it came from. When one comes due Kumo looks first, then messages them, moves it or drops it, and
// Done says which. Setting one is quiet: it shows in Kumo's plans on the Desk.
export type WakeUps = {
  readonly tools: readonly Tool[];
  readonly list: () => readonly WakeUp[];
  // From the app: move it, change how it repeats or what it's for.
  readonly change: (id: string, change: WakeUpChange) => Result<WakeUp, string>;
  // From the app.
  readonly cancel: (id: string) => boolean;
  readonly inMindText: () => string;
  // The wake-ups that came from these calendar events, for Kumo when they change.
  readonly tiedTo: (uids: readonly string[]) => readonly WakeUp[];
  // A wake-up in a line, for a prompt.
  readonly describe: (wakeUp: WakeUp) => string;
  // Their time zone changed: each repeating wake-up comes back at its time where they are now.
  readonly refit: () => void;
  readonly close: () => void;
};

export type WakeUpsOptions = {
  readonly store: WakeUpStore;
  readonly isMotion: (id: string) => boolean;
  readonly clock: Clock;
  readonly timeZone: () => string;
  readonly identifiers: Pick<Identifiers, "wakeUp">;
  // Kumo's work in the background, as one run, so what it did in that run can be told.
  readonly work: (prompt: string, run: string) => Promise<Result<string, string>>;
  // Whether Kumo messaged them during a run.
  readonly postedIn: (run: string) => boolean;
  // An event on their calendars as it is now, by uid.
  readonly event: (uid: string) => CalendarItem | undefined;
  readonly desk: Pick<DeskKeeper, "addDone" | "setPlans">;
  readonly info: Info;
};

export const weekdays: readonly Weekday[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

const weekdayNames: Readonly<Record<Weekday, string>> = {
  mon: "Mon",
  tue: "Tue",
  wed: "Wed",
  thu: "Thu",
  fri: "Fri",
  sat: "Sat",
  sun: "Sun",
};

const sources: readonly WakeUpSource["kind"][] = ["chat", "mail", "calendar", "wake_up"];

// Long enough for a model that didn't answer to come back, and short enough to catch up soon after.
export const retryMs = 15 * 60 * 1000;

const longestTimerMs = 2 ** 31 - 1;

const instantPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/u;

const clockPattern = /^(?:[01]\d|2[0-3]):[0-5]\d$/u;

const lineOf = (value: unknown, field: string): string => textOf(value, field).replaceAll(/\s+/gu, " ").trim();

const failed = (text: string): ToolResult => ({ text, isError: true });

const minutesOf = (time: string): number => {
  const [hours = 0, minutes = 0] = time.split(":", 2).map(Number);
  return hours * 60 + minutes;
};

// Monday first, as the protocol lists them.
const weekdayOf = (day: string): Weekday => weekdays[(new Date(`${day}T12:00:00.000Z`).getUTCDay() + 6) % 7] ?? "mon";

// The first time after an instant that a repeat comes round, on the local clock in a time zone.
export const nextOf = (repeat: Repeat, after: number, timeZone: string): number => {
  const days = Array.from({ length: 8 }).reduce<readonly string[]>(
    (found) => [...found, nextDay(found.at(-1) ?? "")],
    [toLocal(after, timeZone).day],
  );
  const next = days
    .filter((day) => repeat.days.includes(weekdayOf(day)))
    .map((day) => atLocal(day, minutesOf(repeat.time), timeZone))
    .find((at) => at > after);
  return next ?? after + 7 * 24 * 60 * 60 * 1000;
};

const repeatWords = ({ days, time }: Repeat): string => {
  const sorted = weekdays.filter((day) => days.includes(day));
  if (sorted.length === 7) return `every day at ${time}`;
  if (sorted.join(",") === "mon,tue,wed,thu,fri") return `weekdays at ${time}`;
  if (sorted.join(",") === "sat,sun") return `weekends at ${time}`;
  return `${sorted.map((day) => weekdayNames[day]).join(", ")} at ${time}`;
};

const toRepeat = (value: unknown): Repeat | string | undefined => {
  if (value === undefined || value === null) return undefined;
  const days = stringsOf(value, "days");
  const time = lineOf(value, "time");
  const known = weekdays.filter((day) => days.includes(day));
  if (known.length === 0 || known.length !== new Set(days).size) {
    return "A repeat's days are mon, tue, wed, thu, fri, sat or sun, each once.";
  }
  return clockPattern.test(time) ? { days: known, time } : "A repeat's time is HH:MM, such as 09:00.";
};

const toInstant = (text: string, now: number): number | string => {
  const at = Date.parse(text);
  if (Number.isNaN(at) || !instantPattern.test(text)) {
    return `${text} isn't an ISO time with its offset, such as 2026-11-12T15:30:00Z.`;
  }
  return at <= now ? `${text} has already passed: give a time to come.` : at;
};

const toSource = (input: unknown): WakeUpSource | string => {
  const source = fieldOf(input, "source");
  const kind = sources.find((candidate) => candidate === lineOf(source, "kind"));
  const title = lineOf(source, "title");
  if (kind === undefined || title === "") return "Say where it came from: source with its kind and a title.";
  const messageId = lineOf(source, "message_id");
  const account = lineOf(source, "account");
  const uid = lineOf(source, "event_uid");
  return {
    kind,
    title,
    ...(kind === "mail" && messageId !== "" && { mail: { message_id: messageId, ...(account !== "" && { account }) } }),
    ...(kind === "calendar" && uid !== "" && { event: { uid } }),
  };
};

const everyDay: Repeat = { days: [...weekdays], time: "09:00" };

const withoutRepeat = (wakeUp: WakeUp): WakeUp =>
  Object.fromEntries(Object.entries(wakeUp).filter(([field]) => field !== "repeat")) as WakeUp;

const sourceWords = ({ kind, title }: WakeUpSource): string => {
  switch (kind) {
    case "chat": {
      return `your chat (${title})`;
    }
    case "mail": {
      return `a mail: ${title}`;
    }
    case "calendar": {
      return `their calendar: ${title}`;
    }
    case "wake_up": {
      return `an earlier wake-up: ${title}`;
    }
  }
};

const repeatSchema = {
  type: "object",
  description: "For one that comes back, such as weekdays at 09:00, on their local clock wherever they are.",
  properties: {
    days: { type: "array", items: { enum: weekdays }, minItems: 1, maxItems: 7 },
    time: { type: "string", description: "Such as 09:00." },
  },
  required: ["days", "time"],
  additionalProperties: false,
};

export const createWakeUps = ({
  store,
  isMotion,
  clock,
  timeZone,
  identifiers,
  work,
  postedIn,
  event,
  desk,
  info,
}: WakeUpsOptions): WakeUps => {
  const wakeUps = createCell<ReadonlyMap<string, WakeUp>>(new Map(store.list().map((saved) => [saved.id, saved])));
  const timers = createCell<ReadonlyMap<string, Cancel>>(new Map());
  const running = createCell<ReadonlySet<string>>(new Set());
  const isClosed = createCell(false);

  const sorted = (): readonly WakeUp[] =>
    wakeUps
      .get()
      .values()
      .toArray()
      .toSorted((left, right) => left.at.localeCompare(right.at) || left.id.localeCompare(right.id));

  const publish = (): void => {
    if (!isClosed.get()) desk.setPlans(sorted());
  };

  const whenOf = (at: number): string =>
    new Intl.DateTimeFormat("en-GB", {
      timeZone: timeZone(),
      weekday: "short",
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(at);

  const disarm = (id: string): void => {
    timers.get().get(id)?.();
    timers.update((current) => new Map([...current].filter(([other]) => other !== id)));
  };

  const arm = (wakeUp: WakeUp): void => {
    disarm(wakeUp.id);
    if (isClosed.get()) return;
    const wait = Math.min(Math.max(0, Date.parse(wakeUp.at) - clock.now()), longestTimerMs);
    const cancel = clock.after(wait, () => {
      timers.update((current) => new Map([...current].filter(([other]) => other !== wakeUp.id)));
      const current = wakeUps.get().get(wakeUp.id);
      if (!current) return;
      if (Date.parse(current.at) > clock.now()) arm(current);
      else void run(current.id);
    });
    timers.update((current) => new Map([...current, [wakeUp.id, cancel]]));
  };

  const save = (wakeUp: WakeUp): void => {
    store.save(wakeUp);
    wakeUps.update((current) => new Map([...current, [wakeUp.id, wakeUp]]));
    arm(wakeUp);
    publish();
  };

  const remove = (id: string): void => {
    disarm(id);
    store.remove(id);
    wakeUps.update((current) => new Map([...current].filter(([other]) => other !== id)));
    publish();
  };

  // A repeating wake-up at its next time where they are now.
  const nextTime = (wakeUp: WakeUp, repeat: Repeat): WakeUp => {
    const next = nextOf(repeat, clock.now(), timeZone());
    return { ...wakeUp, at: toTimestamp(next) };
  };

  const describe = (wakeUp: WakeUp): string =>
    `- ${wakeUp.id}: “${wakeUp.what}” at ${whenOf(Date.parse(wakeUp.at))}` +
    (wakeUp.repeat ? `, repeating ${repeatWords(wakeUp.repeat)}` : "") +
    `; ${wakeUp.by === "you" ? "they asked" : "yours"}, from ${sourceWords(wakeUp.source)}`;

  const eventLine = (uid: string): string => {
    const found = event(uid);
    if (!found) return "That event is no longer on their calendar.";
    const start = Date.parse(found.start);
    return found.all_day
      ? `That event, ${found.title}, is on ${found.start.slice(0, 10)}.`
      : `That event, ${found.title}, is now ${whenOf(start)} to ${whenOf(Date.parse(found.end)).slice(-5)}.`;
  };

  const promptOf = (wakeUp: WakeUp): string =>
    [
      `It's ${toSpoken(clock.now(), timeZone())}. A wake-up you set has come due: “${wakeUp.what}”.`,
      `Why: ${wakeUp.why}`,
      `${wakeUp.by === "you" ? "They asked for it" : "You set it yourself"}, from ${sourceWords(wakeUp.source)}.`,
      ...(wakeUp.source.event ? [eventLine(wakeUp.source.event.uid)] : []),
      ...(wakeUp.motion === undefined ? [] : [`It's about ${wakeUp.motion}: read it with read_motion first.`]),
      ...(wakeUp.repeat
        ? [`It repeats ${repeatWords(wakeUp.repeat)} and comes back by itself; move it only if this time is wrong.`]
        : []),
      "",
      "Look first at what's changed since you set it: the calendar, your memory, the end of the conversation.",
      "Then do what fits:",
      "- Message them with post if it's useful now.",
      `- If now is the wrong time, such as the event moving or them being asleep, move it with move_wake_up (${wakeUp.id}).`,
      `- If it's moot, such as the event being cancelled or it already being done, drop it with drop_wake_up.`,
      "- When nothing is worth their attention, say nothing.",
      "End with one line saying what you did and why, for their Done list.",
    ].join("\n");

  const record = (before: WakeUp, run: string, answer: string): void => {
    const after = wakeUps.get().get(before.id);
    const reason = lastLine(answer);
    const why = reason === "" ? {} : { reason };
    if (!after) {
      desk.addDone({ text: `Dropped “${before.what}”`, ...why, quiet: false });
      return;
    }
    if (after.at !== before.at && Date.parse(after.at) > clock.now()) {
      desk.addDone({ text: `Moved “${before.what}” to ${whenOf(Date.parse(after.at))}`, ...why, quiet: false });
      return;
    }
    const isMessaged = postedIn(run);
    desk.addDone({
      text: isMessaged ? `Woke up for “${before.what}” and messaged you` : `Woke up for “${before.what}”`,
      ...why,
      quiet: !isMessaged,
    });
    if (after.repeat) save(nextTime(after, after.repeat));
    else remove(after.id);
  };

  const attempt = async (prompt: string, run: string): Promise<Result<string, string>> => {
    try {
      return await work(prompt, run);
    } catch (error) {
      return fail(String(error));
    }
  };

  const run = async (id: string): Promise<void> => {
    const due = wakeUps.get().get(id);
    if (!due || running.get().has(id) || isClosed.get()) return;
    running.update((current) => new Set([...current, id]));
    disarm(id);
    const piece = `wake-up-${randomUUID()}`;
    const done = await attempt(promptOf(due), piece);
    running.update((current) => new Set([...current].filter((other) => other !== id)));
    if (isClosed.get()) return;
    if (done.ok) {
      record(due, piece, done.value);
      return;
    }
    // Nothing robotic stands in: it waits, the problem shows, and Kumo looks again soon.
    info("A wake-up couldn't be looked at, so it waits", { wakeUp: id, error: done.failure });
    const after = wakeUps.get().get(id);
    if (after && Date.parse(after.at) <= clock.now()) save({ ...after, at: toTimestamp(clock.now() + retryMs) });
  };

  const toNew = (input: unknown): Result<WakeUp, string> => {
    const now = clock.now();
    const what = lineOf(input, "what");
    const why = textOf(input, "why").trim();
    if (what === "" || why === "") return fail("Say what it's for in a line, and why.");
    const repeat = toRepeat(fieldOf(input, "repeat"));
    if (typeof repeat === "string") return fail(repeat);
    const given = lineOf(input, "at");
    const at = given === "" ? undefined : toInstant(given, now);
    if (typeof at === "string") return fail(at);
    if (at === undefined && repeat === undefined) return fail("Say when: at, or a repeat.");
    const source = toSource(input);
    if (typeof source === "string") return fail(source);
    const motion = lineOf(input, "motion");
    if (motion !== "" && !isMotion(motion)) return fail(`There's no thing ${motion} in motion.`);
    const first = at ?? nextOf(repeat ?? everyDay, now, timeZone());
    return ok({
      id: identifiers.wakeUp(),
      at: toTimestamp(first),
      what,
      why,
      ...(repeat && { repeat }),
      by: fieldOf(input, "asked") === true ? "you" : "kumo",
      source,
      ...(motion !== "" && { motion }),
      set_at: toTimestamp(now),
    });
  };

  // A change, from Kumo or from the app: a new time, a new repeat or none, new words.
  const changed = (
    current: WakeUp,
    at: string | undefined,
    repeat: Repeat | null | undefined,
    what: string,
    why: string,
  ): Result<WakeUp, string> => {
    const now = clock.now();
    const instant = at === undefined ? undefined : toInstant(at, now);
    if (typeof instant === "string") return fail(instant);
    const kept = repeat === null ? withoutRepeat(current) : { ...current, ...(repeat && { repeat }) };
    const next =
      instant ?? (repeat === undefined || repeat === null ? Date.parse(current.at) : nextOf(repeat, now, timeZone()));
    return ok({
      ...kept,
      at: toTimestamp(next),
      ...(what !== "" && { what }),
      ...(why !== "" && { why }),
    });
  };

  const tools: readonly Tool[] = [
    {
      name: "set_wake_up",
      title: "Set a wake-up",
      description:
        "Set a time to wake up and look at something, one-off or repeating, at a concrete time you've worked out, " +
        "such as when the interview ends. When it comes due you look first, then message them, move it or drop " +
        "it. Setting one is quiet: it shows in your plans on their Desk, where they can move or cancel it.",
      inputSchema: {
        type: "object",
        properties: {
          what: {
            type: "string",
            description: "What it's for, in a line, such as “Ask how the Halcyon technical went”.",
          },
          why: {
            type: "string",
            description: "What you'll want in mind when you wake: why it matters, and what to look at.",
          },
          at: {
            type: "string",
            description:
              "When, as an instant with its offset, such as 2026-11-12T15:30:00Z. Leave out for a repeating one to " +
              "start at its next time.",
          },
          repeat: repeatSchema,
          asked: { type: "boolean", description: "True when they asked for it; false when you set it yourself." },
          source: {
            type: "object",
            description: "Where it came from.",
            properties: {
              kind: { enum: sources },
              title: { type: "string", description: "A line naming it, such as “Tess Harlow: Thursday's technical”." },
              account: { type: "string", description: "mail: the account." },
              message_id: { type: "string", description: "mail: its Message-ID." },
              event_uid: { type: "string", description: "calendar: the event's uid." },
            },
            required: ["kind", "title"],
            additionalProperties: false,
          },
          motion: { type: "string", description: "The thing in motion it's about, by id." },
        },
        required: ["what", "why", "asked", "source"],
        additionalProperties: false,
      },
      call: (input) => {
        const made = toNew(input);
        if (!made.ok) return Promise.resolve(failed(made.failure));
        save(made.value);
        return Promise.resolve({ text: `Set ${made.value.id} for ${whenOf(Date.parse(made.value.at))}.` });
      },
    },
    {
      name: "move_wake_up",
      title: "Move a wake-up",
      description:
        "Move one of your wake-ups, or change how it repeats or what it's for, by its id: when life moves, such as " +
        "the event it's for moving, them travelling, or now being the wrong moment. For a repeating one, at moves " +
        "only its next time.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string" },
          at: { type: "string", description: "The new time, an instant with its offset." },
          repeat: repeatSchema,
          one_off: { type: "boolean", description: "True to stop it repeating." },
          what: { type: "string" },
          why: { type: "string" },
        },
        required: ["id"],
        additionalProperties: false,
      },
      call: (input) => {
        const id = lineOf(input, "id");
        const current = wakeUps.get().get(id);
        if (!current) return Promise.resolve(failed(`There's no wake-up ${id || "with that id"}.`));
        const repeat = toRepeat(fieldOf(input, "repeat"));
        if (typeof repeat === "string") return Promise.resolve(failed(repeat));
        const given = lineOf(input, "at");
        const next = changed(
          current,
          given === "" ? undefined : given,
          fieldOf(input, "one_off") === true ? null : repeat,
          lineOf(input, "what"),
          textOf(input, "why").trim(),
        );
        if (!next.ok) return Promise.resolve(failed(next.failure));
        save(next.value);
        return Promise.resolve({ text: `${next.value.what} is at ${whenOf(Date.parse(next.value.at))} now.` });
      },
    },
    {
      name: "drop_wake_up",
      title: "Drop a wake-up",
      description:
        "Drop one of your wake-ups by its id, when it's moot, such as the event being cancelled, or when they say " +
        "they no longer want it.",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string" }, reason: { type: "string", description: "Why, in a line." } },
        required: ["id", "reason"],
        additionalProperties: false,
      },
      call: (input) => {
        const id = lineOf(input, "id");
        const found = wakeUps.get().get(id);
        if (!found) return Promise.resolve(failed(`There's no wake-up ${id || "with that id"}.`));
        remove(id);
        return Promise.resolve({ text: `Dropped ${found.what}.` });
      },
    },
  ];

  for (const wakeUp of wakeUps.get().values()) arm(wakeUp);
  publish();

  return {
    tools,
    list: sorted,
    change: (id, given) => {
      const current = wakeUps.get().get(id);
      if (!current) return fail("not_found");
      const next = changed(current, given.at, given.repeat, given.what?.trim() ?? "", given.why?.trim() ?? "");
      if (next.ok) save(next.value);
      return next;
    },
    cancel: (id) => {
      if (!wakeUps.get().has(id)) return false;
      remove(id);
      return true;
    },
    inMindText: () => {
      const listed = sorted();
      return listed.length === 0
        ? ""
        : [
            "<wake_ups>",
            "Your wake-ups, soonest first; they can move or cancel them in Ito too:",
            ...listed.map(describe),
            "</wake_ups>",
          ].join("\n");
    },
    tiedTo: (uids) => sorted().filter(({ source }) => source.event !== undefined && uids.includes(source.event.uid)),
    describe,
    refit: () => {
      for (const wakeUp of sorted()) {
        if (wakeUp.repeat) save(nextTime(wakeUp, wakeUp.repeat));
      }
    },
    close: () => {
      isClosed.set(true);
      for (const cancel of timers.get().values()) cancel();
      timers.set(new Map());
    },
  };
};
