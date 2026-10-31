import { createHash } from "node:crypto";
import { createCell } from "#cell.ts";
import { toTimestamp, type Cancel, type Clock } from "#clock.ts";
import type { CalendarSource } from "#calendar/caldav.ts";
import type { CalendarEvent, CalendarInfo, NewCalendarEvent, Partstat } from "#calendar/icalendar.ts";
import type { Host } from "#capabilities/host.ts";
import type { Values } from "#capabilities/manifest.ts";
import type { DeskKeeper } from "#desk/desk.ts";
import type { CalendarItem, Card } from "#protocol/types.ts";
import { fail, ok, type Result } from "#result.ts";
import { icloudSource } from "#sources/sources.ts";
import { textOf } from "#tools/input.ts";
import type { Tool, ToolResult } from "#tools/mcp.ts";
import type { Info } from "#turns/turns.ts";

export type Calendar = {
  readonly tools: readonly Tool[];
  readonly isBusy: () => boolean;
  readonly refresh: () => Promise<void>;
  readonly addEvent: (event: NewCalendarEvent, isKumo?: boolean) => Promise<Result<CalendarItem, string>>;
  readonly onEventEnded: (listener: (uid: string) => void) => void;
  readonly onAdded: (listener: (item: CalendarItem) => void) => void;
  readonly close: () => void;
};

export type CalendarOptions = {
  readonly host: Pick<Host, "find" | "subscribe">;
  readonly desk: DeskKeeper;
  readonly clock: Clock;
  readonly timeZone: string;
  readonly info: Info;
  readonly createSource: (values: Values) => CalendarSource;
  readonly pollMs?: number;
};

const hourMs = 60 * 60 * 1000;
const dayMs = 24 * hourMs;
const comingUpMs = 36 * hourMs;
const holdPrefix = "hold-";

const failed = (text: string): ToolResult => ({ text, isError: true });

const toMs = (when: string): number => Date.parse(when.length === 10 ? `${when}T00:00:00.000Z` : when);

const toInstant = (when: string): string => (when.length === 10 ? when : new Date(Date.parse(when)).toISOString());

const toStatus = (event: CalendarEvent): NonNullable<CalendarItem["status"]> => {
  if (event.calendar.isKumo && event.uid.startsWith(holdPrefix)) return "hold";
  if (event.status === "tentative" || event.myStatus === "tentative" || event.myStatus === "needs-action") {
    return "tentative";
  }
  return "confirmed";
};

export const toCalendarItem = (event: CalendarEvent): CalendarItem => ({
  id: `v_${createHash("sha256")
    .update(`${event.url}#${event.recurrenceId ?? ""}`)
    .digest("hex")
    .slice(0, 20)}`,
  uid: event.uid,
  title: event.title,
  start: toInstant(event.start),
  end: toInstant(event.end),
  all_day: event.allDay,
  ...(event.location !== undefined && event.location !== "" && { location: event.location }),
  calendar: { name: event.calendar.name, kumo: event.calendar.isKumo },
  status: toStatus(event),
});

const isInvite = (event: CalendarEvent): boolean =>
  event.myStatus === "needs-action" && event.organizer !== undefined && !event.calendar.isKumo;

const overlaps = (left: CalendarEvent, right: CalendarEvent): boolean =>
  toMs(left.start) < toMs(right.end) && toMs(right.start) < toMs(left.end);

const toWhen = (start: string, timeZone: string): string =>
  new Intl.DateTimeFormat("en-GB", { timeZone, weekday: "long", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .format(toMs(start))
    .replace(",", "")
    .replace(" at ", " ");

const answers: Readonly<Record<string, Exclude<Partstat, "needs-action">>> = {
  Accept: "accepted",
  Maybe: "tentative",
  Decline: "declined",
};

const toAnswer = (option: string | undefined): Exclude<Partstat, "needs-action"> | undefined =>
  option === undefined ? undefined : answers[option];

const eventInput = (input: unknown): NewCalendarEvent => ({
  title: textOf(input, "title"),
  start: textOf(input, "start"),
  end: textOf(input, "end"),
  allDay: (input as { readonly all_day?: unknown } | undefined)?.all_day === true,
  ...(textOf(input, "location") !== "" && { location: textOf(input, "location") }),
  ...(textOf(input, "notes") !== "" && { notes: textOf(input, "notes") }),
});

export const createCalendar = ({
  host,
  desk,
  clock,
  timeZone,
  info,
  createSource,
  pollMs = 2 * 60 * 1000,
}: CalendarOptions): Calendar => {
  const cached = createCell<{ readonly key: string; readonly source: CalendarSource } | undefined>(undefined);
  const events = createCell<readonly CalendarEvent[]>([]);
  const timer = createCell<Cancel | undefined>(undefined);
  const isClosed = createCell(false);
  const refreshing = createCell<Promise<void>>(Promise.resolve());
  const endedListeners = createCell<readonly ((uid: string) => void)[]>([]);
  const addedListeners = createCell<readonly ((item: CalendarItem) => void)[]>([]);
  const seenEnded = createCell<ReadonlySet<string>>(new Set());

  const source = (): CalendarSource | undefined => {
    const found = host.find(icloudSource);
    if (found?.state !== "on") return undefined;
    const key = JSON.stringify(found.values);
    const current = cached.get();
    if (current?.key === key) return current.source;
    const made = createSource(found.values);
    cached.set({ key, source: made });
    return made;
  };

  const kumoCalendar = async (calendar: CalendarSource): Promise<Result<CalendarInfo, string>> => calendar.ensureKumo();

  const ownCalendar = async (calendar: CalendarSource): Promise<Result<CalendarInfo, string>> => {
    const listed = await calendar.calendars();
    if (!listed.ok) return listed;
    const own = listed.value.find(({ isKumo, readOnly }) => !isKumo && !readOnly);
    return own ? ok(own) : fail("There's no calendar of yours to add it to.");
  };

  const comingUp = (now: number): readonly CalendarItem[] =>
    events
      .get()
      .filter((event) => event.status !== "cancelled" && event.myStatus !== "declined")
      .filter((event) => {
        const start = toMs(event.start);
        const end = toMs(event.end);
        const isSoon = start < now + comingUpMs && end > now;
        const isBig = event.allDay && start < now + 7 * dayMs && end > now;
        return isSoon || isBig;
      })
      .filter((event) => !isInvite(event))
      .toSorted((left, right) => toMs(left.start) - toMs(right.start))
      .map((event) => toCalendarItem(event));

  const hasCard = (uid: string): boolean => desk.cards().some((card) => card.invite?.event.uid === uid);

  const holdFor = async (calendar: CalendarSource, invite: CalendarEvent): Promise<void> => {
    if (events.get().some((event) => event.uid === holdPrefix + invite.uid)) return;
    const kumo = await kumoCalendar(calendar);
    if (!kumo.ok) {
      info("Kumo's calendar couldn't be found or made", { error: kumo.failure });
      return;
    }
    const held = await calendar.create(kumo.value, {
      uid: holdPrefix + invite.uid,
      title: invite.title,
      start: invite.start,
      end: invite.end,
      allDay: invite.allDay,
      ...(invite.location !== undefined && { location: invite.location }),
      notes: "Held by Kumo until you answer the invite.",
    });
    if (held.ok) events.set([...events.get(), held.value]);
    else info("An invite couldn't be held", { error: held.failure });
  };

  const offerInvite = (invite: CalendarEvent): void => {
    const clash = events
      .get()
      .find(
        (event) =>
          event.uid !== invite.uid && event.uid !== holdPrefix + invite.uid && !event.allDay && overlaps(event, invite),
      );
    desk.addCard({
      kind: "invite",
      title: `${invite.title}, ${toWhen(invite.start, timeZone)}`,
      options: [{ label: "Accept", acts: true }, { label: "Maybe" }, { label: "Decline" }],
      allows_text: false,
      invite: { event: toCalendarItem(invite), ...(clash && { clash: toCalendarItem(clash) }) },
    });
  };

  const noticeEnded = (now: number): void => {
    const ended = events
      .get()
      .filter((event) => !event.allDay && toMs(event.end) <= now && toMs(event.end) > now - pollMs * 2);
    const fresh = ended.filter((event) => !seenEnded.get().has(event.uid));
    seenEnded.set(new Set([...seenEnded.get(), ...fresh.map(({ uid }) => uid)]));
    for (const event of fresh) for (const listener of endedListeners.get()) listener(event.uid);
  };

  const pull = async (): Promise<void> => {
    const calendar = source();
    if (!calendar) return;
    const now = clock.now();
    const listed = await calendar.events(toTimestamp(now - dayMs), toTimestamp(now + 8 * dayMs));
    if (!listed.ok) {
      info("The calendar couldn't be read", { error: listed.failure });
      return;
    }
    events.set(listed.value);
    const invites = listed.value.filter((event) => isInvite(event) && !hasCard(event.uid));
    for (const invite of invites) {
      await holdFor(calendar, invite);
      offerInvite(invite);
    }
    desk.setComingUp(comingUp(now));
    noticeEnded(now);
  };

  const refresh = (): Promise<void> =>
    refreshing.update(async (previous) => {
      await previous;
      if (isClosed.get()) return;
      try {
        await pull();
      } catch (error) {
        info("The calendar couldn't be refreshed", { error: String(error) });
      }
    });

  const poll = (): void => {
    if (isClosed.get()) return;
    timer.set(
      clock.after(pollMs, () => {
        void refresh().then(poll);
      }),
    );
  };

  const answerInvite = async (card: Card, option: string | undefined): Promise<undefined> => {
    const calendar = source();
    const answer = toAnswer(option);
    const invite = events.get().find((event) => event.uid === card.invite?.event.uid && !event.calendar.isKumo);
    if (!calendar || !answer || !invite) return undefined;
    const responded = await calendar.respond(invite, answer);
    if (!responded.ok) info("An invite couldn't be answered", { error: responded.failure });
    const hold = events.get().find((event) => event.uid === holdPrefix + invite.uid);
    if (hold) {
      const removed = await calendar.remove(hold);
      if (!removed.ok) info("A hold couldn't be cleared", { error: removed.failure });
    }
    await pull();
    return undefined;
  };

  desk.handle("invite", (card, answer) => answerInvite(card, answer.option));

  const findEvent = (uid: string): CalendarEvent | undefined => events.get().find((event) => event.uid === uid);

  const addEvent = async (event: NewCalendarEvent, isKumo = false): Promise<Result<CalendarItem, string>> => {
    const calendar = source();
    if (!calendar) return fail("iCloud isn't set up, so there's no calendar to add to.");
    const target = isKumo ? await kumoCalendar(calendar) : await ownCalendar(calendar);
    if (!target.ok) return target;
    const created = await calendar.create(target.value, event);
    if (!created.ok) return created;
    await refresh();
    const item = toCalendarItem(created.value);
    for (const listener of addedListeners.get()) listener(item);
    return ok(item);
  };

  const describe = (event: CalendarEvent): string =>
    `- ${event.uid}: ${event.title}, ${event.start} to ${event.end}${event.location ? ` at ${event.location}` : ""} (${event.calendar.name}${event.myStatus ? `, you: ${event.myStatus}` : ""})`;

  const eventSchema = {
    type: "object",
    properties: {
      title: { type: "string" },
      start: {
        type: "string",
        description: "An instant with its offset, such as 2026-11-13T14:00:00Z, or a date for all day.",
      },
      end: { type: "string" },
      all_day: { type: "boolean" },
      location: { type: "string" },
      notes: { type: "string", description: "Such as which mail it came from." },
      kumo: {
        type: "boolean",
        description: "Put it on Kumo's own calendar: holds, travel, prep, evening admin blocks.",
      },
    },
    required: ["title", "start", "end"],
    additionalProperties: false,
  };

  const tools: readonly Tool[] = [
    {
      name: "calendar_events",
      title: "Read the calendar",
      description:
        "List the events on every calendar between two instants, with their ids (uids), to find free time or what's on.",
      inputSchema: {
        type: "object",
        properties: { from: { type: "string" }, to: { type: "string" } },
        required: ["from", "to"],
        additionalProperties: false,
      },
      call: async (input) => {
        const calendar = source();
        if (!calendar) return failed("iCloud isn't set up yet.");
        const listed = await calendar.events(textOf(input, "from"), textOf(input, "to"));
        if (!listed.ok) return failed(listed.failure);
        return {
          text: listed.value.length === 0 ? "Nothing on." : listed.value.map((event) => describe(event)).join("\n"),
        };
      },
    },
    {
      name: "add_event",
      title: "Add to the calendar",
      description:
        "Add a confirmed commitment to their own calendar, with a note saying where it came from, or with kumo a block " +
        "on Kumo's calendar: travel (leave at), prep, or a short evening admin block.",
      inputSchema: eventSchema,
      call: async (input) => {
        const added = await addEvent(
          eventInput(input),
          (input as { readonly kumo?: unknown } | undefined)?.kumo === true,
        );
        return added.ok ? { text: `Added ${added.value.title} (${added.value.uid}).` } : failed(added.failure);
      },
    },
    {
      name: "change_event",
      title: "Change an event",
      description: "Move or rename an event by its uid. Change only events you made or that they asked you to change.",
      inputSchema: {
        type: "object",
        properties: {
          uid: { type: "string" },
          title: { type: "string" },
          start: { type: "string" },
          end: { type: "string" },
          location: { type: "string" },
        },
        required: ["uid"],
        additionalProperties: false,
      },
      call: async (input) => {
        const calendar = source();
        const event = findEvent(textOf(input, "uid"));
        if (!calendar || !event) return failed("There's no such event in the next week.");
        const changes = Object.fromEntries(
          ["title", "start", "end", "location"].flatMap((field) =>
            textOf(input, field) === "" ? [] : [[field, textOf(input, field)]],
          ),
        ) as Partial<NewCalendarEvent>;
        const changed = await calendar.update(event, changes);
        if (!changed.ok) return failed(changed.failure);
        await refresh();
        return { text: `Changed ${changed.value.title}.` };
      },
    },
    {
      name: "delete_event",
      title: "Remove an event",
      description: "Remove an event by its uid, such as a hold or a block that's no longer needed.",
      inputSchema: {
        type: "object",
        properties: { uid: { type: "string" } },
        required: ["uid"],
        additionalProperties: false,
      },
      call: async (input) => {
        const calendar = source();
        const event = findEvent(textOf(input, "uid"));
        if (!calendar || !event) return failed("There's no such event in the next week.");
        const removed = await calendar.remove(event);
        if (!removed.ok) return failed(removed.failure);
        await refresh();
        return { text: `Removed ${event.title}.` };
      },
    },
  ];

  const unsubscribe = host.subscribe(() => {
    void refresh();
  });
  void refresh();
  poll();

  return {
    tools,
    isBusy: () => {
      const now = clock.now();
      return events
        .get()
        .some(
          (event) =>
            !event.allDay && event.myStatus !== "declined" && toMs(event.start) <= now && now < toMs(event.end),
        );
    },
    refresh,
    addEvent,
    onEventEnded: (listener) => {
      endedListeners.update((current) => [...current, listener]);
    },
    onAdded: (listener) => {
      addedListeners.update((current) => [...current, listener]);
    },
    close: () => {
      isClosed.set(true);
      timer.get()?.();
      unsubscribe();
    },
  };
};
