import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCalendarSource, type CalendarSource } from "#calendar/caldav.ts";
import type { CalendarEvent, CalendarInfo } from "#calendar/icalendar.ts";
import { createCell } from "#cell.ts";
import type { Result } from "#result.ts";
import { startFakeCalDav, type FakeCalDav } from "./support/fake-caldav.ts";

const fake = createCell<FakeCalDav | undefined>(undefined);
const november = ["2026-11-01T00:00:00Z", "2026-12-01T00:00:00Z"] as const;

const server = (): FakeCalDav => {
  const current = fake.get();
  if (!current) throw new Error("No fake CalDAV server is running.");
  return current;
};

const sourceFor = (appPassword = server().appPassword): CalendarSource =>
  createCalendarSource({ appleId: server().appleId, appPassword, serverUrl: server().serverUrl });

const value = <Value>(result: Result<Value, string>): Value => {
  if (!result.ok) throw new Error(result.failure);
  return result.value;
};

const at = <Item>(items: readonly Item[], index: number): Item => {
  const item = items[index];
  if (item === undefined) throw new Error(`Nothing at ${String(index)} of ${String(items.length)}.`);
  return item;
};

const unfolded = (ics = ""): string => ics.replaceAll(/\r?\n[ \t]/gu, "");

const homeOf = async (source: CalendarSource): Promise<CalendarInfo> =>
  at(
    value(await source.calendars()).filter(({ name }) => name === "Home"),
    0,
  );

const calendarFile = (...lines: readonly string[]): string =>
  ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Example//Planner//EN", ...lines, "END:VCALENDAR", ""].join("\r\n");

const newYork = [
  "BEGIN:VTIMEZONE",
  "TZID:America/New_York",
  "BEGIN:DAYLIGHT",
  "TZOFFSETFROM:-0500",
  "TZOFFSETTO:-0400",
  "TZNAME:EDT",
  "DTSTART:20070311T020000",
  "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU",
  "END:DAYLIGHT",
  "BEGIN:STANDARD",
  "TZOFFSETFROM:-0400",
  "TZOFFSETTO:-0500",
  "TZNAME:EST",
  "DTSTART:20071104T020000",
  "RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU",
  "END:STANDARD",
  "END:VTIMEZONE",
];

const london = [
  "BEGIN:VTIMEZONE",
  "TZID:Europe/London",
  "BEGIN:DAYLIGHT",
  "TZOFFSETFROM:+0000",
  "TZOFFSETTO:+0100",
  "TZNAME:BST",
  "DTSTART:19810329T010000",
  "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU",
  "END:DAYLIGHT",
  "BEGIN:STANDARD",
  "TZOFFSETFROM:+0100",
  "TZOFFSETTO:+0000",
  "TZNAME:GMT",
  "DTSTART:19961027T020000",
  "RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU",
  "END:STANDARD",
  "END:VTIMEZONE",
];

const invite = calendarFile(
  ...newYork,
  "BEGIN:VEVENT",
  "UID:plans-review@example.com",
  "DTSTAMP:20261030T120000Z",
  "DTSTART;TZID=America/New_York:20261117T100000",
  "DTEND;TZID=America/New_York:20261117T110000",
  "SUMMARY:Plans review",
  "STATUS:CONFIRMED",
  "ORGANIZER;CN=Ari:mailto:ari@example.com",
  "ATTENDEE;CN=Ari;PARTSTAT=ACCEPTED:mailto:ari@example.com",
  "ATTENDEE;CN=Divy;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:divy@me.com",
  "ATTENDEE;CN=Sam;PARTSTAT=TENTATIVE:mailto:sam@example.com",
  "END:VEVENT",
);

const standup = calendarFile(
  ...london,
  "BEGIN:VEVENT",
  "UID:standup@example.com",
  "DTSTAMP:20261001T080000Z",
  "DTSTART;TZID=Europe/London:20261019T090000",
  "DTEND;TZID=Europe/London:20261019T093000",
  "RRULE:FREQ=WEEKLY;COUNT=4",
  "SUMMARY:Standup",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:standup@example.com",
  "DTSTAMP:20261001T080000Z",
  "RECURRENCE-ID;TZID=Europe/London:20261102T090000",
  "DTSTART;TZID=Europe/London:20261102T110000",
  "DTEND;TZID=Europe/London:20261102T113000",
  "SUMMARY:Standup (moved)",
  "END:VEVENT",
);

describe("iCloud calendars over CalDAV", () => {
  beforeEach(async () => {
    fake.set(await startFakeCalDav());
  });

  afterEach(async () => {
    await server().close();
    fake.set(undefined);
  });

  it("turns a wrong password away in plain words and lists the event calendars", async () => {
    expect(await sourceFor("wrong-pass-word").check()).toEqual({
      ok: false,
      failure: "iCloud rejected that Apple ID or app-specific password.",
    });
    expect(await sourceFor().check()).toEqual({
      ok: true,
      value: {
        calendars: [
          { url: server().calendarUrl("Home"), name: "Home", isKumo: false, readOnly: false },
          { url: server().calendarUrl("Family"), name: "Family", isKumo: false, readOnly: true },
        ],
      },
    });
  });

  it("makes the Kumo calendar once", async () => {
    const source = sourceFor();
    const kumo = value(await source.ensureKumo());

    expect(value(await source.ensureKumo())).toEqual(kumo);
    expect(kumo).toMatchObject({ name: "Kumo", isKumo: true, readOnly: false });
    expect(
      server()
        .calendarNames()
        .filter((name) => name === "Kumo"),
    ).toHaveLength(1);
    expect(value(await source.calendars()).map(({ name }) => name)).toEqual(["Home", "Family", "Kumo"]);
  });

  it("creates a timed and an all-day event and reads them back", async () => {
    const source = sourceFor();
    const kumo = value(await source.ensureKumo());
    const lunch = value(
      await source.create(kumo, {
        title: "Lunch with Ari, then plans; bring sketches",
        start: "2026-11-13T14:00:00+01:00",
        end: "2026-11-13T15:30:00+01:00",
        location: "Café Kumo, Lisbon",
        notes: "Table by the window.\nAsk about the trip.",
      }),
    );
    const trip = value(await source.create(kumo, { title: "Porto trip", start: "2026-11-20", end: "2026-11-22" }));

    expect(lunch).toMatchObject({
      calendar: kumo,
      title: "Lunch with Ari, then plans; bring sketches",
      start: "2026-11-13T13:00:00.000Z",
      end: "2026-11-13T14:30:00.000Z",
      allDay: false,
      location: "Café Kumo, Lisbon",
      notes: "Table by the window.\nAsk about the trip.",
      attendees: [],
    });
    expect(trip).toMatchObject({ title: "Porto trip", start: "2026-11-20", end: "2026-11-22", allDay: true });
    expect(unfolded(server().stored(lunch.url))).toContain("SUMMARY:Lunch with Ari\\, then plans\\; bring sketches");
    expect(unfolded(server().stored(trip.url))).toContain("DTSTART;VALUE=DATE:20261120");
    expect(unfolded(server().stored(trip.url))).toContain("DTEND;VALUE=DATE:20261123");
    expect(value(await source.events(...november))).toEqual([lunch, trip]);
    expect(value(await source.events("2026-11-14T00:00:00Z", "2026-11-21T00:00:00Z"))).toEqual([trip]);
  });

  it("updates and removes an event, guarded by its etag", async () => {
    const source = sourceFor();
    const call = value(
      await source.create(await homeOf(source), {
        title: "Call with Sam",
        start: "2026-11-16T10:00:00Z",
        end: "2026-11-16T10:30:00Z",
      }),
    );
    const moved = value(await source.update(call, { title: "Call with Sam and Ari", start: "2026-11-16T15:00:00Z" }));
    const changedSince = { ok: false, failure: "That event changed in iCloud since it was read; read it again first." };

    expect(moved).toMatchObject({
      title: "Call with Sam and Ari",
      start: "2026-11-16T15:00:00.000Z",
      end: "2026-11-16T15:30:00.000Z",
    });
    expect(moved.etag).not.toBe(call.etag);
    expect(await source.update(call, { title: "Stale" })).toEqual(changedSince);
    expect(await source.remove(call)).toEqual(changedSince);
    expect(await source.remove(moved)).toEqual({ ok: true, value: undefined });
    expect(value(await source.events(...november))).toEqual([]);
  });

  it("answers an invite by setting my PARTSTAT on it", async () => {
    const source = sourceFor();
    const url = server().seed("Home", "plans-review.ics", invite);
    const events = value(await source.events(...november));

    expect(events).toHaveLength(1);
    const review = at(events, 0);
    expect(review).toMatchObject({
      url,
      title: "Plans review",
      start: "2026-11-17T15:00:00.000Z",
      end: "2026-11-17T16:00:00.000Z",
      status: "confirmed",
      organizer: { email: "ari@example.com", name: "Ari" },
      myStatus: "needs-action",
    });

    const answered = value(await source.respond(review, "accepted"));

    expect(answered.myStatus).toBe("accepted");
    expect(answered.attendees).toEqual([
      { email: "ari@example.com", name: "Ari", partstat: "accepted" },
      { email: "divy@me.com", name: "Divy", partstat: "accepted" },
      { email: "sam@example.com", name: "Sam", partstat: "tentative" },
    ]);
    expect(unfolded(server().stored(url))).toContain("PARTSTAT=ACCEPTED;RSVP=TRUE:mailto:divy@me.com");
  });

  it("expands a weekly series across the clocks going back, and edits or drops one occurrence", async () => {
    const source = sourceFor();
    const url = server().seed("Home", "standup.ics", standup);
    const autumn = ["2026-10-01T00:00:00Z", "2026-12-01T00:00:00Z"] as const;
    const summary = async (): Promise<readonly (readonly string[])[]> =>
      value(await source.events(...autumn)).map(({ title, start, recurrenceId = "" }) => [title, start, recurrenceId]);
    const occurrence = async (index: number): Promise<CalendarEvent> =>
      at(value(await source.events(...autumn)), index);

    expect(await summary()).toEqual([
      ["Standup", "2026-10-19T08:00:00.000Z", "2026-10-19T08:00:00.000Z"],
      ["Standup", "2026-10-26T09:00:00.000Z", "2026-10-26T09:00:00.000Z"],
      ["Standup (moved)", "2026-11-02T11:00:00.000Z", "2026-11-02T09:00:00.000Z"],
      ["Standup", "2026-11-09T09:00:00.000Z", "2026-11-09T09:00:00.000Z"],
    ]);

    value(await source.remove(await occurrence(1)));
    const longer = value(
      await source.update(await occurrence(2), {
        title: "Standup, longer",
        end: "2026-11-09T10:00:00Z",
      }),
    );

    expect(longer).toMatchObject({
      title: "Standup, longer",
      start: "2026-11-09T09:00:00.000Z",
      end: "2026-11-09T10:00:00.000Z",
    });
    expect(unfolded(server().stored(url))).toContain("EXDATE;TZID=Europe/London:20261026T090000");
    expect(await summary()).toEqual([
      ["Standup", "2026-10-19T08:00:00.000Z", "2026-10-19T08:00:00.000Z"],
      ["Standup (moved)", "2026-11-02T11:00:00.000Z", "2026-11-02T09:00:00.000Z"],
      ["Standup, longer", "2026-11-09T09:00:00.000Z", "2026-11-09T09:00:00.000Z"],
    ]);
  });

  it("reports what changed and what went since a token", async () => {
    const source = sourceFor();
    const home = await homeOf(source);
    const kept = value(await source.create(home, { title: "Gym", start: "2026-11-18", end: "2026-11-18" }));
    const doomed = value(await source.create(home, { title: "Dentist", start: "2026-11-19", end: "2026-11-19" }));
    const first = value(await source.changes());

    expect(first).toMatchObject({ changed: [], removed: [] });

    const added = value(await source.create(home, { title: "Haircut", start: "2026-11-20", end: "2026-11-20" }));
    const renamed = value(await source.update(kept, { title: "Gym with Sam" }));
    value(await source.remove(doomed));
    const second = value(await source.changes(first.token));

    expect(second.changed.toSorted((one, other) => one.title.localeCompare(other.title))).toEqual([renamed, added]);
    expect(second.removed).toEqual([doomed.url]);
    expect(value(await source.changes(second.token))).toMatchObject({ changed: [], removed: [] });
    expect(await source.changes("not a token")).toEqual({
      ok: false,
      failure: "That changes token isn't one this calendar source gave out.",
    });
  });
});
