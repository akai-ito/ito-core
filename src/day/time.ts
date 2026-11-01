import { dayMs, minuteMs, toLocal } from "#desk/day.ts";

export const hourMs = 60 * minuteMs;

const dayIndex = (day: string): number => Date.parse(`${day}T00:00:00.000Z`) / dayMs;

// The instant the local clock shows `minutes` after midnight on `day`, such as `2026-11-05`.
export const atLocal = (day: string, minutes: number, timeZone: string): number => {
  const wanted = dayIndex(day) * 24 * 60 + minutes;
  const corrected = (guess: number): number => {
    const local = toLocal(guess, timeZone);
    return guess + (wanted - (dayIndex(local.day) * 24 * 60 + local.minutes)) * minuteMs;
  };
  // Twice, so a guess that lands across a change of offset settles.
  return corrected(corrected(wanted * minuteMs));
};

// The day after `day`.
export const nextDay = (day: string): string => new Date((dayIndex(day) + 1) * dayMs).toISOString().slice(0, 10);

// `07:45`, local.
export const clockOf = (at: number, timeZone: string): string =>
  new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(at);

// "Tue", local.
export const weekdayOf = (at: number, timeZone: string): string =>
  new Intl.DateTimeFormat("en-GB", { timeZone, weekday: "short" }).format(at);

// A late-night time as you'd say it: `01:00` is "1", `00:30` "12:30", `23:15` "11:15".
export const spokenTime = (time: string): string => {
  const [hours = 0, minutes = 0] = time.split(":", 2).map(Number);
  const hour = hours % 12 === 0 ? 12 : hours % 12;
  return minutes === 0 ? String(hour) : `${String(hour)}:${String(minutes).padStart(2, "0")}`;
};

// `01:00` from minutes after midnight.
export const toClock = (minutes: number): string => {
  const wrapped = ((minutes % (24 * 60)) + 24 * 60) % (24 * 60);
  return `${String(Math.floor(wrapped / 60)).padStart(2, "0")}:${String(wrapped % 60).padStart(2, "0")}`;
};

export const isClock = (text: string): boolean => /^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(text);

// How long ago, in plain words: "40 minutes", "2 hours".
export const lengthOf = (milliseconds: number): string => {
  const minutes = Math.max(1, Math.round(milliseconds / minuteMs));
  if (minutes < 90) return `${String(minutes)} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.round((minutes / 60) * 2) / 2;
  return `${String(hours)} hours`;
};
