import ICAL from "ical.js";
import { fail, ok, type Result } from "#result.ts";

// A calendar invitation a mail carries, such as an invite.ics or a text/calendar part, in plain words for Kumo:
// what it asks, and each event's times with their time zone, its UID, who organises it and who's asked, how it
// repeats, and whether it's an update or a cancellation. Read as data: nothing in it is acted on here.

const methods: Readonly<Record<string, string>> = {
  REQUEST: "an invitation, or an update to one: it isn't accepted until they answer it",
  CANCEL: "a cancellation",
  REPLY: "someone's answer to an invitation",
  COUNTER: "a proposal of a different time",
  DECLINECOUNTER: "a refusal of a proposed time",
  PUBLISH: "an event shared for their calendar, with nothing to answer",
  REFRESH: "a request for the latest version of an event",
  ADD: "more occurrences added to an event",
};

const partstats: Readonly<Record<string, string>> = {
  ACCEPTED: "accepted",
  DECLINED: "declined",
  TENTATIVE: "maybe",
  "NEEDS-ACTION": "hasn't answered",
  DELEGATED: "delegated",
};

const describeError = (error: unknown): string => (error instanceof Error ? error.message : String(error));

// A value ical.js gives that writes itself out as iCalendar text, such as a time, a number or a repeat rule.
type Written = { readonly toString: () => string };

const textOf = (component: ICAL.Component, name: string): string | undefined => {
  const value: unknown = component.getFirstPropertyValue(name);
  if (value === null || value === undefined) return undefined;
  const text = (typeof value === "string" ? value : (value as Written).toString()).trim();
  return text === "" ? undefined : text;
};

const parameterOf = (property: ICAL.Property, name: string): string | undefined => {
  const value: unknown = property.getFirstParameter(name);
  return typeof value === "string" && value !== "" ? value : undefined;
};

const personOf = (property: ICAL.Property): string => {
  const value: unknown = property.getFirstValue();
  const address = typeof value === "string" ? value.replace(/^mailto:/iu, "") : "";
  const name = parameterOf(property, "cn");
  return name === undefined ? address : `${name} <${address}>`;
};

const attendeeOf = (property: ICAL.Property): string => {
  const status = partstats[(parameterOf(property, "partstat") ?? "NEEDS-ACTION").toUpperCase()] ?? "hasn't answered";
  const isOptional = parameterOf(property, "role")?.toUpperCase() === "OPT-PARTICIPANT";
  return `${personOf(property)} (${status}${isOptional ? ", optional" : ""})`;
};

const isZoned = (time: ICAL.Time): boolean =>
  !time.isDate && time.zone !== ICAL.Timezone.utcTimezone && time.zone !== ICAL.Timezone.localTimezone;

// A time as the invite gives it, in its own zone, with the moment in UTC beside it so it can't be misread.
const timeOf = (time: ICAL.Time): string => {
  if (time.isDate) return `${time.toString()} (all day)`;
  const instant = time.toJSDate().toISOString().replace(".000Z", "Z");
  if (time.zone === ICAL.Timezone.utcTimezone) return instant;
  const local = time.toString();
  return isZoned(time) ? `${local} ${time.zone.tzid} (${instant})` : `${local}, a floating time with no time zone`;
};

const tzidOf = (component: ICAL.Component, name: string): string | undefined => {
  const property = component.getFirstProperty(name);
  return property ? parameterOf(property, "tzid") : undefined;
};

const eventLines = (component: ICAL.Component): readonly string[] => {
  const event = new ICAL.Event(component);
  const start = event.startDate as ICAL.Time | null;
  const end = event.endDate as ICAL.Time | null;
  const tzid = tzidOf(component, "dtstart");
  const isUnknownZone = tzid !== undefined && start !== null && !isZoned(start) && !start.isDate;
  const organizer = component.getFirstProperty("organizer");
  const attendees = component.getAllProperties("attendee");
  const rules = component.getAllProperties("rrule").map((property) => (property.getFirstValue() as Written).toString());
  const recurrenceId = component.getFirstPropertyValue("recurrence-id");
  const status = textOf(component, "status");
  const sequence = textOf(component, "sequence");
  const location = textOf(component, "location");
  const description = textOf(component, "description");
  const summary = textOf(component, "summary") ?? "(no title)";
  return [
    `- “${summary}”`,
    `  Starts: ${start === null ? "not given" : timeOf(start)}`,
    `  Ends: ${end === null ? "not given" : timeOf(end)}`,
    ...(isUnknownZone ? [`  Its time zone, ${tzid}, isn't described in the invitation, so the times may be off.`] : []),
    `  UID: ${textOf(component, "uid") ?? "none"}${sequence === undefined ? "" : `, sequence ${sequence}`}`,
    ...(recurrenceId instanceof ICAL.Time ? [`  It changes only the occurrence at ${timeOf(recurrenceId)}.`] : []),
    ...(status?.toUpperCase() === "CANCELLED" ? ["  Status: cancelled"] : []),
    ...(organizer ? [`  Organiser: ${personOf(organizer)}`] : []),
    ...(attendees.length > 0 ? [`  Asked: ${attendees.map((property) => attendeeOf(property)).join("; ")}`] : []),
    ...rules.map((rule) => `  Repeats: ${rule}`),
    ...(location === undefined ? [] : [`  Where: ${location}`]),
    ...(description === undefined ? [] : [`  Notes: ${description.replaceAll(/\s+/gu, " ").slice(0, 600)}`]),
  ];
};

export const describeInvite = (ics: string): Result<string, string> => {
  try {
    const root = ICAL.Component.fromString(ics);
    if (root.name !== "vcalendar") return fail("It isn't calendar data.");
    const method = textOf(root, "method")?.toUpperCase();
    const events = root.getAllSubcomponents("vevent");
    if (events.length === 0) return fail("It has no event in it.");
    const meaning = method === undefined ? undefined : methods[method];
    return ok(
      [
        `A calendar invitation, ${method === undefined ? "with no method given" : `${method}: ${meaning ?? "a method this doesn't know"}`}.`,
        ...events.flatMap((event) => eventLines(event)),
      ].join("\n"),
    );
  } catch (error) {
    return fail(`Its calendar data couldn't be read: ${describeError(error)}`);
  }
};
