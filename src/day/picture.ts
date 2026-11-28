import { randomUUID } from "node:crypto";
import { toTimestamp, type Clock } from "#clock.ts";
import type { Calendar } from "#calendar/calendar.ts";
import type { NewCalendarEvent } from "#calendar/icalendar.ts";
import type { DeskKeeper } from "#desk/desk.ts";
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
import type { Settings } from "#store/store.ts";
import { fieldOf, textOf } from "#tools/input.ts";
import type { Tool, ToolResult } from "#tools/mcp.ts";
import type { Info } from "#turns/turns.ts";
import type { Tracks } from "#work/tracks.ts";

// Kumo's picture of your day, on its own calendar: its plan for the day (a run from your training block, prep for a
// coming interview, proper meals, winding down) and its guesses at the rest (working, building, seeing people…),
// which you can correct. It never touches your own calendars.
export type DayPicture = {
  readonly tools: readonly Tool[];
  // Adds what Kumo knows of one of its blocks to the item, such as that it's a guess and why.
  readonly enrich: (item: CalendarItem) => CalendarItem;
  readonly answer: (id: string, answer: BlockAnswer) => Promise<Result<CalendarItem, GuessFailure>>;
  // From the day view in Ito: moves or removes one of Kumo's own items, never one of theirs, with an undo in Done.
  readonly move: (id: string, start: string, end: string) => Promise<Result<CalendarItem, ChangeFailure>>;
  readonly remove: (id: string) => Promise<Result<undefined, ChangeFailure>>;
  // What they told Kumo about its guesses lately, so its next guesses learn from it.
  readonly inMindText: () => string;
};

export type GuessFailure = { readonly code: "not_found" | "unavailable"; readonly detail: string };

export type ChangeFailure = {
  readonly code: "not_found" | "not_kumos" | "invalid" | "unavailable";
  readonly detail: string;
};

export type DayPictureOptions = {
  readonly blocks: BlockStore;
  readonly calendar: Pick<
    Calendar,
    "addEvent" | "changeEvent" | "removeEvent" | "isConnected" | "listItems" | "onRefreshed"
  >;
  readonly motions: Pick<Motions, "list">;
  readonly desk: Pick<DeskKeeper, "addDone" | "onUndo">;
  readonly tracks: Pick<Tracks, "find" | "corrected">;
  readonly settings: Pick<Settings, "setting" | "setSetting">;
  readonly clock: Clock;
  readonly timeZone: () => string;
  readonly info: Info;
  readonly lead: () => string;
};

export const blockPrefix = "block-";

export const guessMark = " · guess";

const longestTitle = 40;
const longestReason = 160;
const longestBlockMs = 12 * hourMs;
const keptMs = 35 * dayMs;
const lookbackMs = 28 * dayMs;
const settledMs = 2 * minuteMs;
const toldKept = 12;

// What they changed on Kumo's calendar from Ito, kept so Kumo sees it when it next looks at their day.
export const toldSetting = "day_told";

type Told = { readonly at: string; readonly text: string; readonly done: string };

// How to undo a change to Kumo's calendar, made from Ito or by a dream: move it back, put it back, or take it off.
export type ChangeUndo =
  | { readonly kind: "kumo_block_moved"; readonly uid: string; readonly start: string; readonly end: string }
  | { readonly kind: "kumo_block_removed"; readonly event: NewCalendarEvent; readonly block?: Block }
  | { readonly kind: "kumo_block_added"; readonly uid: string };

const changeKinds: ReadonlySet<unknown> = new Set(["kumo_block_moved", "kumo_block_removed", "kumo_block_added"]);

const isChangeUndo = (payload: unknown): payload is ChangeUndo => changeKinds.has(fieldOf(payload, "kind"));

const isTold = (value: unknown): value is Told =>
  typeof fieldOf(value, "at") === "string" &&
  typeof fieldOf(value, "text") === "string" &&
  typeof fieldOf(value, "done") === "string";

const failed = (text: string): ToolResult => ({ text, isError: true });

const lineOf = (value: unknown, field: string): string => textOf(value, field).replaceAll(/\s+/gu, " ").trim();

const isInstant = (text: string): boolean => /T\d{2}:\d{2}/u.test(text) && !Number.isNaN(Date.parse(text));

const withoutMark = (title: string): string => (title.endsWith(guessMark) ? title.slice(0, -guessMark.length) : title);

// “Sun 15 Nov, 10:30–11:00”, local.
const spanOf = (start: string, end: string, zone: string): string =>
  `${new Intl.DateTimeFormat("en-GB", { timeZone: zone, weekday: "short", day: "numeric", month: "short" }).format(
    Date.parse(start),
  )}, ${clockOf(Date.parse(start), zone)}–${clockOf(Date.parse(end), zone)}`;

const notesOf = (block: Block, lead: string): string => {
  const overlap = block.overlap === undefined ? "" : ` Overlaps on purpose: ${block.overlap.reason}`;
  if (block.answer !== undefined) return `${lead}'s picture of your day, as you told it.${overlap}`;
  return block.kind === "guess"
    ? `${lead}'s guess: ${block.why ?? ""} Tell ${lead} if it's wrong, on the Desk in Ito.${overlap}`
    : `${lead}'s plan${block.why === undefined ? "" : `: ${block.why}`}. ${lead} moves it as your day changes.${overlap}`;
};

const overlaps = (start: number, end: number, item: CalendarItem): boolean =>
  !item.all_day && Date.parse(item.start) < end && start < Date.parse(item.end);

// A confirmed event of theirs, rather than something soft: a hold, a maybe, or one of Kumo's own blocks.
const isFirm = (item: CalendarItem): boolean =>
  !item.calendar.kumo && item.status !== "hold" && item.status !== "tentative";

// What a block would overlap, as Kumo reads it: what it is, when, and how settled it is.
const clashOf = (item: CalendarItem, block: Block | undefined, zone: string): string => {
  const title = withoutMark(item.title);
  const span = `${clockOf(Date.parse(item.start), zone)}–${clockOf(Date.parse(item.end), zone)}`;
  if (block) return `your ${block.kind} “${title}” (${item.uid}, ${span}, soft)`;
  if (item.status === "hold") return `the hold “${title}” (${item.uid}, ${span}, not settled)`;
  const whose = item.calendar.kumo ? "on your calendar" : "on their calendar";
  return `“${title}” (${item.uid}, ${span}, ${item.status === "tentative" ? "tentative" : "confirmed"} ${whose})`;
};

const listOf = (parts: readonly string[]): string =>
  parts.length < 2 ? (parts[0] ?? "") : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1) ?? ""}`;

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
  desk,
  tracks,
  settings,
  clock,
  timeZone,
  info,
  lead,
}: DayPictureOptions): DayPicture => {
  const enrich = (item: CalendarItem): CalendarItem => {
    if (!item.calendar.kumo) return item;
    const block = blocks.find(item.uid);
    if (!block) return item;
    const withMotion = {
      ...item,
      title: block.title,
      ...(block.motion !== undefined && { motion: block.motion }),
      ...(block.overlap !== undefined && { overlap: block.overlap }),
    };
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
      const written = Math.max(
        Date.parse(block.at),
        Date.parse(block.answeredAt ?? block.at),
        Date.parse(block.changedAt ?? block.at),
      );
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

  const toldLately = (now: number): readonly Told[] => {
    try {
      const saved = JSON.parse(settings.setting(toldSetting) ?? "[]") as unknown;
      return Array.isArray(saved) ? saved.filter(isTold).filter(({ at }) => Date.parse(at) > now - lookbackMs) : [];
    } catch {
      return [];
    }
  };

  const keepTold = (told: readonly Told[]): void => {
    settings.setSetting(toldSetting, JSON.stringify(told.slice(-toldKept)));
  };

  const tell = (told: Told): void => {
    keepTold([...toldLately(clock.now()), told]);
  };

  // Once a change is undone, it's as if it never happened.
  const untell = (done: string): void => {
    keepTold(toldLately(clock.now()).filter((told) => told.done !== done));
  };

  const kumoItem = (id: string): Result<CalendarItem, ChangeFailure> => {
    if (!calendar.isConnected()) {
      return fail({ code: "unavailable", detail: `iCloud isn't set up, so ${lead()}'s calendar can't change.` });
    }
    const item = calendar.listItems().find((candidate) => candidate.id === id);
    if (!item) return fail({ code: "not_found", detail: "That's no longer on the calendar." });
    if (!item.calendar.kumo) {
      return fail({
        code: "not_kumos",
        detail: `That's on your own calendar, so change it in Calendar. Only ${lead()}'s blocks change here.`,
      });
    }
    return ok(enrich(item));
  };

  const move = async (id: string, startText: string, endText: string): Promise<Result<CalendarItem, ChangeFailure>> => {
    if (!isInstant(startText) || !isInstant(endText)) {
      return fail({ code: "invalid", detail: "Give start and end as instants with their offset." });
    }
    const found = kumoItem(id);
    if (!found.ok) return found;
    const item = found.value;
    const start = toTimestamp(Date.parse(startText));
    const end = toTimestamp(Date.parse(endText));
    if (Date.parse(end) <= Date.parse(start) || Date.parse(end) - Date.parse(start) > longestBlockMs) {
      return fail({ code: "invalid", detail: "A block ends after it starts, within 12 hours." });
    }
    const block = blocks.find(item.uid);
    if (block) blocks.save({ ...block, start, end, changedAt: toTimestamp(clock.now()) });
    const changed = await calendar.changeEvent(item.uid, { start, end });
    if (!changed.ok) {
      if (block) blocks.save(block);
      return fail({ code: "unavailable", detail: changed.failure });
    }
    const zone = timeZone();
    const title = withoutMark(item.title);
    const entry = desk.addDone({
      text: `You moved “${title}” to ${spanOf(start, end, zone)}`,
      event: changed.value,
      quiet: false,
      undo: { kind: "kumo_block_moved", uid: item.uid, start: item.start, end: item.end } satisfies ChangeUndo,
    });
    tell({
      at: entry.at,
      done: entry.id,
      text: `moved your “${title}” from ${spanOf(item.start, item.end, zone)} to ${spanOf(start, end, zone)}`,
    });
    return ok(changed.value);
  };

  // Removing one of Kumo's blocks says it got that one wrong, so a block in a track is a correction there. Moving
  // one isn't: plans move.
  const remove = async (id: string): Promise<Result<undefined, ChangeFailure>> => {
    const found = kumoItem(id);
    if (!found.ok) return found;
    const item = found.value;
    const block = blocks.find(item.uid);
    const removed = await calendar.removeEvent(item.uid);
    if (!removed.ok) return fail({ code: "unavailable", detail: removed.failure });
    if (block) blocks.remove(item.uid);
    const zone = timeZone();
    const title = withoutMark(item.title);
    const span = spanOf(item.start, item.end, zone);
    const track = block?.track !== undefined && tracks.find(block.track) ? block.track : undefined;
    const entry = desk.addDone({
      text: `You removed “${title}”, ${span}`,
      event: item,
      quiet: false,
      ...(track !== undefined && { track }),
      undo: { kind: "kumo_block_removed", event: removed.value, ...(block && { block }) } satisfies ChangeUndo,
    });
    if (track !== undefined) tracks.corrected(entry, `You removed “${title}”, ${span}, from ${lead()}'s calendar`);
    tell({
      at: entry.at,
      done: entry.id,
      text: `removed your ${block?.kind === "guess" ? "guess" : "block"} “${title}”, ${span}`,
    });
    return ok(undefined);
  };

  const undoChange = async (undo: ChangeUndo): Promise<Result<undefined, string>> => {
    const now = toTimestamp(clock.now());
    if (undo.kind === "kumo_block_moved") {
      const block = blocks.find(undo.uid);
      if (block) blocks.save({ ...block, start: undo.start, end: undo.end, changedAt: now });
      const changed = await calendar.changeEvent(undo.uid, { start: undo.start, end: undo.end });
      if (changed.ok) return ok(undefined);
      if (block) blocks.save(block);
      return fail(changed.failure);
    }
    if (undo.kind === "kumo_block_added") {
      const block = blocks.find(undo.uid);
      const removed = await calendar.removeEvent(undo.uid);
      if (!removed.ok) return fail(removed.failure);
      if (block) blocks.remove(undo.uid);
      return ok(undefined);
    }
    // The block is kept first, so the item comes back marked as it was.
    if (undo.block) blocks.save({ ...undo.block, changedAt: now });
    const added = await calendar.addEvent(undo.event, true);
    if (added.ok) return ok(undefined);
    if (undo.block) blocks.remove(undo.block.uid);
    return fail(added.failure);
  };

  desk.onUndo(async (entry, payload) => {
    if (!isChangeUndo(payload)) return ok(undefined);
    const undone = await undoChange(payload);
    if (undone.ok) untell(entry.id);
    return undone;
  });

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
    const track = lineOf(input, "track");
    if (track !== "" && !tracks.find(track)) return failed(`There's no track ${track}.`);
    const overlap = lineOf(input, "overlap");
    if (overlap !== "" && overlap !== "intended") return failed(`overlap is "intended", or left out.`);
    const reason = lineOf(input, "overlap_reason");
    if ((overlap === "") !== (reason === "")) return failed(`Give overlap "intended" with overlap_reason, or neither.`);
    if (reason.length > longestReason)
      return failed(`Keep overlap_reason to ${String(longestReason)} characters or fewer.`);
    if (!calendar.isConnected()) return failed("iCloud isn't set up, so there's no calendar for your blocks.");
    // Overlaps are refused unless Kumo says it means one, with why: accidental clashes stay caught.
    const zone = timeZone();
    const clashes = calendar.listItems().filter((item) => overlaps(start, end, item));
    const clashText = listOf(clashes.map((item) => clashOf(item, blocks.find(item.uid), zone)));
    const isIntended = clashes.length > 0 && overlap === "intended";
    if (!isIntended && clashes.length > 0) {
      return failed(
        clashes.some(isFirm)
          ? `That overlaps ${clashText}. Fit it around what's confirmed. Only if they've told you both stand, call ` +
              `again with overlap "intended" and overlap_reason saying why.`
          : `That overlaps ${clashText}. Fit it around, or move what's there; if they mean both to stand while it's ` +
              `decided, such as a soft plan beside a call that's only held, call again with overlap "intended" and ` +
              `overlap_reason saying why and how they'll settle it.`,
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
      ...(track !== "" && { track }),
      ...(isIntended && { overlap: { reason } }),
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
    const placed = `${kind === "guess" ? "Guessed" : "Planned"} ${title} (${uid}).`;
    return {
      text: isIntended
        ? `${placed} It overlaps ${clashText} on purpose: ${reason} Each keeps its own status; the day view shows ` +
          "the overlap."
        : placed,
    };
  };

  const tools: readonly Tool[] = [
    {
      name: "plan_block",
      title: "Put a block on your calendar",
      description:
        "Put a soft block on your own calendar as part of your picture of their day: kind plan for what you plan " +
        "or agree with them (the run from their training block, interview prep, a proper meal, winding down), or " +
        "kind guess for your guess at what they'll be doing (working, building, training, seeing people, " +
        "studying, chilling), with why. They see both in Coming up and iOS Calendar, guesses marked as guesses, " +
        "and can correct a guess. Move or remove a block with change_event or delete_event. It's refused if it " +
        "overlaps anything; when they mean both to stand, such as a soft plan beside a call that's only held, give " +
        'overlap "intended" and overlap_reason, and each keeps its own status.',
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
          track: {
            type: "string",
            description: "The learning track it's part of, by id: if they remove it, that's a correction there.",
          },
          overlap: {
            enum: ["intended"],
            description:
              "Put it over what's there on purpose, only once you know what it overlaps and they mean both to stand.",
          },
          overlap_reason: {
            type: "string",
            description:
              "With overlap: why both stand and how they'll settle it, in a line, such as “Both stand until Dana " +
              "confirms the call; the walk gives way if it's on”.",
          },
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
    move,
    remove,
    inMindText: () => {
      const now = clock.now();
      const told = corrections(now);
      const changed = toldLately(now);
      const zone = timeZone();
      return [
        ...(told.length === 0
          ? []
          : [
              "<your_guesses>",
              "What they told you about your guesses at their day lately:",
              ...told,
              "</your_guesses>",
            ]),
        ...(changed.length === 0
          ? []
          : [
              "<your_blocks>",
              "What they changed on your calendar themselves lately, in Ito:",
              ...changed.map(
                ({ at, text }) => `- ${weekdayOf(Date.parse(at), zone)} ${clockOf(Date.parse(at), zone)}: they ${text}`,
              ),
              "</your_blocks>",
            ]),
      ].join("\n");
    },
  };
};
