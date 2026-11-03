import { createCell } from "#cell.ts";
import type { Clock } from "#clock.ts";
import type { AgendaEntry, Calendar } from "#calendar/calendar.ts";
import { toSpoken } from "#desk/day.ts";
import type { WakeUp } from "#protocol/types.ts";
import type { Result } from "#result.ts";
import type { Settings } from "#store/store.ts";
import type { Info } from "#turns/turns.ts";

// Kumo wakes when their calendar changes: an event added, moved, changed or gone on their own calendars, or an invite
// arriving. It looks and decides, as with a mail; nothing is said by rule. What it has looked at is kept, so a change
// is seen once, across restarts, and one Kumo couldn't look at is looked at again later.
export type CalendarChanges = {
  readonly close: () => void;
};

export type CalendarChangesOptions = {
  readonly calendar: Pick<Calendar, "agenda" | "isConnected" | "onRefreshed" | "onWritten">;
  readonly settings: Settings;
  readonly clock: Clock;
  readonly timeZone: () => string;
  readonly work: (prompt: string) => Promise<Result<string, string>>;
  readonly wakeUps: { readonly tiedTo: (uids: readonly string[]) => readonly WakeUp[] };
  readonly describe: (wakeUp: WakeUp) => string;
  readonly info: Info;
};

export const seenSetting = "calendar_seen";

type Seen = { readonly at: number; readonly entries: readonly AgendaEntry[] };

export type Change = {
  readonly kind: "new" | "moved" | "changed" | "gone";
  readonly entry: AgendaEntry;
  readonly before?: AgendaEntry;
};

const dayMs = 24 * 60 * 60 * 1000;
// What a read covers ahead, and the part of it where a change counts: a little less, so an event coming into the
// window as time passes isn't new.
const readAheadMs = 8 * dayMs;
const watchedMs = 7 * dayMs;
// After Kumo couldn't look, it waits this long before it tries again.
const retryMs = 15 * 60 * 1000;

const isGone = ({ state }: AgendaEntry): boolean => state === "cancelled" || state === "declined";

const startOf = (entry: AgendaEntry): number => Date.parse(entry.allDay ? `${entry.start}T00:00:00.000Z` : entry.start);

const endOf = (entry: AgendaEntry): number => Date.parse(entry.allDay ? `${entry.end}T23:59:59.999Z` : entry.end);

const isWatched = (entry: AgendaEntry, now: number): boolean => endOf(entry) > now && startOf(entry) < now + watchedMs;

// What changed between two reads, among events still to come in the week ahead.
export const toChanges = (seen: Seen, now: number, entries: readonly AgendaEntry[]): readonly Change[] => {
  const before = new Map(seen.entries.map((entry) => [entry.id, entry]));
  const after = new Map(entries.map((entry) => [entry.id, entry]));
  const appeared = entries.flatMap((entry): readonly Change[] => {
    const was = before.get(entry.id);
    if (!isWatched(entry, now)) return [];
    if (!was) return startOf(entry) < seen.at + readAheadMs && !isGone(entry) ? [{ kind: "new", entry }] : [];
    if (isGone(entry) && !isGone(was)) return [{ kind: "gone", entry, before: was }];
    if (was.start !== entry.start || was.end !== entry.end) return [{ kind: "moved", entry, before: was }];
    const isChanged = was.title !== entry.title || was.location !== entry.location || was.state !== entry.state;
    return isChanged ? [{ kind: "changed", entry, before: was }] : [];
  });
  const vanished = seen.entries.flatMap((was): readonly Change[] =>
    !after.has(was.id) && isWatched(was, now) && startOf(was) > now && !isGone(was)
      ? [{ kind: "gone", entry: was, before: was }]
      : [],
  );
  return [...appeared, ...vanished];
};

export const createCalendarChanges = ({
  calendar,
  settings,
  clock,
  timeZone,
  work,
  wakeUps,
  describe,
  info,
}: CalendarChangesOptions): CalendarChanges => {
  // The events Kumo changed itself, each with when, in order, so a write made while it looks isn't forgotten.
  const written = createCell<ReadonlyMap<string, number>>(new Map());
  const writes = createCell(0);
  const isLooking = createCell(false);
  const waitUntil = createCell(0);
  const isClosed = createCell(false);

  const seen = (): Seen | undefined => {
    const saved = settings.setting(seenSetting);
    return saved === undefined ? undefined : (JSON.parse(saved) as Seen);
  };

  const remember = (at: number, entries: readonly AgendaEntry[]): void => {
    settings.setSetting(seenSetting, JSON.stringify({ at, entries }));
  };

  const whenOf = (entry: AgendaEntry): string =>
    entry.allDay
      ? entry.start === entry.end
        ? entry.start
        : `${entry.start} to ${entry.end}`
      : new Intl.DateTimeFormat("en-GB", {
          timeZone: timeZone(),
          weekday: "short",
          day: "numeric",
          month: "short",
          hour: "2-digit",
          minute: "2-digit",
          hourCycle: "h23",
        }).format(Date.parse(entry.start));

  const lineOf = ({ kind, entry, before }: Change): string => {
    const where = entry.location === undefined ? "" : ` at ${entry.location}`;
    const uid = ` (uid ${entry.uid})`;
    switch (kind) {
      case "new": {
        return entry.state === "invited"
          ? `- New invite: ${entry.title}, ${whenOf(entry)}${where}; it's on their Desk to answer${uid}`
          : `- New: ${entry.title}, ${whenOf(entry)}${where}${uid}`;
      }
      case "moved": {
        return `- Moved: ${entry.title}, now ${whenOf(entry)}, was ${before ? whenOf(before) : "earlier"}${uid}`;
      }
      case "changed": {
        const what = [
          ...(before && before.title !== entry.title ? [`was called ${before.title}`] : []),
          ...(before && before.location !== entry.location ? [`now${where || " with no place"}`] : []),
          ...(before && before.state !== entry.state ? [`now ${entry.state}`] : []),
        ].join(", ");
        return `- Changed: ${entry.title}, ${whenOf(entry)}: ${what}${uid}`;
      }
      case "gone": {
        const how = entry.state === "declined" ? "Declined" : "Cancelled or removed";
        return `- ${how}: ${entry.title}, ${whenOf(entry)}${uid}`;
      }
    }
  };

  const promptOf = (changes: readonly Change[]): string => {
    const tied = wakeUps.tiedTo(changes.map(({ entry }) => entry.uid));
    return [
      `It's ${toSpoken(clock.now(), timeZone())}. Their calendar changed:`,
      ...changes.map(lineOf),
      ...(tied.length > 0 ? ["", "Your wake-ups from these events:", ...tied.map(describe)] : []),
      "",
      "Look and decide, as for a mail. Message them with post only if one of these matters to them now, one",
      "message per thing. Move or drop a wake-up whose event moved or went, move your own blocks that now clash, and",
      "set a wake-up for anything that needs a look later. Most changes need nothing.",
      "End with one line saying what you did.",
    ].join("\n");
  };

  const look = async (): Promise<void> => {
    if (isClosed.get() || isLooking.get() || !calendar.isConnected()) return;
    const now = clock.now();
    const entries = calendar.agenda();
    const before = seen();
    const mine = written.get();
    const lastWrite = writes.get();
    const changes =
      before === undefined ? [] : toChanges(before, now, entries).filter(({ entry }) => !mine.has(entry.uid));
    if (changes.length === 0) {
      remember(now, entries);
      written.set(new Map());
      return;
    }
    if (now < waitUntil.get()) return;
    isLooking.set(true);
    try {
      const done = await work(promptOf(changes));
      if (done.ok) {
        remember(now, entries);
        written.update((current) => new Map([...current].filter(([, write]) => write > lastWrite)));
      } else {
        info("Kumo couldn't look at a change to the calendar, so it looks again later", { error: done.failure });
        waitUntil.set(clock.now() + retryMs);
      }
    } finally {
      isLooking.set(false);
    }
  };

  calendar.onWritten((uid) => {
    const write = writes.update((count) => count + 1);
    written.update((current) => new Map([...current, [uid, write]]));
  });
  calendar.onRefreshed(() => {
    void look();
  });

  return {
    close: () => {
      isClosed.set(true);
    },
  };
};
