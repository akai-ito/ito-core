export type Cancel = () => void;

export type Clock = {
  readonly now: () => number;
  readonly after: (delayMs: number, callback: () => void) => Cancel;
};

export const systemClock: Clock = {
  now: () => Date.now(),
  after: (delayMs, callback) => {
    const timer = setTimeout(callback, delayMs);
    return () => {
      clearTimeout(timer);
    };
  },
};

export const toTimestamp = (milliseconds: number): string => new Date(milliseconds).toISOString();
