export type RestartDecision = { readonly giveUp: true } | { readonly giveUp: false; readonly delayMs: number };

export const crashWindowMs = 10 * 60 * 1000;

const crashesBeforeGivingUp = 5;
const firstDelayMs = 1000;
const longestDelayMs = 5 * 60 * 1000;

export const recentCrashes = (crashes: readonly number[], now: number): readonly number[] =>
  crashes.filter((at) => now - at < crashWindowMs);

export const toRestartDecision = (recent: readonly number[]): RestartDecision =>
  recent.length >= crashesBeforeGivingUp
    ? { giveUp: true }
    : { giveUp: false, delayMs: Math.min(firstDelayMs * 2 ** Math.max(recent.length - 1, 0), longestDelayMs) };
