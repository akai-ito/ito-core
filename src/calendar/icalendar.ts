import ICAL from "ical.js";
import { fail, ok, type Result } from "#result.ts";

export type Partstat = "accepted" | "tentative" | "declined" | "needs-action";

export type CalendarInfo = {
  readonly url: string;
  readonly name: string;
  readonly isKumo: boolean;
  readonly readOnly: boolean;
};

export type Attendee = { readonly email: string; readonly name?: string; readonly partstat: Partstat };

export type CalendarEvent = {
  readonly uid: string;
  readonly url: string;
  readonly etag?: string;
  readonly calendar: CalendarInfo;
  readonly title: string;
  readonly start: string;
  // All-day events end on their last day, so a one-day event starts and ends on the same date.
  readonly end: string;
  readonly allDay: boolean;
  readonly recurrenceId?: string;
  readonly location?: string;
  readonly notes?: string;
  readonly organizer?: { readonly email: string; readonly name?: string };
  readonly attendees: readonly Attendee[];
  readonly myStatus?: Partstat;
  readonly status?: "confirmed" | "tentative" | "cancelled";
};

export type NewCalendarEvent = {
  readonly uid?: string;
  readonly title: string;
  readonly start: string;
  readonly end: string;
  readonly allDay?: boolean;
  readonly location?: string;
  readonly notes?: string;
};

export type CalendarObject = {
  readonly ics: string;
  readonly url: string;
  readonly etag?: string;
  readonly calendar: CalendarInfo;
};

export type Range = { readonly from: number; readonly to: number };

type Series = {
  readonly root: ICAL.Component;
  readonly master?: ICAL.Component;
  readonly overrides: readonly ICAL.Component[];
};

type Occurrence = {
  readonly item: ICAL.Event;
  readonly start: ICAL.Time;
  readonly end: ICAL.Time;
  readonly recurrenceId?: ICAL.Time;
};

type Details = {
  readonly item: ICAL.Event;
  readonly startDate: ICAL.Time;
  readonly endDate: ICAL.Time;
  readonly recurrenceId: ICAL.Time;
};

type Times = { readonly start: ICAL.Time; readonly end: ICAL.Time };

const productId = "-//Akai Ito//Ito//EN";
const dateHint = "Give all-day dates as YYYY-MM-DD.";
const instantHint = "Give times as ISO instants with a zone, like 2026-11-13T14:00:00Z.";
const backwards = "An event has to end after it starts.";
const gone = "That occurrence isn't part of the event any more.";
const empty = "That calendar object has no event in it.";
const datePattern = /^\d{4}-\d{2}-\d{2}$/u;
const instantPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/u;

const partstats: Readonly<Record<string, Partstat>> = {
  ACCEPTED: "accepted",
  TENTATIVE: "tentative",
  DECLINED: "declined",
  "NEEDS-ACTION": "needs-action",
};

const statuses: Readonly<Record<string, NonNullable<CalendarEvent["status"]>>> = {
  CONFIRMED: "confirmed",
  TENTATIVE: "tentative",
  CANCELLED: "cancelled",
};

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const guarded = <Value>(work: () => Result<Value, string>): Result<Value, string> => {
  try {
    return work();
  } catch (error) {
    return fail(`That event's calendar data couldn't be read: ${describe(error)}`);
  }
};

const isDateText = (text: string): boolean =>
  datePattern.test(text) && new Date(`${text}T00:00:00Z`).toISOString().startsWith(text);

const instantEpoch = (text: string): number | undefined => {
  if (!instantPattern.test(text)) return undefined;
  const epoch = Date.parse(text);
  return Number.isNaN(epoch) ? undefined : epoch;
};

const epochOfText = (text: string): number | undefined =>
  isDateText(text) ? Date.parse(`${text}T00:00:00Z`) : instantEpoch(text);

export const toRange = (from: string, to: string): Result<Range, string> => {
  const start = epochOfText(from);
  const end = epochOfText(to);
  if (start === undefined || end === undefined) return fail(instantHint);
  return end > start ? ok({ from: start, to: end }) : fail("The range has to end after it starts.");
};

const epochOf = (time: ICAL.Time): number => time.toUnixTime() * 1000;

const momentOf = (time: ICAL.Time): string => (time.isDate ? time.toString() : new Date(epochOf(time)).toISOString());

const shiftedDays = (time: ICAL.Time, days: number): ICAL.Time => {
  const shifted = time.clone();
  shifted.adjust(days, 0, 0, 0);
  return shifted;
};

const lastDayOf = (start: ICAL.Time, end: ICAL.Time): string => {
  const last = shiftedDays(end, -1);
  return last.compare(start) < 0 ? start.toString() : last.toString();
};

const isZoned = (time: ICAL.Time): boolean =>
  !time.isDate && time.zone !== ICAL.Timezone.utcTimezone && time.zone !== ICAL.Timezone.localTimezone;

const serialize = (root: ICAL.Component): string => `${root.toString()}\r\n`;

const parse = (ics: string): Result<ICAL.Component, string> => {
  const root = ICAL.Component.fromString(ics);
  return root.name === "vcalendar" ? ok(root) : fail("That isn't an iCalendar object.");
};

const seriesOf = (ics: string): Result<Series, string> => {
  const parsed = parse(ics);
  if (!parsed.ok) return parsed;
  const events = parsed.value.getAllSubcomponents("vevent");
  return ok({
    root: parsed.value,
    master: events.find((event) => !event.hasProperty("recurrence-id")),
    overrides: events.filter((event) => event.hasProperty("recurrence-id")),
  });
};

const textOf = (component: ICAL.Component, name: string): string | undefined => {
  const value = component.getFirstPropertyValue(name);
  return typeof value === "string" && value !== "" ? value : undefined;
};

const parameterOf = (property: ICAL.Property, name: string): string | undefined => {
  const value: unknown = property.getFirstParameter(name);
  return typeof value === "string" && value !== "" ? value : undefined;
};

const emailOf = (property: ICAL.Property): string | undefined => {
  const value = property.getFirstValue();
  const address = typeof value === "string" && /^mailto:/iu.test(value) ? value.slice("mailto:".length) : undefined;
  return address ?? parameterOf(property, "email");
};

export const toAddress = (text: string): string =>
  text
    .replace(/^mailto:/iu, "")
    .trim()
    .toLowerCase();

const isMine = (property: ICAL.Property, addresses: readonly string[]): boolean => {
  const email = emailOf(property);
  return email !== undefined && addresses.includes(toAddress(email));
};

const toPartstat = (value: string | undefined): Partstat =>
  (value === undefined ? undefined : partstats[value.toUpperCase()]) ?? "needs-action";

const toAttendee = (property: ICAL.Property): readonly Attendee[] => {
  const email = emailOf(property);
  const name = parameterOf(property, "cn");
  return email === undefined
    ? []
    : [{ email, ...(name !== undefined && { name }), partstat: toPartstat(parameterOf(property, "partstat")) }];
};

const toOrganizer = (component: ICAL.Component): CalendarEvent["organizer"] => {
  const property = component.getFirstProperty("organizer");
  const email = property ? emailOf(property) : undefined;
  if (!property || email === undefined) return undefined;
  const name = parameterOf(property, "cn");
  return { email, ...(name !== undefined && { name }) };
};

const toEvent = (object: CalendarObject, addresses: readonly string[], occurrence: Occurrence): CalendarEvent => {
  const { component } = occurrence.item;
  const allDay = occurrence.start.isDate;
  const attendeeProperties = component.getAllProperties("attendee");
  const mine = attendeeProperties.find((property) => isMine(property, addresses));
  const location = textOf(component, "location");
  const notes = textOf(component, "description");
  const organizer = toOrganizer(component);
  const status = textOf(component, "status");
  const knownStatus = status === undefined ? undefined : statuses[status.toUpperCase()];
  return {
    uid: textOf(component, "uid") ?? "",
    url: object.url,
    ...(object.etag !== undefined && { etag: object.etag }),
    calendar: object.calendar,
    title: textOf(component, "summary") ?? "",
    start: momentOf(occurrence.start),
    end: allDay ? lastDayOf(occurrence.start, occurrence.end) : momentOf(occurrence.end),
    allDay,
    ...(occurrence.recurrenceId !== undefined && { recurrenceId: momentOf(occurrence.recurrenceId) }),
    ...(location !== undefined && { location }),
    ...(notes !== undefined && { notes }),
    ...(organizer !== undefined && { organizer }),
    attendees: attendeeProperties.flatMap(toAttendee),
    ...(mine !== undefined && { myStatus: toPartstat(parameterOf(mine, "partstat")) }),
    ...(knownStatus !== undefined && { status: knownStatus }),
  };
};

const single = (component: ICAL.Component): Occurrence => {
  const item = new ICAL.Event(component);
  return {
    item,
    start: item.startDate,
    end: item.endDate,
    ...(item.isRecurrenceException() && { recurrenceId: item.recurrenceId }),
  };
};

const startsBefore = (expansion: ICAL.RecurExpansion, stop: number): readonly ICAL.Time[] =>
  Iterator.from<ICAL.Time>({
    next: () => {
      const value = expansion.next() as ICAL.Time | undefined;
      return value === undefined || epochOf(value) >= stop ? { done: true, value: undefined } : { done: false, value };
    },
  }).toArray();

const recurrenceIdOf = (component: ICAL.Component): ICAL.Time | undefined => {
  const value = component.getFirstPropertyValue("recurrence-id");
  return value instanceof ICAL.Time ? value : undefined;
};

const recurringOf = (series: Series): ICAL.Event | undefined => {
  if (!series.master) return undefined;
  const event = new ICAL.Event(series.master, { exceptions: [...series.overrides] });
  return event.isRecurring() ? event : undefined;
};

const findStart = (event: ICAL.Event, recurrenceId: string): ICAL.Time | undefined => {
  const target = epochOfText(recurrenceId);
  return target === undefined
    ? undefined
    : startsBefore(event.iterator(), target + 1).find((start) => epochOf(start) === target);
};

const findOverride = (series: Series, recurrenceId: string): ICAL.Component | undefined => {
  const target = epochOfText(recurrenceId);
  return series.overrides.find((override) => {
    const id = recurrenceIdOf(override);
    return id !== undefined && epochOf(id) === target;
  });
};

const toOccurrence = (event: ICAL.Event, start: ICAL.Time): Occurrence => {
  // ical.js's own typings import this shape without file extensions, so it resolves to an error type here.
  const details = event.getOccurrenceDetails(start) as unknown as Details;
  return { item: details.item, start: details.startDate, end: details.endDate, recurrenceId: details.recurrenceId };
};

const overlaps =
  (range: Range) =>
  (occurrence: Occurrence): boolean => {
    const start = epochOf(occurrence.start);
    return start < range.to && (epochOf(occurrence.end) > range.from || start >= range.from);
  };

export const byStart = (first: CalendarEvent, second: CalendarEvent): number =>
  (epochOfText(first.start) ?? 0) - (epochOfText(second.start) ?? 0);

export const toOccurrences = (
  object: CalendarObject,
  addresses: readonly string[],
  range: Range,
): Result<readonly CalendarEvent[], string> =>
  guarded(() => {
    const series = seriesOf(object.ics);
    if (!series.ok) return series;
    const recurring = recurringOf(series.value);
    const { master, overrides } = series.value;
    const stop = Math.max(
      range.to,
      ...overrides
        .map(recurrenceIdOf)
        .filter((id) => id !== undefined)
        .map((id) => epochOf(id) + 1),
    );
    const occurrences = recurring
      ? startsBefore(recurring.iterator(), stop).map((start) => toOccurrence(recurring, start))
      : (master ? [master] : overrides).map(single);
    return ok(
      occurrences
        .filter(overlaps(range))
        .map((occurrence) => toEvent(object, addresses, occurrence))
        .toSorted(byStart),
    );
  });

const occurrenceOf = (series: Series, recurrenceId: string): Occurrence | undefined => {
  const recurring = recurringOf(series);
  const start = recurring ? findStart(recurring, recurrenceId) : undefined;
  if (recurring && start) return toOccurrence(recurring, start);
  const override = findOverride(series, recurrenceId);
  return override ? single(override) : undefined;
};

export const toCalendarEvent = (
  object: CalendarObject,
  addresses: readonly string[],
  recurrenceId?: string,
): Result<CalendarEvent, string> =>
  guarded(() => {
    const series = seriesOf(object.ics);
    if (!series.ok) return series;
    const component = series.value.master ?? series.value.overrides[0];
    const occurrence =
      recurrenceId === undefined ? component && single(component) : occurrenceOf(series.value, recurrenceId);
    if (!occurrence) return fail(recurrenceId === undefined ? empty : gone);
    return ok(toEvent(object, addresses, occurrence));
  });

const startTimeOf = (text: string, allDay: boolean): Result<ICAL.Time, string> => {
  if (allDay) return isDateText(text) ? ok(ICAL.Time.fromDateString(text)) : fail(dateHint);
  const epoch = instantEpoch(text);
  return epoch === undefined ? fail(instantHint) : ok(ICAL.Time.fromJSDate(new Date(epoch), true));
};

const endTimeOf = (text: string, allDay: boolean): Result<ICAL.Time, string> => {
  const end = startTimeOf(text, allDay);
  return allDay && end.ok ? ok(shiftedDays(end.value, 1)) : end;
};

const ordered = (start: Result<ICAL.Time, string>, end: Result<ICAL.Time, string>): Result<Times, string> => {
  if (!start.ok) return start;
  if (!end.ok) return end;
  return end.value.compare(start.value) > 0 ? ok({ start: start.value, end: end.value }) : fail(backwards);
};

const zoned = (property: ICAL.Property, time: ICAL.Time): void => {
  if (isZoned(time)) property.setParameter("tzid", time.zone.tzid);
  else property.removeParameter("tzid");
};

const setTime = (component: ICAL.Component, name: string, time: ICAL.Time): void => {
  zoned(component.updatePropertyWithValue(name, time), time);
};

const addTime = (component: ICAL.Component, name: string, time: ICAL.Time): void => {
  zoned(component.addPropertyWithValue(name, time), time);
};

const setText = (component: ICAL.Component, name: string, value: string | undefined): void => {
  if (value === undefined) return;
  if (value === "") component.removeAllProperties(name);
  else component.updatePropertyWithValue(name, value);
};

const stampOf = (now: number): ICAL.Time => ICAL.Time.fromJSDate(new Date(now), true);

export const toIcs = (event: NewCalendarEvent, uid: string, now: number): Result<string, string> => {
  const allDay = event.allDay ?? isDateText(event.start);
  const times = ordered(startTimeOf(event.start, allDay), endTimeOf(event.end, allDay));
  if (!times.ok) return times;
  const root = new ICAL.Component("vcalendar");
  root.updatePropertyWithValue("prodid", productId);
  root.updatePropertyWithValue("version", "2.0");
  root.updatePropertyWithValue("calscale", "GREGORIAN");
  const vevent = new ICAL.Component("vevent");
  vevent.updatePropertyWithValue("uid", uid);
  for (const name of ["dtstamp", "created", "last-modified"]) vevent.updatePropertyWithValue(name, stampOf(now));
  vevent.updatePropertyWithValue("sequence", 0);
  vevent.updatePropertyWithValue("summary", event.title);
  setTime(vevent, "dtstart", times.value.start);
  setTime(vevent, "dtend", times.value.end);
  setText(vevent, "location", event.location);
  setText(vevent, "description", event.notes);
  root.addSubcomponent(vevent);
  return ok(serialize(root));
};

const overrideFor = (series: Series, recurrenceId: string): Result<ICAL.Component, string> => {
  const existing = findOverride(series, recurrenceId);
  if (existing) return ok(existing);
  const recurring = recurringOf(series);
  const start = recurring ? findStart(recurring, recurrenceId) : undefined;
  if (!recurring || !start) return fail(gone);
  const override = new ICAL.Component(structuredClone(recurring.component.toJSON() as unknown[]));
  for (const name of ["rrule", "rdate", "exdate"]) override.removeAllProperties(name);
  const end = start.clone();
  end.addDuration(recurring.endDate.subtractDate(recurring.startDate));
  override.removeAllProperties("duration");
  setTime(override, "recurrence-id", start);
  setTime(override, "dtstart", start.clone());
  setTime(override, "dtend", end);
  series.root.addSubcomponent(override);
  return ok(override);
};

const targetsOf = (series: Series, recurrenceId: string | undefined): Result<readonly ICAL.Component[], string> => {
  if (recurrenceId === undefined) return ok(series.root.getAllSubcomponents("vevent"));
  const override = overrideFor(series, recurrenceId);
  return override.ok ? ok([override.value]) : override;
};

const targetOf = (series: Series, recurrenceId: string | undefined): Result<ICAL.Component, string> => {
  if (recurrenceId !== undefined) return overrideFor(series, recurrenceId);
  const component = series.master ?? series.overrides[0];
  return component ? ok(component) : fail(empty);
};

const inZoneOf = (time: ICAL.Time, like: ICAL.Time): ICAL.Time =>
  isZoned(like) && !time.isDate ? time.convertToZone(like.zone) : time;

const changedTimes = (component: ICAL.Component, changes: Partial<NewCalendarEvent>): Result<Times, string> => {
  const current = new ICAL.Event(component);
  const wasAllDay = current.startDate.isDate;
  const allDay = changes.allDay ?? (changes.start === undefined ? wasAllDay : isDateText(changes.start));
  if (allDay !== wasAllDay && (changes.start === undefined || changes.end === undefined)) {
    return fail("Give both a start and an end when switching between all-day and timed.");
  }
  const start = changes.start === undefined ? ok(current.startDate) : startTimeOf(changes.start, allDay);
  if (!start.ok) return start;
  const keptLength = (): ICAL.Time => {
    const end = start.value.clone();
    end.addDuration(current.endDate.subtractDate(current.startDate));
    return end;
  };
  const end =
    changes.end === undefined
      ? ok(changes.start === undefined ? current.endDate : keptLength())
      : endTimeOf(changes.end, allDay);
  const times = ordered(start, end);
  return times.ok
    ? ok({ start: inZoneOf(times.value.start, current.startDate), end: inZoneOf(times.value.end, current.endDate) })
    : times;
};

export const withChanges = (
  ics: string,
  changes: Partial<NewCalendarEvent>,
  now: number,
  recurrenceId?: string,
): Result<string, string> =>
  guarded(() => {
    const series = seriesOf(ics);
    if (!series.ok) return series;
    const target = targetOf(series.value, recurrenceId);
    if (!target.ok) return target;
    const component = target.value;
    const isRetimed = changes.start !== undefined || changes.end !== undefined || changes.allDay !== undefined;
    const times = isRetimed ? changedTimes(component, changes) : undefined;
    if (times && !times.ok) return times;
    if (changes.title !== undefined) component.updatePropertyWithValue("summary", changes.title);
    setText(component, "location", changes.location);
    setText(component, "description", changes.notes);
    if (times) {
      component.removeAllProperties("duration");
      setTime(component, "dtstart", times.value.start);
      setTime(component, "dtend", times.value.end);
    }
    const sequence = component.getFirstPropertyValue("sequence");
    component.updatePropertyWithValue("sequence", (typeof sequence === "number" ? sequence : 0) + 1);
    component.updatePropertyWithValue("dtstamp", stampOf(now));
    component.updatePropertyWithValue("last-modified", stampOf(now));
    return ok(serialize(series.value.root));
  });

export const withResponse = (
  ics: string,
  addresses: readonly string[],
  answer: Exclude<Partstat, "needs-action">,
  recurrenceId?: string,
): Result<string, string> =>
  guarded(() => {
    const series = seriesOf(ics);
    if (!series.ok) return series;
    const targets = targetsOf(series.value, recurrenceId);
    if (!targets.ok) return targets;
    const mine = targets.value
      .flatMap((component) => component.getAllProperties("attendee"))
      .filter((property) => isMine(property, addresses));
    if (mine.length === 0) return fail("You aren't a guest on that event, so there's nothing to answer.");
    for (const property of mine) property.setParameter("partstat", answer.toUpperCase());
    return ok(serialize(series.value.root));
  });

export const withoutOccurrence = (ics: string, recurrenceId: string): Result<string | undefined, string> =>
  guarded(() => {
    const series = seriesOf(ics);
    if (!series.ok) return series;
    const override = findOverride(series.value, recurrenceId);
    if (override) series.value.root.removeSubcomponent(override);
    const recurring = recurringOf(series.value);
    const start = recurring ? findStart(recurring, recurrenceId) : undefined;
    if (recurring && start) addTime(recurring.component, "exdate", start);
    if (!override && !start) return fail(gone);
    return ok(series.value.root.getAllSubcomponents("vevent").length > 0 ? serialize(series.value.root) : undefined);
  });
