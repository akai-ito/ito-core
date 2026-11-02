import { createCell } from "#cell.ts";
import { toTimestamp, type Cancel, type Clock } from "#clock.ts";
import type { Activity } from "#day/blocks.ts";
import { minuteMs, toLocal, toMinutes, toSpoken } from "#desk/day.ts";
import { lastLine, type CardAnswer, type MomentHandler, type Work } from "#desk/desk.ts";
import type { Line, Moments } from "#desk/moments.ts";
import type { Night, Nights, Stage } from "#day/nights.ts";
import type { DayPicture } from "#day/picture.ts";
import type { Question, Questions } from "#day/questions.ts";
import { atLocal, clockOf, hourMs, isClock, lengthOf, nextDay, spokenTime, toClock, weekdayOf } from "#day/time.ts";
import type { Complete, JsonSchema } from "#engine/engine.ts";
import type { Motions } from "#motion/motion.ts";
import type { Presence } from "#notifications/presence.ts";
import type { Desk, ModelChoice } from "#protocol/types.ts";
import { ok, type Result } from "#result.ts";
import type { Store } from "#store/store.ts";
import { fieldOf, textOf } from "#tools/input.ts";
import type { Info } from "#turns/turns.ts";

// Kumo's check-ins, as its line at the top of the Desk: in the evening, if they're likely to build, a commitment to
// when they'll stop and what's next; near and past that line, an honest trade-off with tomorrow; when the week's
// time drifts from what matters, a plain look at it; and the day's one small question.
export type Checkins = {
  // Shows one check-in now, whatever the time, for the demo.
  readonly show: (kind: DemoCheckin) => Promise<string>;
  readonly close: () => void;
};

export type DemoCheckin = "commit" | "pre" | "past" | "question" | "drift";

export type CheckinsOptions = {
  readonly store: Pick<Store, "desk" | "subscribe" | "setting" | "setSetting">;
  readonly clock: Clock;
  readonly timeZone: string;
  readonly presence: Pick<Presence, "isWatched" | "onWatched">;
  readonly isBusy: () => boolean;
  readonly isGettingStarted: () => boolean;
  readonly nights: Nights;
  readonly picture: Pick<DayPicture, "dayItems" | "dayLines" | "goals" | "hours">;
  readonly questions: Questions;
  readonly moments: Pick<Moments, "say">;
  readonly complete: Complete;
  readonly choice: () => Promise<ModelChoice | undefined>;
  readonly work: Work;
  readonly motions: Pick<Motions, "list">;
  readonly lead: () => string;
  readonly morning: () => string;
  readonly info: Info;
  // What Kumo knows they're doing now, such as their Focus, for a prompt.
  readonly now?: () => readonly string[];
  // Why they're likely to build tonight from what they've said or their status, if they are.
  readonly likely?: () => string | undefined;
  // Whether they've gone to sleep, such as with their Sleep Focus on.
  readonly isAsleep?: () => boolean;
};

export const driftSetting = "day_drift";

export const tickMs = 5 * minuteMs;
const beforeMs = 15 * minuteMs;
const pastMs = 15 * minuteMs;
const laterMs = 60 * minuteMs;
const lastPastMs = 3 * hourMs;
const lastLaterMs = 4 * hourMs;
const snoozeMs = 15 * minuteMs;
const calmMs = 10 * minuteMs;
const sleepHours = 7.5;
const readyMs = 45 * minuteMs;
const driftEveryMs = 7 * 24 * hourMs;
const weekMs = 7 * 24 * hourMs;
const enoughHours = 10;
const eveningFrom = 20 * 60 + 30;
const eveningUntil = 23 * 60 + 30;
const dayUntil = 21 * 60;
const driftFrom = 17 * 60;
const morningFrom = 5 * 60;
const morningUntil = 12 * 60;
const fallbackStop = "00:30";
const stopping = "I'm stopping";
const snooze = "Snooze 15m";
const notTonight = "Not tonight";
const itsRight = "It's right";
const shiftIt = "Shift it";

const commitSchema: JsonSchema = {
  type: "object",
  properties: { text: { type: "string" }, stop: { type: "string" } },
  required: ["text", "stop"],
  additionalProperties: false,
};

const lineSchema: JsonSchema = {
  type: "object",
  properties: { text: { type: "string" }, options: { type: "array", items: { type: "string" } } },
  required: ["text", "options"],
  additionalProperties: false,
};

const stopSchema: JsonSchema = {
  type: "object",
  properties: { stop: { type: "string" }, next_step: { type: "string" } },
  required: ["stop", "next_step"],
  additionalProperties: false,
};

const said = (answer: CardAnswer): string => answer.option ?? answer.text ?? "";

const optionsOf = (value: unknown, count: number): readonly string[] =>
  (Array.isArray(fieldOf(value, "options")) ? (fieldOf(value, "options") as readonly unknown[]) : [])
    .filter((option): option is string => typeof option === "string")
    .map((option) => option.trim())
    .filter((option) => option !== "" && option.length <= 24 && !/stop/iu.test(option))
    .slice(0, count);

const rules = [
  "- Plain, warm and honest, in one or two short sentences, as you'd say it in person. The words carry it: no",
  "  alarm, no scolding, no exclamation marks.",
  "- Only what's here: never invent a fact, a time or a feeling.",
];

const noReason = (): string | undefined => undefined;

const parsePrompt = (text: string, proposed: string): string =>
  [
    `You asked them when they'll stop building tonight, suggesting ${proposed}. They answered: ${text}`,
    "stop: the time they'll stop, as HH:MM in 24 hours, such as 01:30; the suggestion if they didn't name one.",
    "next_step: the next step they named, in their words; empty if none.",
  ].join("\n");

const hoursText = (hours: ReadonlyMap<Activity, number>): string =>
  [...hours]
    .filter(([, value]) => value >= 0.5)
    .toSorted(([, left], [, right]) => right - left)
    .map(([activity, value]) => `${activity} ${String(Math.round(value * 2) / 2)}h`)
    .join(", ");

export const createCheckins = ({
  store,
  clock,
  timeZone,
  presence,
  isBusy,
  isGettingStarted,
  nights,
  picture,
  questions,
  moments,
  complete,
  choice,
  work,
  motions,
  lead,
  morning,
  info,
  now: nowLines = () => [],
  likely = noReason,
  isAsleep = () => false,
}: CheckinsOptions): Checkins => {
  const timer = createCell<Cancel | undefined>(undefined);
  const running = createCell<Promise<void>>(Promise.resolve());
  const isClosed = createCell(false);
  const known = createCell<Desk>(store.desk());

  const stamp = (): string => toTimestamp(clock.now());

  const minutesOf = (at: number): number => toLocal(at, timeZone).minutes;

  const write = async (prompt: string, schema: JsonSchema): Promise<unknown> => {
    const answered = await complete(prompt, schema, await choice());
    if (answered.ok) return answered.value;
    info("Kumo couldn't write a check-in", { error: answered.failure });
    return undefined;
  };

  // Tomorrow, seen from tonight: Kumo's plan and what's fixed, and when they'd need to sleep to keep all of it.
  const tomorrow = (night: string): { readonly lines: readonly string[]; readonly asleepBy?: number } => {
    const day = nextDay(night);
    const first = picture
      .dayItems(day)
      .filter((item) => !item.all_day && !item.guess)
      .find((item) => {
        const minutes = minutesOf(Date.parse(item.start));
        return minutes >= morningFrom && minutes < morningUntil;
      });
    const asleepBy = first && Date.parse(first.start) - readyMs - sleepHours * hourMs;
    const lines = picture.dayLines(day);
    return {
      lines: [
        `Tomorrow (${weekdayOf(Date.parse(`${day}T12:00:00.000Z`), "UTC")}):`,
        ...(lines.length > 0 ? lines : ["- Nothing planned yet."]),
        ...(first && asleepBy !== undefined
          ? [
              `To keep all of tomorrow with ${String(sleepHours)} hours of sleep, they'd need to be asleep by ` +
                `${clockOf(asleepBy, timeZone)} (the first thing is ${first.title} at ${clockOf(Date.parse(first.start), timeZone)}).`,
            ]
          : []),
      ],
      ...(asleepBy !== undefined && { asleepBy }),
    };
  };

  const proposedStop = (night: string): string => {
    const earlier = nights.recent(14).find((entry) => entry.night !== night && entry.stop !== undefined)?.stop;
    if (earlier !== undefined) return earlier;
    const { asleepBy } = tomorrow(night);
    if (asleepBy === undefined) return fallbackStop;
    const minutes = Math.floor(minutesOf(asleepBy) / 15) * 15;
    const isSensible = minutes >= 22 * 60 + 30 || minutes <= 90;
    return isSensible ? toClock(minutes) : fallbackStop;
  };

  const inMotion = (): readonly string[] =>
    motions
      .list()
      .filter(({ status }) => status === "active")
      .map(({ title, kind, summary }) => `- ${title} (${kind}): ${summary}`);

  const isUp = (since: number): boolean => !isAsleep() && (presence.isWatched() || (nights.lastActive() ?? 0) > since);

  // Whether a line can go out without cutting across one they haven't seen.
  const isCalm = (now: number): boolean => {
    const current = store.desk().moment;
    if (!current) return true;
    if (current.state === "working") return false;
    return current.read_at !== undefined && Date.parse(current.read_at) < now - calmMs;
  };

  const likelyToBuild = (night: string): string | undefined => {
    const evening = picture
      .dayItems(night)
      .find((item) => item.guess?.activity === "building" && Date.parse(item.end) > atLocal(night, 19 * 60, timeZone));
    if (evening) return `you guessed they'll be building from ${clockOf(Date.parse(evening.start), timeZone)}`;
    const told = likely();
    if (told !== undefined) return told;
    const late = nights
      .recent(8)
      .filter((entry) => entry.night !== night && entry.lastActive !== undefined)
      .filter((entry) => minutesOf(Date.parse(entry.lastActive ?? "")) < morningFrom).length;
    return late >= 2 ? `they've been up past midnight on ${String(late)} of the last 7 nights` : undefined;
  };

  // Acts on what they chose to give up for more time tonight: Kumo moves or drops that block.
  const giveUp = async (night: Night, what: string): Promise<Result<string, string>> => {
    const record = nights.change(night.night, (current) => ({ ...current, gaveUp: [...(current.gaveUp ?? []), what] }));
    const done = await work(
      [
        `It's past the line they set tonight (${spokenTime(record.stop ?? "")}), and they chose to keep going at the cost`,
        `of tomorrow's ${what}.`,
        ...tomorrow(record.night).lines,
        "Move that block on your own calendar to later in the day if it fits, or remove it; never touch theirs.",
        "End with one line for their Done list saying what you did.",
      ].join("\n"),
    );
    return done.ok ? ok(lastLine(done.value)) : done;
  };

  const lineHandler = (night: string): MomentHandler => ({
    answer: async (_moment, answer) => {
      const record = nights.get(night) ?? { night };
      if (answer.option === stopping) {
        nights.change(night, (current) => ({ ...current, stoppedAt: stamp() }));
        return ok("Good night. Tomorrow's plan stands.");
      }
      if (answer.option === snooze) {
        const again = clock.now() + snoozeMs;
        nights.change(night, (current) => ({ ...current, snoozedTo: toTimestamp(again) }));
        return ok(`I'll ask again at ${clockOf(again, timeZone)}.`);
      }
      if (answer.option !== undefined) return giveUp(record, answer.option);
      const step = said(answer).trim();
      nights.change(night, (current) => ({ ...current, nextStep: step }));
      return ok(`Noted for tomorrow: ${step}`);
    },
  });

  const commitHandler = (night: string, proposed: string): MomentHandler => ({
    answer: async (_moment, answer) => {
      if (answer.option === notTonight) {
        nights.change(night, (current) => ({ ...current, building: false }));
        return ok("No check-ins tonight.");
      }
      const parsed =
        answer.text === undefined ? undefined : await write(parsePrompt(answer.text, proposed), stopSchema);
      const stop = isClock(textOf(parsed, "stop")) ? textOf(parsed, "stop") : proposed;
      const step = answer.text === undefined ? "" : textOf(parsed, "next_step").trim() || answer.text.trim();
      nights.change(night, (current) => ({
        ...current,
        building: true,
        stop,
        ...(step !== "" && { nextStep: step }),
      }));
      const before = toClock(toMinutes(stop) - 15);
      return ok(`Tonight's line is ${spokenTime(stop)}; I'll check in at ${spokenTime(before)}.`);
    },
  });

  const askCommit = async (night: string, reason: string): Promise<string> => {
    nights.change(night, (current) => ({ ...current, asked: stamp() }));
    const proposed = proposedStop(night);
    const earlier = nights.lately(clock.now());
    const motion = inMotion();
    const written = await write(
      [
        `You are ${lead()}, their chief of staff. It's ${toSpoken(clock.now(), timeZone)}, and they're likely to`,
        `build tonight: ${reason}.`,
        "Write one short line at the top of their Desk asking them to commit now to when they'll stop tonight and",
        "what the next step will be, so stopping later is easy. Such as: Building tonight? Stop at 1, next step being…?",
        "",
        ...tomorrow(night).lines,
        ...(motion.length > 0 ? ["", "Things in motion, including any commitment about evenings:", ...motion] : []),
        ...(earlier.length > 0 ? ["", "Their last nights:", ...earlier] : []),
        "",
        `stop: the time to suggest as HH:MM, ${proposed} unless something in motion names a stop time they chose.`,
        ...rules,
      ].join("\n"),
      commitSchema,
    );
    const stop = isClock(textOf(written, "stop")) ? textOf(written, "stop") : proposed;
    const text = textOf(written, "text").trim() || `Building tonight? Stop at ${spokenTime(stop)}, and the next step?`;
    await moments.say({
      kind: "checkin",
      text,
      options: [`Stop at ${spokenTime(stop)}`, notTonight],
      allowsText: true,
      replyLabel: "Next step",
      matters: true,
      handler: commitHandler(night, stop),
    });
    return text;
  };

  const stageDue = (night: Night, now: number): Stage | undefined => {
    if (night.stop === undefined) return undefined;
    const stopAt = nights.stopAt(night.night, night.stop);
    const lines = night.lines ?? {};
    const preAt = stopAt - beforeMs;
    const pre = lines.pre === undefined ? undefined : Date.parse(lines.pre);
    const snoozed = night.snoozedTo === undefined ? undefined : Date.parse(night.snoozedTo);
    if (now >= preAt && now < stopAt + pastMs) {
      if (pre === undefined) return "pre";
      if (snoozed !== undefined && now >= snoozed && pre < snoozed) return "pre";
    }
    const past = lines.past === undefined ? undefined : Date.parse(lines.past);
    if (past === undefined && now >= stopAt + pastMs && now < stopAt + lastPastMs && isUp(pre ?? preAt)) return "past";
    const isLate = past !== undefined && lines.later === undefined && now >= past + laterMs;
    return isLate && now < stopAt + lastLaterMs && isUp(past) ? "later" : undefined;
  };

  const stagePrompt = (night: Night, stage: Stage, now: number): string => {
    const stop = spokenTime(night.stop ?? "");
    const stopAt = nights.stopAt(night.night, night.stop ?? "");
    const last = nights.lastActive();
    const why = {
      pre:
        "Write the line for just before their stop: the time left, an offer to note the next step now, and what " +
        "tomorrow still fits if they stop soon. Such as: 15 minutes to your 1. Note the next step now? Tomorrow's " +
        "run and prep still fit if you're asleep by 1:30.",
      past:
        "They're past the line they set. Write a firmer line, honest about what each half hour now costs from " +
        "tomorrow's plan, and leave the choice to them. Such as: Every half hour now comes out of tomorrow's run " +
        "or the interview prep. Your call. Which?",
      later:
        "They're still going, an hour past the line they set. Write a firmer line still: plainly what tonight has " +
        "cost tomorrow already, and the choice. Still kind, and theirs to make.",
    }[stage];
    return [
      `You are ${lead()}, their chief of staff. It's ${toSpoken(now, timeZone)}. Tonight they said they'd stop at`,
      `${stop}${night.nextStep === undefined ? "" : `, with the next step: ${night.nextStep}`}.`,
      ...(stage === "pre" ? [`That's ${lengthOf(stopAt - now)} from now.`] : []),
      ...(stage === "pre" || last === undefined
        ? []
        : [`They're still going: their last sign was at ${clockOf(last, timeZone)}.`]),
      ...nowLines(),
      "",
      ...tomorrow(night.night).lines,
      "",
      why,
      stage === "pre"
        ? "options: leave empty."
        : "options: one or two short names for what in tomorrow's plan they'd give up, such as The run, The prep.",
      ...rules,
    ].join("\n");
  };

  const fallbackOf = (night: Night, stage: Stage, now: number): string => {
    const stop = spokenTime(night.stop ?? "");
    const stopAt = nights.stopAt(night.night, night.stop ?? "");
    if (stage === "pre") return `${lengthOf(stopAt - now)} to your ${stop}. Note the next step now?`;
    return stage === "past"
      ? `It's past your ${stop}. Your call.`
      : `It's ${clockOf(now, timeZone)}, well past your ${stop}.`;
  };

  const checkIn = async (night: Night, stage: Stage): Promise<string> => {
    const now = clock.now();
    nights.change(night.night, (current) => ({ ...current, lines: { ...current.lines, [stage]: toTimestamp(now) } }));
    const written = await write(stagePrompt(night, stage, now), lineSchema);
    const text = textOf(written, "text").trim() || fallbackOf(night, stage, now);
    const line: Line =
      stage === "pre"
        ? {
            kind: "checkin",
            text,
            options: [snooze],
            allowsText: true,
            replyLabel: "Note it",
            matters: true,
            handler: lineHandler(night.night),
          }
        : {
            kind: "checkin",
            text,
            options: [...optionsOf(written, 2), stopping],
            allowsText: false,
            matters: true,
            handler: lineHandler(night.night),
          };
    await moments.say(line);
    return text;
  };

  const questionHandler = (question: Question): MomentHandler => ({
    answer: async (_moment, answer) => {
      questions.mark(question.id, { outcome: "answered" });
      const done = await work(
        [
          `You asked them today's question at the top of their Desk: ${question.text}`,
          `They answered: ${said(answer)}`,
          "Write it into memory where it belongs (How to help you, or the page it's about), replacing what it",
          "changes, so you keep helping the person they are now. End with one line for their Done list.",
        ].join("\n"),
      );
      return done.ok ? ok(lastLine(done.value)) : done;
    },
    skip: () => {
      questions.mark(question.id, { outcome: "skipped" });
    },
  });

  const askQuestion = async (question: Question): Promise<string> => {
    questions.mark(question.id, { askedAt: stamp() });
    await moments.say({
      kind: "question",
      text: question.text,
      options: question.options,
      allowsText: false,
      matters: false,
      handler: questionHandler(question),
    });
    return question.text;
  };

  type DriftState = { readonly checked?: string; readonly said?: string };

  const driftState = (): DriftState => {
    const saved = store.setting(driftSetting);
    return saved === undefined ? {} : (JSON.parse(saved) as DriftState);
  };

  const driftHandler = (text: string): MomentHandler => ({
    answer: async (_moment, answer) => {
      const done = await work(
        [
          `At the top of their Desk you named how their week's time went: ${text}`,
          `They answered: ${said(answer)}`,
          answer.option === itsRight
            ? "Note on How to help you that this split is what they want for now, so you don't raise it again soon."
            : "Shift your plan blocks for the coming days towards what they want, and note the split they chose on " +
              "How to help you.",
          "End with one line for their Done list.",
        ].join("\n"),
      );
      return done.ok ? ok(lastLine(done.value)) : done;
    },
  });

  const checkDrift = async (now: number, isForced = false): Promise<string> => {
    const state = driftState();
    const today = toLocal(now, timeZone).day;
    const isRecent = state.said !== undefined && Date.parse(state.said) > now - driftEveryMs;
    if (!isForced && (isRecent || state.checked === today)) return "";
    store.setSetting(driftSetting, JSON.stringify({ ...state, checked: today }));
    const { guessed, planned } = picture.hours(now - weekMs, now);
    const total = [...guessed.values(), ...planned.values()].reduce((sum, value) => sum + value, 0);
    if (!isForced && total < enoughHours) return "";
    const goals = await picture.goals();
    const late = nights.lately(now);
    const written = await write(
      [
        `You are ${lead()}, their chief of staff. It's ${toSpoken(now, timeZone)}. Look honestly at how their last`,
        "week's time went against what they're working towards.",
        "",
        `Your picture of their last 7 days (your guesses, with their corrections): ${hoursText(guessed) || "little yet"}.`,
        `What you planned for them in those days: ${hoursText(planned) || "nothing yet"}.`,
        ...(late.length > 0 ? ["Their nights:", ...late.map((line) => `- ${line}`)] : []),
        ...(goals.length > 0 ? ["What they're working towards:", ...goals] : []),
        "",
        "If their time has drifted from what matters to them, write one line that names it in plain numbers and",
        "asks whether it's still the right split, such as: Last week: about 14h building, 1h interview prep, and",
        "the Northwind interview is in 10 days. Still the right split? If it looks right for what matters to them,",
        "leave text empty: a fine week gets no line.",
        "options: leave empty.",
        ...rules,
      ].join("\n"),
      lineSchema,
    );
    const text = textOf(written, "text").trim();
    if (text === "") return "";
    store.setSetting(driftSetting, JSON.stringify({ checked: today, said: toTimestamp(now) }));
    await moments.say({
      kind: "drift",
      text,
      options: [itsRight, shiftIt],
      allowsText: true,
      matters: false,
      handler: driftHandler(text),
    });
    return text;
  };

  const evaluate = async (): Promise<void> => {
    if (isClosed.get() || isGettingStarted()) return;
    const now = clock.now();
    const night = nights.nightOf(now);
    const record = nights.get(night);
    const minutes = minutesOf(now);
    // Tonight's line holds the night until they stop, or until its last check-in could be due.
    const isLineOpen =
      record?.stop !== undefined &&
      record.building !== false &&
      record.stoppedAt === undefined &&
      now < nights.stopAt(record.night, record.stop) + lastLaterMs;
    if (record && isLineOpen) {
      if (isAsleep()) return;
      const stage = stageDue(record, now);
      if (stage) await checkIn(record, stage);
      return;
    }
    const isEvening = minutes >= eveningFrom && minutes < eveningUntil;
    if (isEvening && record?.asked === undefined && !isBusy() && !isAsleep()) {
      const reason = likelyToBuild(night);
      if (reason !== undefined) {
        await askCommit(night, reason);
        return;
      }
    }
    const isDaytime = minutes >= toMinutes(morning()) + 60 && minutes < dayUntil;
    if (!isDaytime || !presence.isWatched() || !isCalm(now) || isBusy()) return;
    const question = questions.next();
    if (question) {
      await askQuestion(question);
      return;
    }
    if (minutes >= driftFrom) await checkDrift(now);
  };

  const run = (job: () => Promise<unknown>): Promise<void> =>
    running.update(async (previous) => {
      await previous;
      if (isClosed.get()) return;
      try {
        await job();
      } catch (error) {
        info("A check-in failed", { error: String(error) });
      }
    });

  const tick = (): void => {
    if (isClosed.get()) return;
    timer.set(
      clock.after(tickMs - (clock.now() % tickMs), () => {
        void run(evaluate).then(tick);
      }),
    );
  };

  // A sign of them: a message, a line or card answered, or the Desk read.
  const onDesk = (after: Desk): void => {
    const before = known.get();
    known.set(after);
    const isRead = after.moment?.read_at !== undefined && before.moment?.read_at === undefined;
    const isAnswered = after.moment?.state === "working" && before.moment?.state !== "working";
    const working = new Set(before.waiting.filter(({ state }) => state === "working").map(({ id }) => id));
    const isCardAnswered = after.waiting.some(({ id, state }) => state === "working" && !working.has(id));
    if (isRead || isAnswered || isCardAnswered) nights.touch(clock.now());
  };

  const unsubscribe = store.subscribe(({ event }) => {
    if (event.type === "message.accepted") nights.touch(clock.now());
    else if (event.type === "desk.changed") onDesk(event.desk);
  });
  const unwatch = presence.onWatched(() => {
    nights.touch(clock.now());
    void run(evaluate);
  });
  tick();

  const tonight = (stop: string): Night =>
    nights.change(nights.nightOf(clock.now()), (current) => ({
      night: current.night,
      asked: stamp(),
      building: true,
      stop,
      ...(current.nextStep !== undefined && { nextStep: current.nextStep }),
    }));

  return {
    show: (kind) => {
      const now = clock.now();
      const job = async (): Promise<string> => {
        switch (kind) {
          case "commit": {
            nights.change(nights.nightOf(now), (current) => ({ night: current.night }));
            return askCommit(nights.nightOf(now), "the demo asked");
          }
          case "pre": {
            const stop = Math.ceil((minutesOf(now) + 15) / 5) * 5;
            return checkIn(tonight(toClock(stop)), "pre");
          }
          case "past": {
            nights.touch(now);
            const stop = Math.floor((minutesOf(now) - 15) / 5) * 5;
            return checkIn(tonight(toClock(stop)), "past");
          }
          case "question": {
            const waiting =
              questions.next() ??
              questions.propose({
                text: "Is Thursday climbing with Leo something I should guard, or fine to move when work piles up?",
                options: ["Guard it", "Fine to move"],
                about: "Thursday climbing",
              });
            return typeof waiting === "string" ? waiting : askQuestion(waiting);
          }
          case "drift": {
            return checkDrift(now, true);
          }
        }
      };
      const result = createCell("");
      const shown = async (): Promise<string> => {
        await run(async () => {
          result.set(await job());
        });
        return result.get();
      };
      return shown();
    },
    close: () => {
      isClosed.set(true);
      timer.get()?.();
      unsubscribe();
      unwatch();
    },
  };
};
