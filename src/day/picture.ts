import { randomUUID } from "node:crypto";
import { toTimestamp, type Clock } from "#clock.ts";
import type { Calendar } from "#calendar/calendar.ts";
import { dayMs, minuteMs, toLocal, toSpoken } from "#desk/day.ts";
import type { Work } from "#desk/desk.ts";
import {
  isActivity,
  isGuessActivity,
  labelOf,
  type Activity,
  type Block,
  type BlockAnswer,
  type BlockStore,
} from "#day/blocks.ts";
import type { Nights } from "#day/nights.ts";
import { clockOf, hourMs, nextDay, spokenTime, weekdayOf } from "#day/time.ts";
import type { Motions } from "#motion/motion.ts";
import type { CalendarItem } from "#protocol/types.ts";
import { fail, ok, type Result } from "#result.ts";
import type { Settings } from "#store/store.ts";
import { fieldOf, textOf } from "#tools/input.ts";
import type { Tool, ToolResult } from "#tools/mcp.ts";
import type { Info } from "#turns/turns.ts";

// Kumo's picture of your day, on its own calendar: its plan for the day (a run from your training block, prep for a
// coming interview, proper meals, winding down) and its guesses at the rest (working, building, seeing people…),
// which you can correct. It never touches your own calendars.
export type DayPicture = {
  readonly tools: readonly Tool[];
  // Adds what Kumo knows of one of its blocks to the item, such as that it's a guess and why.
  readonly enrich: (item: CalendarItem) => CalendarItem;
  readonly answer: (id: string, answer: BlockAnswer) => Promise<Result<CalendarItem, GuessFailure>>;
  // Before the day's first line: plans the day once, then says what the line should know.
  readonly plan: () => Promise<readonly string[]>;
  // What's on a local day, on every calendar, for a prompt, with Kumo's blocks marked.
  readonly dayLines: (day: string) => readonly string[];
  // The items on a local day, both calendars, with Kumo's picture added.
  readonly dayItems: (day: string) => readonly CalendarItem[];
  // What they're working towards, from what's in motion, for a prompt.
  readonly goals: () => Promise<readonly string[]>;
  // Hours by activity between two instants: what Kumo guessed (with their corrections) and what it planned.
  readonly hours: (from: number, to: number) => Hours;
};

export type Hours = {
  readonly guessed: ReadonlyMap<Activity, number>;
  readonly planned: ReadonlyMap<Activity, number>;
};

export type GuessFailure = { readonly code: "not_found" | "unavailable"; readonly detail: string };

export type DayPictureOptions = {
  readonly blocks: BlockStore;
  readonly calendar: Pick<Calendar, "addEvent" | "changeEvent" | "isConnected" | "listItems" | "onRefreshed">;
  readonly motions: Pick<Motions, "list" | "detail">;
  readonly nights: Nights;
  readonly settings: Settings;
  readonly clock: Clock;
  readonly timeZone: string;
  readonly work: Work;
  readonly info: Info;
  readonly lead: () => string;
  readonly morning: () => string;
  // What Kumo knows they're doing now, such as their Focus, for a prompt.
  readonly now?: () => readonly string[];
};

export const plannedSetting = "day_planned";

export const planNoteSetting = "day_plan_note";

export const blockPrefix = "block-";

export const guessMark = " · guess";

const longestTitle = 40;
const longestBlockMs = 12 * hourMs;
const keptMs = 35 * dayMs;
const lookbackMs = 28 * dayMs;
const settledMs = 2 * minuteMs;
const goalDays = 21;

const failed = (text: string): ToolResult => ({ text, isError: true });

const lineOf = (value: unknown, field: string): string => textOf(value, field).replaceAll(/\s+/gu, " ").trim();

const lastLine = (text: string): string =>
  text
    .split("\n")
    .map((line) => line.trim())
    .findLast((line) => line !== "") ?? "";

const isObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const listOf = (value: unknown): readonly unknown[] => (Array.isArray(value) ? (value as readonly unknown[]) : []);

const isInstant = (text: string): boolean => /T\d{2}:\d{2}/u.test(text) && !Number.isNaN(Date.parse(text));

const withoutMark = (title: string): string => (title.endsWith(guessMark) ? title.slice(0, -guessMark.length) : title);

const notesOf = (block: Block, lead: string): string => {
  if (block.answer !== undefined) return `${lead}'s picture of your day, as you told it.`;
  return block.kind === "guess"
    ? `${lead}'s guess: ${block.why ?? ""} Tell ${lead} if it's wrong, on the Desk in Ito.`
    : `${lead}'s plan${block.why === undefined ? "" : `: ${block.why}`}. ${lead} moves it as your day changes.`;
};

const overlaps = (start: number, end: number, item: CalendarItem): boolean =>
  !item.all_day && Date.parse(item.start) < end && start < Date.parse(item.end);

const answerOf = (input: unknown): BlockAnswer | string => {
  const right = fieldOf(input, "right") === true;
  const activity = lineOf(input, "activity");
  const text = lineOf(input, "text");
  const given = [right, activity !== "", text !== ""].filter(Boolean).length;
  if (given !== 1) return "Give one of right, activity or text.";
  if (right) return { right: true };
  if (activity !== "") return isGuessActivity(activity) ? { activity } : `There's no activity ${activity}.`;
  return { text: text.slice(0, 60) };
};

export const createDayPicture = ({
  blocks,
  calendar,
  motions,
  nights,
  settings,
  clock,
  timeZone,
  work,
  info,
  lead,
  morning,
  now: nowLines = () => [],
}: DayPictureOptions): DayPicture => {
  const enrich = (item: CalendarItem): CalendarItem => {
    if (!item.calendar.kumo) return item;
    const block = blocks.find(item.uid);
    if (!block) return item;
    const withMotion = { ...item, title: block.title, ...(block.motion !== undefined && { motion: block.motion }) };
    const isGuess = block.kind === "guess" && block.answer === undefined && isGuessActivity(block.activity);
    return isGuess
      ? {
          ...withMotion,
          guess: { activity: block.activity, why: block.why ?? `Your usual ${labelOf(block.activity)}.` },
        }
      : withMotion;
  };

  // Keeps Kumo's record of its blocks true to its calendar: moved, renamed or removed there. A block written or
  // answered a moment ago is left alone, since a read that began before the write can't know of it yet.
  const sync = (): void => {
    const now = clock.now();
    const items = calendar.listItems();
    const known = blocks.between(toTimestamp(now - dayMs + minuteMs), toTimestamp(now + 7 * dayMs));
    for (const block of known) {
      const written = Math.max(Date.parse(block.at), Date.parse(block.answeredAt ?? block.at));
      if (written > now - settledMs) continue;
      const item = items.find(({ uid }) => uid === block.uid);
      if (item) {
        const title = withoutMark(item.title);
        if (item.start !== block.start || item.end !== block.end || title !== block.title) {
          blocks.save({ ...block, start: item.start, end: item.end, title });
        }
      } else {
        blocks.remove(block.uid);
      }
    }
    blocks.prune(toTimestamp(now - keptMs));
  };

  calendar.onRefreshed(sync);

  const dayItems = (day: string): readonly CalendarItem[] =>
    calendar
      .listItems()
      .filter(
        (item) => (item.all_day ? item.start.slice(0, 10) : toLocal(Date.parse(item.start), timeZone).day) === day,
      )
      .map((item) => enrich(item))
      .toSorted((left, right) => Date.parse(left.start) - Date.parse(right.start));

  const whoseOf = (item: CalendarItem): string => {
    const block = item.calendar.kumo ? blocks.find(item.uid) : undefined;
    if (item.guess) return `your guess, ${item.guess.activity}, uid ${item.uid}`;
    if (block) {
      const motion = block.motion === undefined ? undefined : motions.list().find(({ id }) => id === block.motion);
      return `your plan${motion ? ` for ${motion.title}` : ""}, uid ${item.uid}`;
    }
    if (item.calendar.kumo)
      return item.status === "hold" ? `your hold, uid ${item.uid}` : `your block, uid ${item.uid}`;
    return "theirs";
  };

  const dayLines = (day: string): readonly string[] =>
    dayItems(day).map((item) => {
      const start = Date.parse(item.start);
      const when = item.all_day ? "all day" : `${clockOf(start, timeZone)}–${clockOf(Date.parse(item.end), timeZone)}`;
      return `- ${weekdayOf(start, timeZone)} ${when} ${item.title} (${whoseOf(item)})`;
    });

  const goals = async (): Promise<readonly string[]> => {
    const now = clock.now();
    const today = toLocal(now, timeZone).day;
    const tomorrow = nextDay(today);
    const until = toLocal(now + goalDays * dayMs, timeZone).day;
    const active = motions.list().filter(({ status }) => status === "active");
    const described = await Promise.all(
      active.map(async ({ id, title, kind, summary }) => {
        const detail = await motions.detail(id);
        const content = detail.ok ? detail.value.content : {};
        const head = `- ${title} (${kind}, ${id}): ${summary}`;
        if (kind === "training") {
          const goal = isObject(content.goal) ? content.goal : {};
          const sessions = listOf(content.weeks)
            .flatMap((week) => listOf(fieldOf(week, "sessions")))
            .filter((session) => [today, tomorrow].includes(textOf(session, "date")))
            .map(
              (session) =>
                `  - ${textOf(session, "date") === today ? "today" : "tomorrow"}: ${textOf(session, "title")}` +
                (textOf(session, "detail") === "" ? "" : `, ${textOf(session, "detail")}`) +
                (fieldOf(session, "done") === true ? " (done)" : ""),
            );
          const by = textOf(goal, "by");
          return [
            head,
            `  - goal: ${textOf(goal, "title")} in ${textOf(goal, "target")}${by ? ` by ${by}` : ""}`,
            ...sessions,
          ];
        }
        if (kind === "pursuit") {
          const next = listOf(content.options)
            .filter((option) => {
              const at = textOf(fieldOf(option, "next"), "at");
              return at !== "" && at.slice(0, 10) >= today && at.slice(0, 10) <= until;
            })
            .map(
              (option) =>
                `  - ${textOf(option, "org") || textOf(option, "name")}: ${textOf(fieldOf(option, "next"), "text")}, ` +
                textOf(fieldOf(option, "next"), "at").replace("T", " "),
            );
          return [head, ...next];
        }
        if (kind === "occasion") {
          const start = textOf(content, "start");
          if (start.slice(0, 10) < today || start.slice(0, 10) > until) return [head];
          const prep = listOf(content.prep)
            .filter((todo) => fieldOf(todo, "done") !== true)
            .map((todo) => textOf(todo, "text"));
          return [head, `  - on ${start.replace("T", " ")}${prep.length > 0 ? `; prep left: ${prep.join("; ")}` : ""}`];
        }
        return [head];
      }),
    );
    return described.flat();
  };

  const corrections = (now: number): readonly string[] => {
    const answered = blocks
      .between(toTimestamp(now - lookbackMs), toTimestamp(now + dayMs))
      .filter((block) => block.kind === "guess" && block.answer !== undefined);
    const fixed = answered
      .filter((block) => block.answer !== undefined && !("right" in block.answer))
      .slice(-12)
      .map((block) => {
        const start = Date.parse(block.start);
        return `- ${weekdayOf(start, timeZone)} ${clockOf(start, timeZone)}–${clockOf(Date.parse(block.end), timeZone)}: you guessed otherwise; it was ${block.title}`;
      });
    const right = answered.length - fixed.length;
    return [...(right > 0 ? [`They said ${String(right)} of your guesses were right.`] : []), ...fixed];
  };

  const lastNight = (now: number): readonly string[] => {
    const night = nights.get(nights.nightOf(now));
    if (!night) return [];
    const stop = night.stop === undefined ? undefined : nights.stopAt(night.night, night.stop);
    const last = night.lastActive === undefined ? undefined : Date.parse(night.lastActive);
    const said = night.stoppedAt === undefined ? undefined : Date.parse(night.stoppedAt);
    const ranLate = stop !== undefined && last !== undefined && last > stop + 15 * minuteMs;
    return [
      ...(night.building === false ? ["Last night they said they weren't building."] : []),
      ...(night.stop === undefined
        ? []
        : [
            `Last night they set a stop at ${spokenTime(night.stop)}` +
              (said === undefined ? "" : `, and said they were stopping at ${clockOf(said, timeZone)}`) +
              (ranLate ? `; their last sign was at ${clockOf(last, timeZone)}` : "") +
              ".",
          ]),
      ...(last !== undefined && night.stop === undefined && toLocal(last, timeZone).minutes < 6 * 60
        ? [`Last night they were up until ${clockOf(last, timeZone)}.`]
        : []),
      ...(night.nextStep === undefined ? [] : [`The next step they noted for today: ${night.nextStep}`]),
      ...((night.gaveUp ?? []).length > 0
        ? [`For more time last night, they chose to give up: ${(night.gaveUp ?? []).join(", ")}.`]
        : []),
    ];
  };

  const planPrompt = async (now: number): Promise<string> => {
    const today = toLocal(now, timeZone).day;
    const calendarLines = [...dayLines(today), ...dayLines(nextDay(today))];
    const goalLines = await goals();
    const told = corrections(now);
    const night = lastNight(now);
    const status = nowLines();
    return [
      `Plan their next two days on your own calendar, ${lead()}'s, as soft blocks they see in Coming up and in iOS`,
      "Calendar. You move them yourself as the day changes; never touch their own calendars.",
      "",
      `It's ${toSpoken(now, timeZone)}. Their morning starts at ${morning()}.`,
      "",
      "Today and tomorrow on every calendar:",
      ...(calendarLines.length > 0 ? calendarLines : ["- Nothing yet."]),
      ...(goalLines.length > 0 ? ["", "What they're working towards, in motion:", ...goalLines] : []),
      ...(night.length > 0 ? ["", ...night] : []),
      ...(told.length > 0 ? ["", "What they told you about your guesses lately:", ...told] : []),
      ...(status.length > 0 ? ["", ...status] : []),
      "",
      "1. Plan: with plan_block (kind plan), put down what keeps their goals and their days going: the session",
      "   from a training block that falls on the day, prep for an interview, exam or deadline that's coming,",
      "   proper meals and groceries when the day allows, and winding down before sleep. Fit them around what's",
      "   fixed, keep them few and realistic, and give each a short reason.",
      "2. Adjust: move (change_event) or remove (delete_event) your own earlier blocks that no longer fit, such as",
      "   a morning run after a late night. Move it; never scold.",
      "3. Guess: with plan_block (kind guess), fill the rest of their waking hours with your guesses at what",
      "   they'll be doing (working, building, training, seeing people, studying, chilling), from their past",
      "   weeks, what they've said and their corrections. Say why in a line.",
      "4. If you're unsure what matters to them now, or they seem to have changed, ask one small question with",
      "   ask_today.",
      "End with one line naming the shape of today and anything you moved, such as A free Sunday, with a quiet",
      "plan under it; the run moved to 17:00 after a late night.",
    ].join("\n");
  };

  const planNote = (day: string): string | undefined => {
    const saved = settings.setting(planNoteSetting);
    const note =
      saved === undefined ? undefined : (JSON.parse(saved) as { readonly day: string; readonly note: string });
    return note?.day === day && note.note !== "" ? note.note : undefined;
  };

  const plan = async (): Promise<readonly string[]> => {
    const now = clock.now();
    const today = toLocal(now, timeZone).day;
    if (calendar.isConnected() && settings.setting(plannedSetting) !== today) {
      settings.setSetting(plannedSetting, today);
      const done = await work(await planPrompt(now));
      if (done.ok) settings.setSetting(planNoteSetting, JSON.stringify({ day: today, note: lastLine(done.value) }));
      else info("Kumo couldn't plan the day", { error: done.failure });
    }
    const note = planNote(today);
    return [
      ...lastNight(now),
      ...(note === undefined ? [] : [`Your plan for today, as you put it after planning: ${note}`]),
    ];
  };

  const hours = (from: number, to: number): Hours => {
    const counted = blocks.between(toTimestamp(from), toTimestamp(to)).map((block) => ({
      block,
      length: Math.max(0, Math.min(to, Date.parse(block.end)) - Math.max(from, Date.parse(block.start))) / hourMs,
    }));
    const total = (kind: Block["kind"]): ReadonlyMap<Activity, number> =>
      counted
        .filter(({ block }) => block.kind === kind)
        .reduce(
          (sums, { block, length }) => new Map([...sums, [block.activity, (sums.get(block.activity) ?? 0) + length]]),
          new Map<Activity, number>(),
        );
    return { guessed: total("guess"), planned: total("plan") };
  };

  const answer = async (
    find: (item: CalendarItem) => boolean,
    given: BlockAnswer,
  ): Promise<Result<CalendarItem, GuessFailure>> => {
    const item = calendar.listItems().find(find);
    const block = item && blocks.find(item.uid);
    if (!item || block?.kind !== "guess" || block.answer !== undefined) {
      return fail({ code: "not_found", detail: "That guess has moved on." });
    }
    if (!calendar.isConnected()) {
      return fail({ code: "unavailable", detail: "iCloud isn't set up, so Kumo's calendar can't change." });
    }
    const activity: Activity = "activity" in given ? given.activity : "text" in given ? "other" : block.activity;
    const title = "right" in given ? block.title : "activity" in given ? labelOf(given.activity) : given.text.trim();
    const answered: Block = { ...block, title, activity, answer: given, answeredAt: toTimestamp(clock.now()) };
    blocks.save(answered);
    const changed = await calendar.changeEvent(item.uid, { title, notes: notesOf(answered, lead()) });
    if (changed.ok) return ok(changed.value);
    blocks.save(block);
    info("A guess couldn't be answered", { error: changed.failure });
    return fail({ code: "unavailable", detail: changed.failure });
  };

  const planBlock = async (input: unknown): Promise<ToolResult> => {
    const kind = lineOf(input, "kind");
    if (kind !== "plan" && kind !== "guess") return failed("A block is kind plan or guess.");
    const title = lineOf(input, "title");
    if (title === "" || title.length > longestTitle)
      return failed(`Give a title of ${String(longestTitle)} characters or fewer.`);
    const activity = lineOf(input, "activity");
    if (!isActivity(activity)) return failed(`There's no activity ${activity}.`);
    if (kind === "guess" && !isGuessActivity(activity)) {
      return failed("Guess what they'll be doing: working, building, training, people, studying, chilling or other.");
    }
    const why = lineOf(input, "why");
    if (kind === "guess" && why === "") return failed("Say why you guess so, in a line.");
    const startText = lineOf(input, "start");
    const endText = lineOf(input, "end");
    if (!isInstant(startText) || !isInstant(endText))
      return failed("Give start and end as instants with their offset.");
    const motion = lineOf(input, "motion");
    const start = Date.parse(startText);
    const end = Date.parse(endText);
    if (end <= start || end - start > longestBlockMs) return failed("A block ends after it starts, within 12 hours.");
    if (motion !== "" && motions.list().every(({ id }) => id !== motion))
      return failed(`Nothing in motion is ${motion}.`);
    if (!calendar.isConnected()) return failed("iCloud isn't set up, so there's no calendar for your blocks.");
    const clash = calendar.listItems().find((item) => overlaps(start, end, item));
    if (clash) {
      return failed(
        clash.calendar.kumo
          ? `That overlaps your ${withoutMark(clash.title)} (${clash.uid}): move or remove it first.`
          : `That clashes with ${clash.title} on their calendar: fit it around.`,
      );
    }
    const uid = `${blockPrefix}${randomUUID()}`;
    const block: Block = {
      uid,
      kind,
      title,
      start: toTimestamp(start),
      end: toTimestamp(end),
      activity,
      ...(why !== "" && { why }),
      ...(motion !== "" && { motion }),
      at: toTimestamp(clock.now()),
    };
    blocks.save(block);
    const added = await calendar.addEvent(
      {
        uid,
        title: kind === "guess" ? `${title}${guessMark}` : title,
        start: block.start,
        end: block.end,
        notes: notesOf(block, lead()),
      },
      true,
    );
    if (!added.ok) {
      blocks.remove(uid);
      return failed(added.failure);
    }
    return { text: `${kind === "guess" ? "Guessed" : "Planned"} ${title} (${uid}).` };
  };

  const tools: readonly Tool[] = [
    {
      name: "plan_block",
      title: "Put a block on your calendar",
      description:
        "Put a soft block on your own calendar as part of your picture of their day: kind plan for what you plan " +
        "for them (the run from their training block, interview prep, a proper meal, groceries, winding down), or " +
        "kind guess for your guess at what they'll be doing (working, building, training, seeing people, " +
        "studying, chilling), with why. They see both in Coming up and iOS Calendar, guesses marked as guesses, " +
        "and can correct a guess. Move or remove a block with change_event or delete_event.",
      inputSchema: {
        type: "object",
        properties: {
          kind: { enum: ["plan", "guess"] },
          title: { type: "string", description: "A few words, such as “Easy run, week 1 of 6” or “Working”." },
          start: { type: "string", description: "An instant with its offset." },
          end: { type: "string" },
          activity: {
            enum: [
              "working",
              "building",
              "training",
              "people",
              "studying",
              "chilling",
              "meals",
              "errands",
              "rest",
              "other",
            ],
            description: "people is seeing people; rest is winding down; meals, errands and rest are only for plans.",
          },
          why: {
            type: "string",
            description: "One line, such as “Your usual weekday at the desk, from the last four weeks”.",
          },
          motion: { type: "string", description: "The thing in motion it serves, such as the training block's id." },
        },
        required: ["kind", "title", "start", "end", "activity"],
        additionalProperties: false,
      },
      call: planBlock,
    },
    {
      name: "correct_guess",
      title: "Correct a guess",
      description:
        "When they tell you what they're really doing or did, such as “actually today I'm building”, answer your " +
        "guess on your calendar by its uid: right, the activity it really was, or a few words for something else. " +
        "It becomes theirs rather than a guess, and teaches your next guesses.",
      inputSchema: {
        type: "object",
        properties: {
          uid: { type: "string" },
          right: { type: "boolean" },
          activity: { enum: ["working", "building", "training", "people", "studying", "chilling"] },
          text: { type: "string" },
        },
        required: ["uid"],
        additionalProperties: false,
      },
      call: async (input) => {
        const given = answerOf(input);
        if (typeof given === "string") return failed(given);
        const uid = lineOf(input, "uid");
        const answered = await answer((item) => item.uid === uid, given);
        return answered.ok ? { text: `It's ${answered.value.title} now.` } : failed(answered.failure.detail);
      },
    },
  ];

  return {
    tools,
    enrich,
    answer: (id, given) => answer((item) => item.id === id, given),
    plan,
    dayLines,
    dayItems,
    goals,
    hours,
  };
};
