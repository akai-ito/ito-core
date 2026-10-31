export type Level = "passive" | "active" | "time-sensitive";

export type Moment = {
  readonly wanted: Level;
  readonly now: number;
  readonly lastSounded: number | undefined;
  readonly localHour: number;
  readonly isBusy: boolean;
};

const hourMs = 60 * 60 * 1000;

export const isOvernight = (localHour: number): boolean => localHour >= 22 || localHour < 7;

export const toLevel = ({ wanted, now, lastSounded, localHour, isBusy }: Moment): Level => {
  if (wanted !== "active") return wanted;
  const hasSoundedLately = lastSounded !== undefined && now - lastSounded < hourMs;
  return hasSoundedLately || isBusy || isOvernight(localHour) ? "passive" : "active";
};

export const localHourOf = (now: number, timeZone: string): number =>
  Number(new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", hourCycle: "h23" }).format(now));
