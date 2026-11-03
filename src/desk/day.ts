export type Local = { readonly day: string; readonly minutes: number };

export const minuteMs = 60 * 1000;

export const dayMs = 24 * 60 * minuteMs;

// The local day, as `2026-11-05`, and the minutes since its midnight.
export const toLocal = (now: number, timeZone: string): Local => {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(now)
      .map(({ type, value }) => [type, value]),
  );
  return {
    day: `${String(parts.year)}-${String(parts.month)}-${String(parts.day)}`,
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
  };
};

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

// When the local day began, as an instant: its midnight, whatever the change of clock that day.
export const startOfDay = (now: number, timeZone: string): number => atLocal(toLocal(now, timeZone).day, 0, timeZone);

// How long until the next time the local clock shows `target` minutes after midnight.
export const untilMinutes = (now: number, timeZone: string, target: number): number => {
  const { day } = toLocal(now, timeZone);
  const today = atLocal(day, target, timeZone);
  return (today > now ? today : atLocal(nextDay(day), target, timeZone)) - now;
};

// "Thursday 5 November, 15:20", for a prompt.
export const toSpoken = (now: number, timeZone: string): string =>
  new Intl.DateTimeFormat("en-GB", {
    timeZone,
    weekday: "long",
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(now);
