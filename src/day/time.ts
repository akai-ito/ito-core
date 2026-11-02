import { minuteMs } from "#desk/day.ts";

export { atLocal, nextDay } from "#desk/day.ts";

export const hourMs = 60 * minuteMs;

// `07:45`, local.
export const clockOf = (at: number, timeZone: string): string =>
  new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(at);

// "Tue", local.
export const weekdayOf = (at: number, timeZone: string): string =>
  new Intl.DateTimeFormat("en-GB", { timeZone, weekday: "short" }).format(at);
