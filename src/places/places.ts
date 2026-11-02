import { createCell } from "#cell.ts";
import { toTimestamp, type Cancel, type Clock } from "#clock.ts";
import type { Fetch } from "#capabilities/connect.ts";
import type { Ambient, Area, Whereabouts } from "#protocol/types.ts";
import { fail, ok, type Result } from "#result.ts";
import type { Settings } from "#store/store.ts";
import { fieldOf } from "#tools/input.ts";
import type { Info } from "#turns/turns.ts";

// Where they roughly are, as their phone says: the time zone Kumo lives by, and a place rounded to about 10 km for
// the weather on the Desk. Only the latest report is kept, from any device.
export type Places = {
  // The time zone Kumo lives by now: the latest a phone said, or the box's own.
  readonly timeZone: () => string;
  readonly report: (device: string, given: Whereabouts) => Result<undefined, string>;
  // What's kept, for Settings.
  readonly held: () => Held | undefined;
  // The weather where they are, for Kumo's sense of now.
  readonly weatherText: () => string | undefined;
  // Their phone moved from one time zone to another.
  readonly onMoved: (listener: (from: string, to: string) => void) => void;
  readonly close: () => void;
};

export type Held = { readonly time_zone: string; readonly area?: Area; readonly as_of: string };

export type PlacesOptions = {
  readonly settings: Settings;
  readonly clock: Clock;
  // The box's own time zone, until a phone says.
  readonly fallback: string;
  readonly fetch: Fetch;
  readonly setAmbient: (ambient: Ambient | undefined) => void;
  readonly info: Info;
};

export const whereaboutsSetting = "whereabouts";

// About 11 km of latitude: a town, never a street.
const precision = 10;
export const weatherEveryMs = 30 * 60 * 1000;
// A reading older than this is no longer the weather around them.
const staleMs = 2 * 60 * 60 * 1000;

type Reading = { readonly ambient: Ambient; readonly at: number };

const conditionOf = (code: number): Ambient["condition"] => {
  if (code === 0) return "clear";
  if (code <= 2) return "partly_cloudy";
  if (code === 3) return "cloudy";
  if (code === 45 || code === 48) return "fog";
  if (code >= 51 && code <= 57) return "drizzle";
  if ((code >= 61 && code <= 67) || (code >= 80 && code <= 82)) return "rain";
  if (code === 85 || code === 86 || (code >= 71 && code <= 77)) return "snow";
  return code >= 95 ? "thunder" : "cloudy";
};

const conditionWords: Readonly<Record<Ambient["condition"], string>> = {
  clear: "clear",
  partly_cloudy: "partly cloudy",
  cloudy: "cloudy",
  fog: "foggy",
  drizzle: "drizzling",
  rain: "raining",
  snow: "snowing",
  thunder: "thundery",
};

export const isTimeZone = (name: string): boolean => {
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: name }).format(0);
    return name.includes("/") || name === "UTC";
  } catch {
    return false;
  }
};

const rounded = (value: number): number => Math.round(value * precision) / precision;

// Open-Meteo's forecast for a place: the weather now and today's sunset, in its own local time.
export const weatherUrl = ({ latitude, longitude }: Area): string =>
  "https://api.open-meteo.com/v1/forecast" +
  `?latitude=${latitude.toFixed(1)}&longitude=${longitude.toFixed(1)}` +
  "&current=temperature_2m,weather_code,is_day&daily=sunset&timezone=auto&forecast_days=1";

const numberAt = (value: unknown, ...path: readonly string[]): number | undefined => {
  const found = path.reduce<unknown>(
    (current, key) => (current && typeof current === "object" ? Reflect.get(current, key) : undefined),
    value,
  );
  return typeof found === "number" && Number.isFinite(found) ? found : undefined;
};

const toAmbient = (body: unknown, place: string | undefined): Ambient | undefined => {
  const temperature = numberAt(body, "current", "temperature_2m");
  const code = numberAt(body, "current", "weather_code");
  const isDay = numberAt(body, "current", "is_day");
  const offset = numberAt(body, "utc_offset_seconds");
  const sunsets: unknown = fieldOf(fieldOf(body, "daily"), "sunset");
  const [sunsetText] = Array.isArray(sunsets) ? (sunsets as readonly unknown[]) : [];
  const sunset = typeof sunsetText === "string" ? Date.parse(`${sunsetText}:00.000Z`) : NaN;
  if (temperature === undefined || code === undefined || offset === undefined || Number.isNaN(sunset)) return undefined;
  return {
    temperature: Math.round(temperature),
    condition: conditionOf(code),
    is_day: isDay === 1,
    sunset: toTimestamp(sunset - offset * 1000),
    ...(place !== undefined && { place }),
  };
};

export const createPlaces = ({ settings, clock, fallback, fetch, setAmbient, info }: PlacesOptions): Places => {
  const reading = createCell<Reading | undefined>(undefined);
  const timer = createCell<Cancel | undefined>(undefined);
  const movedListeners = createCell<readonly ((from: string, to: string) => void)[]>([]);
  const isClosed = createCell(false);

  const held = (): Held | undefined => {
    const saved = settings.setting(whereaboutsSetting);
    return saved === undefined ? undefined : (JSON.parse(saved) as Held);
  };

  const timeZone = (): string => held()?.time_zone ?? fallback;

  const show = (next: Reading | undefined): void => {
    reading.set(next);
    setAmbient(next?.ambient);
  };

  const readWeather = async (): Promise<void> => {
    const area = held()?.area;
    if (!area) {
      show(undefined);
      return;
    }
    try {
      const response = await fetch(weatherUrl(area), { signal: AbortSignal.timeout(10_000) });
      const ambient = response.ok ? toAmbient((await response.json()) as unknown, area.name) : undefined;
      if (isClosed.get()) return;
      if (ambient) {
        show({ ambient, at: clock.now() });
        return;
      }
      info("The weather couldn't be read", { reason: `Open-Meteo answered ${String(response.status)}` });
    } catch (error) {
      info("The weather couldn't be read", { error: String(error) });
    }
    const last = reading.get();
    if (last && clock.now() - last.at > staleMs) show(undefined);
  };

  const schedule = (): void => {
    timer.get()?.();
    if (isClosed.get() || held()?.area === undefined) return;
    timer.set(
      clock.after(weatherEveryMs, () => {
        void readWeather().then(schedule);
      }),
    );
  };

  const report = (_device: string, { time_zone: zone, area }: Whereabouts): Result<undefined, string> => {
    if (!isTimeZone(zone)) return fail(`${zone} isn't a time zone, such as Europe/Rome.`);
    const before = held();
    const kept: Held = {
      time_zone: zone,
      ...(area && {
        area: {
          latitude: rounded(area.latitude),
          longitude: rounded(area.longitude),
          ...(area.name !== undefined && area.name.trim() !== "" && { name: area.name.trim() }),
        },
      }),
      as_of: toTimestamp(clock.now()),
    };
    settings.setSetting(whereaboutsSetting, JSON.stringify(kept));
    if (before !== undefined && before.time_zone !== zone) {
      info("Their time zone changed", { from: before.time_zone, to: zone });
      for (const listener of movedListeners.get()) listener(before.time_zone, zone);
    }
    if (JSON.stringify(before?.area) !== JSON.stringify(kept.area)) {
      void readWeather();
      schedule();
    }
    return ok(undefined);
  };

  if (held()?.area !== undefined) {
    void readWeather();
    schedule();
  }

  return {
    timeZone,
    report,
    held,
    weatherText: () => {
      const ambient = reading.get()?.ambient;
      if (!ambient) return;
      const sunset = new Intl.DateTimeFormat("en-GB", {
        timeZone: timeZone(),
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      }).format(Date.parse(ambient.sunset));
      const where = ambient.place === undefined ? "" : ` in ${ambient.place}`;
      return `It's ${String(ambient.temperature)}°C and ${conditionWords[ambient.condition]}${where}; sunset ${sunset}.`;
    },
    onMoved: (listener) => {
      movedListeners.update((current) => [...current, listener]);
    },
    close: () => {
      isClosed.set(true);
      timer.get()?.();
    },
  };
};
