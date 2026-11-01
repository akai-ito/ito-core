import { toTimestamp } from "#clock.ts";
import { minuteMs, toLocal } from "#desk/day.ts";
import { atLocal, clockOf, nextDay, spokenTime, weekdayOf } from "#day/time.ts";
import type { Settings } from "#store/store.ts";

export type Stage = "pre" | "past" | "later";

// One evening and the night after it, named by the evening's date: whether they meant to build, when they said
// they'd stop and what came next, what Kumo said when, and the last sign of them.
export type Night = {
  readonly night: string;
  readonly asked?: string;
  readonly building?: boolean;
  readonly stop?: string;
  readonly nextStep?: string;
  readonly lines?: Readonly<Partial<Record<Stage, string>>>;
  readonly snoozedTo?: string;
  readonly stoppedAt?: string;
  readonly lastActive?: string;
  readonly gaveUp?: readonly string[];
};

export type Nights = {
  // The night it is at an instant: before midday, it's still the night of the evening before.
  readonly nightOf: (at: number) => string;
  readonly get: (night: string) => Night | undefined;
  readonly change: (night: string, change: (current: Night) => Night) => Night;
  // Newest first.
  readonly recent: (count: number) => readonly Night[];
  // A sign of them, such as a message or opening Ito: late in the evening it also marks the night.
  readonly touch: (at: number) => void;
  readonly lastActive: () => number | undefined;
  // When the local clock next shows `stop` after the evening of `night`.
  readonly stopAt: (night: string, stop: string) => number;
  // Their last few nights, for a prompt.
  readonly lately: (now: number) => readonly string[];
};

export const nightsSetting = "day_nights";

export const lastActiveSetting = "day_last_active";

const kept = 28;
const middayMinutes = 12 * 60;
const eveningMinutes = 21 * 60;
const morningMinutes = 6 * 60;

export const createNights = (settings: Settings, timeZone: string): Nights => {
  const all = (): readonly Night[] => {
    const saved = settings.setting(nightsSetting);
    return saved === undefined ? [] : (JSON.parse(saved) as readonly Night[]);
  };

  const nightOf = (at: number): string => {
    const local = toLocal(at, timeZone);
    return local.minutes >= middayMinutes
      ? local.day
      : toLocal(atLocal(local.day, 0, timeZone) - minuteMs, timeZone).day;
  };

  const get = (night: string): Night | undefined => all().find((entry) => entry.night === night);

  const change = (night: string, given: (current: Night) => Night): Night => {
    const changed = given(get(night) ?? { night });
    const others = all().filter((entry) => entry.night !== night);
    const sorted = [...others, changed].toSorted((left, right) => right.night.localeCompare(left.night));
    settings.setSetting(nightsSetting, JSON.stringify(sorted.slice(0, kept)));
    return changed;
  };

  const stopAt = (night: string, stop: string): number => {
    const [hours = 0, minutes = 0] = stop.split(":", 2).map(Number);
    const total = hours * 60 + minutes;
    return atLocal(total < middayMinutes ? nextDay(night) : night, total, timeZone);
  };

  const lastActive = (): number | undefined => {
    const saved = settings.setting(lastActiveSetting);
    return saved === undefined ? undefined : Date.parse(saved);
  };

  return {
    nightOf,
    get,
    change,
    recent: (count) => all().slice(0, count),
    touch: (at) => {
      const known = lastActive();
      if (known !== undefined && known >= at) return;
      settings.setSetting(lastActiveSetting, toTimestamp(at));
      const { minutes } = toLocal(at, timeZone);
      if (minutes >= eveningMinutes || minutes < morningMinutes) {
        change(nightOf(at), (current) => ({ ...current, lastActive: toTimestamp(at) }));
      }
    },
    lastActive,
    stopAt,
    lately: (now) =>
      all()
        .filter((entry) => entry.night < nightOf(now) || entry.night === nightOf(now))
        .slice(0, 7)
        .flatMap((entry) => {
          const day = weekdayOf(atLocal(entry.night, middayMinutes, timeZone), timeZone);
          const said = entry.stop === undefined ? "" : `, against the ${spokenTime(entry.stop)} they set`;
          const last = entry.lastActive === undefined ? undefined : Date.parse(entry.lastActive);
          const late =
            last !== undefined && toLocal(last, timeZone).minutes < morningMinutes
              ? `${day}: up until ${clockOf(last, timeZone)}${said}`
              : undefined;
          const notBuilding = entry.building === false ? `${day}: said they weren't building` : undefined;
          return [late ?? notBuilding ?? []].flat();
        }),
  };
};
