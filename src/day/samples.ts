import { toTimestamp } from "#clock.ts";
import { atLocal, hourMs, nextDay } from "#day/time.ts";
import { toLocal } from "#desk/day.ts";
import type { Identifiers } from "#identifiers.ts";
import type { CalendarItem, Guess } from "#protocol/types.ts";

const kumo = { name: "Kumo", kumo: true };

const home = { name: "Home", kumo: false };

// A made-up weekday for the demo: Kumo's plan and its guesses today, and two of your own events tomorrow, so Coming
// up shows the whole picture without a calendar.
export const sampleDay = (now: number, timeZone: string, identifiers: Identifiers): readonly CalendarItem[] => {
  const today = toLocal(now, timeZone).day;
  const tomorrow = nextDay(today);
  const item = (
    day: string,
    title: string,
    at: string,
    hours: number,
    extra: Partial<CalendarItem> = {},
  ): CalendarItem => {
    const [hour = 0, minute = 0] = at.split(":", 2).map(Number);
    const start = atLocal(day, hour * 60 + minute, timeZone);
    return {
      id: identifiers.calendarItem(),
      uid: `demo-${String(start)}-${title.toLowerCase().replaceAll(/\W+/gu, "-")}`,
      title,
      start: toTimestamp(start),
      end: toTimestamp(start + hours * hourMs),
      all_day: false,
      calendar: kumo,
      status: "confirmed",
      ...extra,
    };
  };
  const guess = (activity: Guess["activity"], why: string): Partial<CalendarItem> => ({ guess: { activity, why } });
  return [
    item(today, "Easy run, week 1 of 6", "07:30", 0.5),
    item(today, "Working", "09:00", 3, guess("working", "Your usual weekday at the desk, from the last four weeks.")),
    item(today, "Prep: Northwind, 1h", "12:00", 1),
    item(today, "Proper lunch", "13:00", 0.5),
    item(today, "Working", "15:00", 3, guess("working", "You're usually heads-down after lunch on weekdays.")),
    item(
      today,
      "Building",
      "19:30",
      2,
      guess("building", "Most weeknights this month you've been building after dinner."),
    ),
    item(today, "Chilling", "21:30", 1.75, guess("chilling", "After building you usually switch off.")),
    item(today, "Wind down", "23:15", 0.75),
    item(tomorrow, "Dentist", "09:00", 0.5, { calendar: home, location: "Quillfield Dental" }),
    item(tomorrow, "Northwind intro call", "14:00", 1, { calendar: home, location: "Teams" }),
    item(tomorrow, "Seeing people", "19:00", 3, guess("people", "Most weeks you see friends on this evening.")),
  ];
};
