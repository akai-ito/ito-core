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

// When the local day began, as an instant.
export const startOfDay = (now: number, timeZone: string): number =>
  now - toLocal(now, timeZone).minutes * minuteMs - (now % minuteMs);

// `07:30` as minutes after midnight.
export const toMinutes = (time: string): number => {
  const [hours = "7", minutes = "30"] = time.split(":", 2);
  return Number(hours) * 60 + Number(minutes);
};

// How long until the next time the local clock shows `target` minutes after midnight.
export const untilMinutes = (now: number, timeZone: string, target: number): number => {
  const local = toLocal(now, timeZone);
  const delay = (target - local.minutes) * minuteMs - (now % minuteMs);
  return delay > 0 ? delay : delay + dayMs;
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
