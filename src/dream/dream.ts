import { randomUUID } from "node:crypto";
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, readSync } from "node:fs";
import path from "node:path";
import { isImage, readTakenDay } from "#attachments/media.ts";
import { createCell } from "#cell.ts";
import { toTimestamp, type Cancel, type Clock } from "#clock.ts";
import { atLocal, dayMs, toLocal, toSpoken } from "#desk/day.ts";
import type { DeskKeeper } from "#desk/desk.ts";
import type { Block } from "#day/blocks.ts";
import type { ChangeUndo } from "#day/picture.ts";
import {
  calendarText,
  conversationsText,
  mailText,
  mostMessages,
  notesText,
  photosText,
  tracksText,
  whenOf,
  workText,
  type SharedPhoto,
} from "#dream/digest.ts";
import type { DayNote, DayNotes } from "#dream/notes.ts";
import { toLocation } from "#memory/pages.ts";
import type {
  Attachment,
  CalendarItem,
  DoneEntry,
  Dream,
  DreamGroup,
  DreamLine,
  DreamState,
  Message,
  Thread,
  Track,
  WakeUp,
} from "#protocol/types.ts";
import { fail, ok, type Result } from "#result.ts";
import type { Settings } from "#store/store.ts";
import type { DreamStore } from "#store/dreams.ts";
import { contextRun, dreamRunPrefix } from "#tools/context.ts";
import { fieldOf, textOf } from "#tools/input.ts";
import type { Tool, ToolResult } from "#tools/mcp.ts";
import type { Info } from "#turns/turns.ts";

// Kumo's dream: once a day, at a fixed local time, Kumo looks back over everything since its last dream and puts it
// in order: it tends memory, reconciles tomorrow (its blocks and guesses, and its wake-ups), writes each day's journal
// entry in their own voice, and folds lasting lessons into How to help you. It leaves a record of what it planned,
// tidied, noticed and saved for them, each line pointing at what it changed, which Done keeps with an undo. One dream
// runs at a time; a manual one in the 12 hours before the dream time stands in for that night's. A dream the server
// was off for runs once it's back, and one the model couldn't do is tried again until the next is due.
export type Dreams = {
  readonly tools: readonly Tool[];
  readonly state: () => DreamState;
  // Dream now; while one runs, it's that one.
  readonly dreamNow: () => DreamState;
  readonly setTime: (time: string) => Result<DreamState, string>;
  readonly see: (id: string) => Dream | undefined;
  // A tool as a dream calls it: what it changes is kept, so the record can point at it and Done can undo it.
  readonly watch: (tool: Tool) => Tool;
  // Kumo messaged them during a run.
  readonly posted: (run: string | undefined, message: Message) => void;
  // Their time zone changed: the next dream is at the dream time where they are now.
  readonly refit: () => void;
  // The dream under way, if any, has finished.
  readonly settled: () => Promise<void>;
  readonly close: () => void;
};

export type DreamSources = {
  readonly messagesSince: (at: string, limit: number) => readonly Message[];
  readonly thread: (id: string) => Thread | undefined;
  readonly doneSince: (at: string) => readonly DoneEntry[];
  readonly mailSince: (since: number) => Promise<readonly string[]>;
  // Their calendars and Kumo's, as Coming up shows them, guesses and all.
  readonly calendar: () => readonly CalendarItem[];
  readonly tracks: () => readonly Track[];
  readonly attachmentPath: (id: string) => string;
};

export type DreamChanges = {
  readonly versionOf: (address: string) => Promise<string | undefined>;
  readonly titleOf: (address: string) => string | undefined;
  readonly revert: (address: string, version: string | undefined, note: string) => Promise<Result<undefined, string>>;
  readonly wakeUps: () => readonly WakeUp[];
  readonly putWakeUp: (wakeUp: WakeUp) => Result<WakeUp, string>;
  readonly cancelWakeUp: (id: string) => boolean;
  readonly block: (uid: string) => Block | undefined;
};

export type DreamOptions = {
  readonly store: DreamStore;
  readonly settings: Pick<Settings, "setting" | "setSetting">;
  readonly clock: Clock;
  readonly timeZone: () => string;
  readonly newId: () => string;
  // One dream, as background work under its run, with a generous time budget.
  readonly work: (prompt: string, run: string) => Promise<Result<string, string>>;
  readonly notes: DayNotes;
  readonly sources: DreamSources;
  readonly changes: DreamChanges;
  readonly desk: Pick<DeskKeeper, "addDone" | "onUndo">;
  readonly findDone: (id: string) => { readonly entry: DoneEntry } | undefined;
  readonly publish: (dream: Dream) => void;
  readonly instructions: string;
  readonly workspace: string;
  readonly info: Info;
  // Whether dreams come by themselves at the dream time; Dream now works either way.
  readonly isScheduled: boolean;
  readonly retryMs?: number;
};

export const dreamTimeSetting = "dream_time";

// When dreams began being counted, so a new server doesn't dream at once for nights before it existed.
export const dreamFromSetting = "dream_from";

export const defaultDreamTime = "04:00";

// A dream the model couldn't do is tried again this often until it goes through or the next one is due.
export const dreamRetryMs = 30 * 60 * 1000;

// A manual dream this close before the dream time stands in for that night's.
const standInMs = 12 * 60 * 60 * 1000;

// A dream looks back at most this far, however long the server was off.
const longestLookBackMs = 7 * dayMs;

const longestTimerMs = 2 ** 31 - 1;

const clockPattern = /^(?:[01]\d|2[0-3]):[0-5]\d$/u;

const groups: readonly DreamGroup[] = ["planned", "tidied", "noticed", "saved"];

// What the app shows of a line and the headline: a longer one is cut at a word, never refused, so nothing is
// squeezed to fit.
const longestLine = 200;

const longestHeadline = 160;

const headerBytes = 256 * 1024;

const watchedMemory: ReadonlySet<string> = new Set([
  "edit_page",
  "write_page",
  "restore_page",
  "forget_page",
  "journal",
]);

const watchedWakeUps: ReadonlySet<string> = new Set(["set_wake_up", "move_wake_up", "drop_wake_up"]);

const watchedCalendar: ReadonlySet<string> = new Set([
  "plan_block",
  "add_event",
  "change_event",
  "delete_event",
  "correct_guess",
]);

const imageExtensions: Readonly<Record<string, string>> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/gif": ".gif",
  "image/webp": ".webp",
};

type Trigger = Dream["trigger"];

type KumoItem = { readonly item: CalendarItem; readonly block?: Block };

// What a dream changed, by what it is, with how it was before the dream first touched it.
type Touched =
  | { readonly kind: "page"; readonly address: string; readonly before: string | undefined; readonly title?: string }
  | { readonly kind: "wake_up"; readonly id: string; readonly before: WakeUp | undefined }
  | { readonly kind: "event"; readonly uid: string; readonly before: KumoItem | undefined }
  | { readonly kind: "message"; readonly id: string; readonly text: string };

type Pointer = Pick<DreamLine, "page" | "wake_up" | "event" | "message">;

type Written = { readonly group: DreamGroup; readonly text: string; readonly key?: string } & Pointer;

type Running = {
  readonly run: string;
  readonly trigger: Trigger;
  readonly slot: number;
  readonly startedAt: number;
  readonly notes: readonly DayNote[];
  readonly touched: ReadonlyMap<string, Touched>;
  readonly lines: readonly Written[];
  readonly headline?: string;
};

// A change, settled at the end: how it reads in Done and the record, what opens it, and how to take it back.
type Change = {
  readonly key: string;
  readonly group: DreamGroup;
  readonly text: string;
  readonly pointer: Pointer;
  readonly undo?: unknown;
  readonly event?: CalendarItem;
};

type PageUndo = {
  readonly kind: "dream_page";
  readonly address: string;
  readonly before?: string;
  readonly after?: string;
};

type WakeUpUndo = {
  readonly kind: "dream_wake_up";
  readonly id: string;
  readonly before?: WakeUp;
  readonly after?: WakeUp;
};

const isPageUndo = (payload: unknown): payload is PageUndo => fieldOf(payload, "kind") === "dream_page";

const isWakeUpUndo = (payload: unknown): payload is WakeUpUndo => fieldOf(payload, "kind") === "dream_wake_up";

const failed = (text: string): ToolResult => ({ text, isError: true });

const lineOf = (value: unknown, field: string): string => textOf(value, field).replaceAll(/\s+/gu, " ").trim();

const minutesOf = (time: string): number => {
  const [hours = 0, minutes = 0] = time.split(":", 2).map(Number);
  return hours * 60 + minutes;
};

const dayBefore = (day: string): string =>
  new Date(Date.parse(`${day}T00:00:00.000Z`) - dayMs).toISOString().slice(0, 10);

const nextCalendarDay = (day: string): string =>
  new Date(Date.parse(`${day}T00:00:00.000Z`) + dayMs).toISOString().slice(0, 10);

const keyOfTouched = (touched: Touched): string => {
  switch (touched.kind) {
    case "page": {
      return `page:${touched.address}`;
    }
    case "wake_up": {
      return `wake_up:${touched.id}`;
    }
    case "event": {
      return `event:${touched.uid}`;
    }
    case "message": {
      return `message:${touched.id}`;
    }
  }
};

const isSameWakeUp = (left: WakeUp | undefined, right: WakeUp | undefined): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

const isSameItem = (left: CalendarItem | undefined, right: CalendarItem | undefined): boolean =>
  left?.title === right?.title && left?.start === right?.start && left?.end === right?.end;

const shortened = (text: string, most: number): string =>
  text.length <= most ? text : `${text.slice(0, most - 1).replace(/\s+\S*$/u, "")}…`;

const quoted = (text: string): string => shortened(text, 60);

const withoutGuessMark = (title: string): string => title.replace(/ · guess$/u, "");

// The page a memory tool changes: a journal day by its day, any other by its address.
const addressOf = (name: string, input: unknown): string =>
  name === "journal" ? `memory:journal/${lineOf(input, "day")}` : lineOf(input, "address");

const readStart = (file: string): Buffer => {
  const descriptor = openSync(file, "r");
  try {
    const start = Buffer.alloc(headerBytes);
    const read = readSync(descriptor, start, 0, headerBytes, 0);
    return start.subarray(0, read);
  } finally {
    closeSync(descriptor);
  }
};

export const createDreams = ({
  store,
  settings,
  clock,
  timeZone,
  newId,
  work,
  notes,
  sources,
  changes,
  desk,
  findDone,
  publish,
  instructions,
  workspace,
  info,
  isScheduled,
  retryMs = dreamRetryMs,
}: DreamOptions): Dreams => {
  const running = createCell<Running | undefined>(undefined);
  const finished = createCell<Promise<void>>(Promise.resolve());
  const timer = createCell<Cancel | undefined>(undefined);
  const retryTimer = createCell<Cancel | undefined>(undefined);
  const isClosed = createCell(false);

  if (settings.setting(dreamFromSetting) === undefined) {
    settings.setSetting(dreamFromSetting, toTimestamp(clock.now()));
  }

  const timeOf = (): string => {
    const saved = settings.setting(dreamTimeSetting);
    return saved !== undefined && clockPattern.test(saved) ? saved : defaultDreamTime;
  };

  // The dream time on a local day, as an instant where they are now.
  const slotOn = (day: string): number => atLocal(day, minutesOf(timeOf()), timeZone());

  // The first dream time after an instant.
  const slotAfter = (at: number): number => {
    const { day } = toLocal(at, timeZone());
    const today = slotOn(day);
    return today > at ? today : slotOn(nextCalendarDay(day));
  };

  // The latest dream time at or before an instant.
  const slotBy = (at: number): number => {
    const { day } = toLocal(at, timeZone());
    const today = slotOn(day);
    return today <= at ? today : slotOn(dayBefore(day));
  };

  // The local day a dream mostly looks back on: last night's for a dream in the small hours or the morning.
  const dayOf = (at: number): string => {
    const minutes = minutesOf(timeOf());
    const shift = minutes < 12 * 60 ? Math.max(6 * 60, minutes + 1) : 6 * 60;
    return toLocal(at - shift * 60 * 1000, timeZone()).day;
  };

  // A night's dream is covered once a dream stands in for it: one at its time, or one in the 12 hours before.
  const isCovered = (slot: number): boolean => {
    const latest = store.latest();
    return (
      store.hasSlot(toTimestamp(slot)) || (latest !== undefined && Date.parse(latest.started_at) > slot - standInMs)
    );
  };

  const withUndo = (dream: Dream): Dream => ({
    ...dream,
    lines: dream.lines.map((line) => {
      if (line.done === undefined) return line;
      const entry = findDone(line.done)?.entry;
      if (!entry) return line;
      return {
        ...Object.fromEntries(Object.entries(line).filter(([field]) => field !== "undo" && field !== "undone")),
        undo: entry.undo,
        ...(entry.text.startsWith("Undone: ") && { undone: true as const }),
      } as DreamLine;
    }),
  });

  const state = (): DreamState => {
    const current = running.get();
    const latest = store.latest();
    // The next night a dream will run: tonight's, unless one already stood in for it.
    const tonight = slotAfter(clock.now());
    return {
      time: timeOf(),
      next_at: toTimestamp(isCovered(tonight) ? slotAfter(tonight) : tonight),
      ...(current && { dreaming: { since: toTimestamp(current.startedAt), trigger: current.trigger } }),
      ...(latest && { latest: withUndo(latest) }),
    };
  };

  const setRunning = (change: (current: Running) => Running): void => {
    running.update((current) => (current ? change(current) : current));
  };

  // A photo they shared, put in the dream's workspace with the day it was taken, when it says.
  const placePhoto = (message: Message, attachment: Attachment): SharedPhoto | undefined => {
    const source = sources.attachmentPath(attachment.id);
    if (!existsSync(source)) return undefined;
    const relative = path.join("uploads", `${attachment.id}${imageExtensions[attachment.media_type] ?? ".jpg"}`);
    try {
      const target = path.join(workspace, relative);
      mkdirSync(path.dirname(target), { recursive: true });
      if (!existsSync(target)) copyFileSync(source, target);
      const takenDay = readTakenDay(readStart(source));
      return {
        path: relative,
        at: message.at,
        ...(message.thread !== undefined && { thread: message.thread }),
        ...(takenDay !== undefined && { takenDay }),
        ...(message.text.trim() !== "" && { caption: message.text }),
      };
    } catch (error) {
      info("A photo couldn't be put in the dream's workspace", { error: String(error) });
      return undefined;
    }
  };

  // What a dream reads: everything since the last dream, digested.
  const sharePhotos = (messages: readonly Message[]): readonly SharedPhoto[] =>
    messages
      .filter(({ role }) => role === "user")
      .flatMap((message) =>
        (message.attachments ?? [])
          .filter(({ media_type }) => isImage(media_type))
          .map((attachment) => placePhoto(message, attachment))
          .filter((photo): photo is SharedPhoto => photo !== undefined),
      );

  const promptOf = async (current: Running, since: number): Promise<string> => {
    const zone = timeZone();
    const from = toTimestamp(since);
    const messages = sources.messagesSince(from, mostMessages);
    const threadTitle = (id: string): string => {
      const title = sources.thread(id)?.title;
      return title === undefined ? `a thread (${id})` : `the thread “${title}” (${id})`;
    };
    const until = clock.now() + 2 * dayMs;
    const mail = await sources.mailSince(since);
    const latest = store.latest();
    return [
      instructions.trim(),
      "",
      "<dream>",
      `It's ${toSpoken(clock.now(), zone)} where they are (${zone}). ` +
        (current.trigger === "manual" ? "They asked you to dream now. " : "It's your nightly dream. ") +
        (latest === undefined
          ? "This is your first dream: look back over the last day."
          : `Your last dream was ${whenOf(latest.started_at, zone)}: look back over everything since.`),
      `The day you're mostly looking back on is ${dayOf(current.trigger === "scheduled" ? current.slot : current.startedAt)}.`,
      "</dream>",
      "",
      notesText(current.notes, zone),
      "",
      conversationsText(messages, sources.thread, zone),
      "",
      photosText(sharePhotos(messages), zone, threadTitle),
      "",
      workText(sources.doneSince(from), zone),
      "",
      mailText(mail),
      "",
      calendarText(
        sources.calendar().filter((item) => Date.parse(item.end) >= since && Date.parse(item.start) <= until),
        zone,
      ),
      "",
      tracksText(sources.tracks(), from, zone),
    ].join("\n");
  };

  const kumoItems = (): ReadonlyMap<string, KumoItem> =>
    new Map(
      sources
        .calendar()
        .filter((item) => item.calendar.kumo)
        .map((item) => {
          const block = changes.block(item.uid);
          return [item.uid, { item, ...(block && { block }) }] as const;
        }),
    );

  const touch = (touched: Touched): void => {
    const key = keyOfTouched(touched);
    setRunning((current) =>
      current.touched.has(key) ? current : { ...current, touched: new Map([...current.touched, [key, touched]]) },
    );
  };

  type Before =
    | { readonly kind: "page"; readonly address: string; readonly version: string | undefined }
    | { readonly kind: "wake_ups"; readonly all: ReadonlyMap<string, WakeUp> }
    | { readonly kind: "calendar"; readonly all: ReadonlyMap<string, KumoItem> }
    | undefined;

  const before = async (name: string, input: unknown): Promise<Before> => {
    if (watchedMemory.has(name)) {
      const address = addressOf(name, input);
      return toLocation(address).ok ? { kind: "page", address, version: await changes.versionOf(address) } : undefined;
    }
    if (watchedWakeUps.has(name)) {
      return { kind: "wake_ups", all: new Map(changes.wakeUps().map((wakeUp) => [wakeUp.id, wakeUp])) };
    }
    return watchedCalendar.has(name) ? { kind: "calendar", all: kumoItems() } : undefined;
  };

  const after = (seen: Before): void => {
    if (seen === undefined) return;
    switch (seen.kind) {
      case "page": {
        touch({
          kind: "page",
          address: seen.address,
          before: seen.version,
          ...(seen.version !== undefined && { title: changes.titleOf(seen.address) }),
        });
        return;
      }
      case "wake_ups": {
        const now = new Map(changes.wakeUps().map((wakeUp) => [wakeUp.id, wakeUp]));
        const ids = new Set([...seen.all.keys(), ...now.keys()]);
        for (const id of ids) {
          if (!isSameWakeUp(seen.all.get(id), now.get(id))) touch({ kind: "wake_up", id, before: seen.all.get(id) });
        }
        return;
      }
      case "calendar": {
        const now = kumoItems();
        const uids = new Set([...seen.all.keys(), ...now.keys()]);
        for (const uid of uids) {
          if (!isSameItem(seen.all.get(uid)?.item, now.get(uid)?.item)) {
            touch({ kind: "event", uid, before: seen.all.get(uid) });
          }
        }
      }
    }
  };

  // What each touched thing became, net: nothing when it ended as it began.
  const settle = async (touched: Touched): Promise<Change | undefined> => {
    const key = keyOfTouched(touched);
    switch (touched.kind) {
      case "page": {
        const version = await changes.versionOf(touched.address);
        if (version === touched.before) return undefined;
        const title = changes.titleOf(touched.address) ?? touched.title ?? touched.address;
        const isJournal = touched.address.startsWith("memory:journal/");
        const text =
          version === undefined
            ? `Forgot “${title}”`
            : isJournal
              ? `Wrote your journal for ${title}`
              : touched.before === undefined
                ? `Started “${title}”`
                : `Rewrote “${title}”`;
        const undo: PageUndo = {
          kind: "dream_page",
          address: touched.address,
          ...(touched.before !== undefined && { before: touched.before }),
          ...(version !== undefined && { after: version }),
        };
        return {
          key,
          group: isJournal ? "saved" : touched.address === "memory:helping-you" ? "noticed" : "tidied",
          text,
          pointer: { page: touched.address },
          undo,
        };
      }
      case "wake_up": {
        const now = changes.wakeUps().find(({ id }) => id === touched.id);
        if (isSameWakeUp(now, touched.before)) return undefined;
        const what = now?.what ?? touched.before?.what ?? "a wake-up";
        const text =
          touched.before === undefined
            ? `Set “${what}” for ${whenOf(now?.at ?? clock.now(), timeZone())}`
            : now === undefined
              ? `Dropped “${what}”`
              : `Moved “${what}” to ${whenOf(now.at, timeZone())}`;
        const undo: WakeUpUndo = {
          kind: "dream_wake_up",
          id: touched.id,
          ...(touched.before && { before: touched.before }),
          ...(now && { after: now }),
        };
        return { key, group: "planned", text, pointer: { wake_up: touched.id }, undo };
      }
      case "event": {
        const now = kumoItems().get(touched.uid);
        const was = touched.before;
        if (isSameItem(now?.item, was?.item)) return undefined;
        const item = now?.item ?? was?.item;
        if (!item) return undefined;
        const title = withoutGuessMark(item.title);
        const zone = timeZone();
        const span = `${whenOf(item.start, zone)}–${whenOf(item.end, zone).slice(-5)}`;
        const undo: ChangeUndo | undefined =
          was === undefined
            ? { kind: "kumo_block_added", uid: touched.uid }
            : now === undefined
              ? {
                  kind: "kumo_block_removed",
                  event: {
                    uid: was.item.uid,
                    title: was.item.title,
                    start: was.item.start,
                    end: was.item.end,
                    ...(was.item.all_day && { allDay: true }),
                    ...(was.item.location !== undefined && { location: was.item.location }),
                  },
                  ...(was.block && { block: was.block }),
                }
              : { kind: "kumo_block_moved", uid: touched.uid, start: was.item.start, end: was.item.end };
        const text =
          was === undefined
            ? `${now?.item.guess === undefined ? "Planned" : "Guessed"} “${title}”, ${span}`
            : now === undefined
              ? `Removed “${title}”, ${span}`
              : `Moved “${title}” to ${span}`;
        return { key, group: "planned", text, pointer: { event: item.id }, undo, event: item };
      }
      case "message": {
        return {
          key,
          group: "saved",
          text: `Messaged you: “${quoted(touched.text)}”`,
          pointer: { message: touched.id },
        };
      }
    }
  };

  // The record: Kumo's lines first, each taking the change it points at, then a line for each change it didn't
  // mention, so nothing a dream changed goes unsaid. Each change is one entry in Done, with its undo.
  const finish = async (current: Running): Promise<Dream> => {
    const id = newId();
    const all = await Promise.all(current.touched.values().map((touched) => settle(touched)));
    const settled = all.filter((change): change is Change => change !== undefined);
    const byKey = new Map(settled.map((change) => [change.key, change]));
    const recorded = (change: Change, text: string): DoneEntry =>
      desk.addDone({
        text,
        dream: id,
        quiet: false,
        ...(change.event && { event: change.event }),
        ...(change.undo !== undefined && { undo: change.undo }),
      });
    const taken = createCell<ReadonlySet<string>>(new Set());
    const written = current.lines.map((line): DreamLine => {
      const change = line.key === undefined || taken.get().has(line.key) ? undefined : byKey.get(line.key);
      if (change) taken.update((keys) => new Set([...keys, change.key]));
      const entry = change ? recorded(change, line.text) : undefined;
      const pointer: Pointer = change ? change.pointer : line;
      return {
        group: line.group,
        text: line.text,
        ...(pointer.page !== undefined && { page: pointer.page }),
        ...(pointer.wake_up !== undefined && { wake_up: pointer.wake_up }),
        ...(pointer.event !== undefined && { event: pointer.event }),
        ...(pointer.message !== undefined && { message: pointer.message }),
        ...(entry && { done: entry.id, undo: entry.undo }),
      };
    });
    const unsaid = settled
      .filter((change) => !taken.get().has(change.key))
      .map((change): DreamLine => {
        const entry = recorded(change, change.text);
        return { group: change.group, text: change.text, ...change.pointer, done: entry.id, undo: entry.undo };
      });
    const dream: Dream = {
      id,
      day: dayOf(current.trigger === "scheduled" ? current.slot : current.startedAt),
      trigger: current.trigger,
      started_at: toTimestamp(current.startedAt),
      ended_at: toTimestamp(clock.now()),
      ...(current.headline !== undefined && { headline: current.headline }),
      lines: [...written, ...unsaid],
    };
    store.save(dream, toTimestamp(current.slot));
    notes.taken(current.notes, id);
    publish(dream);
    return dream;
  };

  const disarm = (cell: typeof timer): void => {
    cell.get()?.();
    cell.set(undefined);
  };

  const arm = (): void => {
    disarm(timer);
    if (!isScheduled || isClosed.get()) return;
    const next = slotAfter(clock.now());
    const wait = Math.min(Math.max(0, next - clock.now()), longestTimerMs);
    const fire = (): void => {
      timer.set(undefined);
      arm();
      if (next <= clock.now()) track(due(next));
    };
    timer.set(clock.after(wait, fire));
  };

  const retryLater = (slot: number): void => {
    disarm(retryTimer);
    const at = clock.now() + retryMs;
    if (isClosed.get() || at >= slotAfter(slot)) return;
    retryTimer.set(
      clock.after(retryMs, () => {
        retryTimer.set(undefined);
        track(due(slot));
      }),
    );
  };

  const dream = async (trigger: Trigger, slot: number): Promise<void> => {
    if (running.get() || isClosed.get()) return;
    const startedAt = clock.now();
    const latest = store.latest();
    const since = Math.max(
      latest === undefined ? startedAt - dayMs : Date.parse(latest.started_at),
      startedAt - longestLookBackMs,
    );
    const current: Running = {
      run: `${dreamRunPrefix}${randomUUID()}`,
      trigger,
      slot,
      startedAt,
      notes: notes.waiting(),
      touched: new Map(),
      lines: [],
    };
    running.set(current);
    info("Kumo is dreaming", { trigger, since: toTimestamp(since) });
    try {
      const done = await work(await promptOf(current, since), current.run);
      const ended = running.get();
      if (!ended || isClosed.get()) return;
      if (done.ok) {
        disarm(retryTimer);
        const record = await finish(ended);
        info("Kumo dreamt", { dream: record.id, lines: record.lines.length });
        return;
      }
      info("Kumo couldn't dream, so it tries again later", { trigger, error: done.failure });
      if (trigger === "scheduled") retryLater(slot);
    } catch (error) {
      info("Kumo's dream failed", { error: String(error) });
      if (trigger === "scheduled") retryLater(slot);
    } finally {
      running.set(undefined);
    }
  };

  const track = (job: Promise<void>): void => {
    void finished.update(async (previous) => {
      await Promise.all([previous, job]);
    });
  };

  // A night's dream comes due: unless one already stands in for it, or one is running (then it looks again after).
  const due = async (slot: number): Promise<void> => {
    if (isClosed.get()) return;
    if (running.get()) {
      await finished.get();
      if (running.get()) return;
    }
    if (isCovered(slot)) return;
    const job = dream("scheduled", slot);
    track(job);
    await job;
  };

  // One line Kumo wrote for the record, with what it points at, or what's wrong with it.
  const readLine = (
    item: unknown,
    where: string,
    current: Running,
    onCalendar: ReadonlyMap<string, KumoItem>,
  ): Written | string => {
    const group = groups.find((candidate) => candidate === lineOf(item, "group"));
    const text = lineOf(item, "text");
    if (group === undefined || text === "") {
      return `${where} needs a group (planned, tidied, noticed or saved) and its text.`;
    }
    const page = lineOf(item, "page");
    if (page !== "" && !toLocation(page).ok) return `${where}: ${page} isn't a memory address.`;
    const wakeUp = lineOf(item, "wake_up");
    const isWakeUp =
      wakeUp === "" || current.touched.has(`wake_up:${wakeUp}`) || changes.wakeUps().some(({ id }) => id === wakeUp);
    if (!isWakeUp) return `${where}: there's no wake-up ${wakeUp}.`;
    const named = lineOf(item, "event");
    const found = onCalendar.get(named) ?? onCalendar.values().find(({ item: shown }) => shown.id === named);
    const gone = current.touched.get(`event:${named}`);
    const uid = found?.item.uid ?? (gone === undefined ? undefined : named);
    if (named !== "" && uid === undefined) return `${where}: there's no block or guess ${named} on your calendar.`;
    const message = lineOf(item, "message");
    if (message !== "" && !current.touched.has(`message:${message}`)) {
      return `${where}: ${message} isn't a message you posted in this dream.`;
    }
    const event = found?.item.id ?? (gone?.kind === "event" ? gone.before?.item.id : undefined);
    const pointer: Pointer = {
      ...(page !== "" && { page }),
      ...(wakeUp !== "" && { wake_up: wakeUp }),
      ...(event !== undefined && { event }),
      ...(message !== "" && { message }),
    };
    const key =
      page === ""
        ? wakeUp === ""
          ? uid === undefined
            ? message === ""
              ? undefined
              : `message:${message}`
            : `event:${uid}`
          : `wake_up:${wakeUp}`
        : `page:${page}`;
    return { group, text: shortened(text, longestLine), ...pointer, ...(key !== undefined && { key }) };
  };

  const recordTool: Tool = {
    name: "record_dream",
    title: "Leave the dream's record",
    audience: "dream",
    description:
      "Leave the record of this dream for them: a headline for the night and short lines, each in one group " +
      "(planned, tidied, noticed or saved for you) and pointing at what it changed or is about, by page address, " +
      "wake-up id, your block's uid or message id, so they can open it or undo it. Calling it again replaces the " +
      "lines. Whatever you changed that no line points at gets a plain line of its own.",
    inputSchema: {
      type: "object",
      properties: {
        headline: {
          type: "string",
          description: "The night in a line, such as “A quiet Wednesday: journal written, Thursday planned”.",
        },
        lines: {
          type: "array",
          items: {
            type: "object",
            properties: {
              group: { enum: groups },
              text: { type: "string", description: "One short line, such as “Moved tomorrow's run to 07:30”." },
              page: { type: "string", description: "A memory page's address." },
              wake_up: { type: "string", description: "A wake-up's id." },
              event: { type: "string", description: "Your block's or guess's uid." },
              message: { type: "string", description: "A message you posted, by id." },
            },
            required: ["group", "text"],
            additionalProperties: false,
          },
        },
      },
      required: ["lines"],
      additionalProperties: false,
    },
    call: (input) => {
      const current = running.get();
      if (!current || contextRun() !== current.run) return Promise.resolve(failed("Only a dream leaves a record."));
      const given = fieldOf(input, "lines");
      const onCalendar = kumoItems();
      const items = Array.isArray(given) ? (given as readonly unknown[]) : [];
      const read = items.map((item, index) => readLine(item, `Line ${String(index + 1)}`, current, onCalendar));
      const problems = read.filter((line): line is string => typeof line === "string");
      if (problems.length > 0) return Promise.resolve(failed(problems.join(" ")));
      const headline = shortened(lineOf(input, "headline"), longestHeadline);
      const lines = read.filter((line): line is Written => typeof line !== "string");
      setRunning((ongoing) => ({ ...ongoing, lines, ...(headline !== "" && { headline }) }));
      return Promise.resolve({
        text: `Kept ${String(lines.length)} line${lines.length === 1 ? "" : "s"} for the record; it's saved when the dream ends.`,
      });
    },
  };

  desk.onUndo(async (_entry, payload) => {
    if (isPageUndo(payload)) {
      const now = await changes.versionOf(payload.address);
      return now === payload.after
        ? changes.revert(payload.address, payload.before, "Took back a change from Kumo's dream")
        : fail("It's changed since the dream: ask Kumo to put it back instead.");
    }
    if (isWakeUpUndo(payload)) {
      const now = changes.wakeUps().find(({ id }) => id === payload.id);
      if (!isSameWakeUp(now, payload.after)) return fail("It's changed since the dream.");
      if (payload.before) {
        const put = changes.putWakeUp(payload.before);
        return put.ok ? ok(undefined) : fail(put.failure);
      }
      changes.cancelWakeUp(payload.id);
    }
    return ok(undefined);
  });

  // The server was off at a dream time, or stopped mid-dream: the night's dream runs once it's back.
  const catchUp = (): void => {
    if (!isScheduled) return;
    const last = slotBy(clock.now());
    const from = Date.parse(settings.setting(dreamFromSetting) ?? "");
    if (Number.isNaN(from) || last <= from || isCovered(last)) return;
    track(due(last));
  };

  arm();
  // Once the rest of the server is up.
  const catchingUp = isScheduled ? clock.after(0, catchUp) : undefined;

  return {
    tools: [recordTool],
    state,
    dreamNow: () => {
      if (!running.get() && !isClosed.get()) {
        const now = clock.now();
        track(dream("manual", slotAfter(now - standInMs)));
      }
      return state();
    },
    setTime: (time) => {
      if (!clockPattern.test(time)) return fail("Give the time as HH:MM, such as 04:00.");
      settings.setSetting(dreamTimeSetting, time);
      arm();
      return ok(state());
    },
    see: (id) => {
      const found = store.find(id);
      if (!found) return;
      if (found.seen_at !== undefined) return withUndo(found);
      const seen: Dream = { ...found, seen_at: toTimestamp(clock.now()) };
      store.replace(seen);
      return withUndo(seen);
    },
    watch: (tool) =>
      watchedMemory.has(tool.name) || watchedWakeUps.has(tool.name) || watchedCalendar.has(tool.name)
        ? {
            ...tool,
            call: async (input) => {
              const current = running.get();
              if (!current || contextRun() !== current.run) return tool.call(input);
              const seen = await before(tool.name, input);
              const result = await tool.call(input);
              if (result.isError !== true) after(seen);
              return result;
            },
          }
        : tool,
    posted: (run, message) => {
      const current = running.get();
      if (current && run === current.run) touch({ kind: "message", id: message.id, text: message.text });
    },
    refit: arm,
    settled: () => finished.get(),
    close: () => {
      isClosed.set(true);
      catchingUp?.();
      disarm(timer);
      disarm(retryTimer);
    },
  };
};

// The dream's instructions, read once.
export const dreamInstructions = readFileSync(new URL("../../agent/dream.md", import.meta.url), "utf8");
