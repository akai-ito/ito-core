import { randomUUID } from "node:crypto";
import { toTimestamp, type Clock } from "#clock.ts";
import type { Calendar } from "#calendar/calendar.ts";
import { dayMs, minuteMs } from "#desk/day.ts";
import {
  isActivity,
  isGuessActivity,
  labelOf,
  type Activity,
  type Block,
  type BlockAnswer,
  type BlockStore,
} from "#day/blocks.ts";
import { clockOf, hourMs, weekdayOf } from "#day/time.ts";
import type { Motions } from "#motion/motion.ts";
import type { CalendarItem } from "#protocol/types.ts";
import { fail, ok, type Result } from "#result.ts";
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
  // What they told Kumo about its guesses lately, so its next guesses learn from it.
  readonly inMindText: () => string;
};

export type GuessFailure = { readonly code: "not_found" | "unavailable"; readonly detail: string };

export type DayPictureOptions = {
  readonly blocks: BlockStore;
  readonly calendar: Pick<Calendar, "addEvent" | "changeEvent" | "isConnected" | "listItems" | "onRefreshed">;
  readonly motions: Pick<Motions, "list">;
  readonly clock: Clock;
  readonly timeZone: () => string;
  readonly info: Info;
  readonly lead: () => string;
};

export const blockPrefix = "block-";

export const guessMark = " · guess";

const longestTitle = 40;
const longestBlockMs = 12 * hourMs;
const keptMs = 35 * dayMs;
const lookbackMs = 28 * dayMs;
const settledMs = 2 * minuteMs;

const failed = (text: string): ToolResult => ({ text, isError: true });

const lineOf = (value: unknown, field: string): string => textOf(value, field).replaceAll(/\s+/gu, " ").trim();

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
  clock,
  timeZone,
  info,
  lead,
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

  const corrections = (now: number): readonly string[] => {
    const answered = blocks
      .between(toTimestamp(now - lookbackMs), toTimestamp(now + dayMs))
      .filter((block) => block.kind === "guess" && block.answer !== undefined);
    const fixed = answered
      .filter((block) => block.answer !== undefined && !("right" in block.answer))
      .slice(-12)
      .map((block) => {
        const start = Date.parse(block.start);
        const zone = timeZone();
        return `- ${weekdayOf(start, zone)} ${clockOf(start, zone)}–${clockOf(Date.parse(block.end), zone)}: you guessed otherwise; it was ${block.title}`;
      });
    const right = answered.length - fixed.length;
    return [...(right > 0 ? [`They said ${String(right)} of your guesses were right.`] : []), ...fixed];
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
    inMindText: () => {
      const told = corrections(clock.now());
      return told.length === 0
        ? ""
        : [
            "<your_guesses>",
            "What they told you about your guesses at their day lately:",
            ...told,
            "</your_guesses>",
          ].join("\n");
    },
  };
};
