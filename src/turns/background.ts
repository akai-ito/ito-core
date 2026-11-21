import { randomUUID } from "node:crypto";
import { createCell } from "#cell.ts";
import { toTimestamp, type Cancel, type Clock } from "#clock.ts";
import { pausedDetail, restartedDetail, type Engine, type WorkFailure } from "#engine/engine.ts";
import type { Health } from "#problems/problems.ts";
import type { ModelChoice, WakeUp } from "#protocol/types.ts";
import { fail, ok, type Result } from "#result.ts";
import type { Settings } from "#store/store.ts";
import type { Info } from "#turns/turns.ts";

// Kumo's work in the background, with nobody watching it. Unlike a turn in the chat, where the person has Stop, it
// gets a backstop: work that shows no sign of life for a long while is stopped and tried once more. When the model
// provider's usage limit is reached, background work pauses until the limit resets, visibly, with no retries in
// between; then Kumo catches up once on what it missed and says so in one message.
export type Background = {
  // One piece of background work, under the run given or a new one. `missed` says what it is in a line, such as
  // "New mail they got or sent", for the catch-up if Kumo's paused; the same line counts once.
  readonly work: (prompt: string, options?: BackgroundWork) => Promise<Result<string, string>>;
  // A run used one of Ito's tools, so one cut off by a restart isn't tried again blind.
  readonly touch: (run: string) => void;
  // A usage limit reached outside background work, such as by a turn in the chat.
  readonly limitReached: () => void;
  // The model answered, such as a turn in the chat completing: a pause is over, and Kumo catches up now.
  readonly answered: () => void;
  // Whether wake-ups that come due wait for the catch-up instead of running.
  readonly isHolding: () => boolean;
  readonly paused: () => Pause | undefined;
  readonly close: () => void;
};

export type BackgroundWork = { readonly run?: string; readonly choice?: ModelChoice; readonly missed?: string };

export type Pause = {
  readonly since: number;
  readonly until: number;
  // Whether the provider said when its limit resets; when it didn't, Kumo looks again after an hour.
  readonly isKnown: boolean;
};

// The wake-ups that wait through a pause, for the catch-up.
export type HeldWakeUps = {
  readonly overdue: () => readonly WakeUp[];
  readonly describe: (wakeUp: WakeUp) => string;
  // The catch-up looked at them in a run: each repeating one comes back at its next time, the rest go.
  readonly caughtUp: (wakeUps: readonly WakeUp[], run: string) => void;
  // Back to running each one when it comes due, including any that came due during the catch-up.
  readonly resume: () => void;
};

export type BackgroundOptions = {
  readonly engine: Pick<Engine, "work" | "usageResetsAt">;
  readonly clock: Clock;
  readonly settings: Settings;
  readonly info: Info;
  readonly timeZone: () => string;
  // Waits until the server can take Kumo's tool calls.
  readonly ready: () => Promise<void>;
  // What a piece of work starts with: the rules for working in the background and what's in Kumo's mind.
  readonly frame: (prompt: string) => string;
  readonly wakeUps: () => HeldWakeUps;
  // The one message the catch-up ends with.
  readonly post: (text: string) => void;
  // How background work stands, for the problem when it can't go on.
  readonly report: (health: Health) => void;
  // The pause began, moved or ended.
  readonly onPause: () => void;
  readonly silenceMs?: number;
  readonly unknownResetMs?: number;
  readonly retryMs?: number;
};

export const pauseSetting = "background_pause";

// Generous: long enough for a long document written in one tool call, which shows nothing while it's written.
export const silenceMs = 15 * 60 * 1000;

// When the provider doesn't say when its limit resets: an hour, then one look.
export const unknownResetMs = 60 * 60 * 1000;

// A catch-up the model didn't answer, for another reason than the limit, waits as a wake-up would.
const catchUpRetryMs = 15 * 60 * 1000;

const longestTimerMs = 2 ** 31 - 1;

type State =
  | { readonly kind: "working" }
  | { readonly kind: "paused"; readonly pause: Pause; readonly missed: readonly string[] }
  | { readonly kind: "catching_up"; readonly since: number; readonly missed: readonly string[] };

type Saved = {
  readonly since: number;
  readonly until: number;
  readonly isKnown: boolean;
  readonly missed: readonly string[];
};

const silentDetail = (silence: number): string =>
  `The model showed no sign of life for ${String(Math.round(silence / 60_000))} minutes, so the work was stopped.`;

const retryNote =
  "(An earlier try at this went quiet for a long while and was stopped. It may have done part of it already: look " +
  "before you act again.)";

const withMissed = (missed: readonly string[], line: string | undefined): readonly string[] =>
  line === undefined || missed.includes(line) ? missed : [...missed, line];

const toSaved = (state: State): Saved | undefined => {
  switch (state.kind) {
    case "working": {
      return undefined;
    }
    case "paused": {
      return { ...state.pause, missed: state.missed };
    }
    // A catch-up cut off by a restart runs again as soon as the server's back.
    case "catching_up": {
      return { since: state.since, until: state.since, isKnown: true, missed: state.missed };
    }
  }
};

const fromSaved = (text: string | undefined): State => {
  if (text === undefined || text === "") return { kind: "working" };
  const { since, until, isKnown, missed } = JSON.parse(text) as Saved;
  return { kind: "paused", pause: { since, until, isKnown }, missed };
};

// A time where they are: "21:37" today, "Sat 22 Nov, 09:00" on another day.
export const whenWords = (at: number, now: number, timeZone: string): string => {
  const day = (time: number): string => new Intl.DateTimeFormat("en-CA", { timeZone }).format(time);
  const clock = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  if (day(at) === day(now)) return clock.format(at);
  const date = new Intl.DateTimeFormat("en-GB", { timeZone, weekday: "short", day: "numeric", month: "short" });
  return `${date.format(at)}, ${clock.format(at)}`;
};

const catchUpPrompt = (since: string, wakeUps: readonly string[], missed: readonly string[]): string =>
  [
    `You were paused from ${since} until now: their plan's usage limit was reached, so nothing in the background ran.`,
    "Catch up now, once, on what you missed.",
    ...(wakeUps.length === 0
      ? []
      : [
          "",
          "Your wake-ups that came due meanwhile, each once however often it came round:",
          ...wakeUps,
          "For each, look first at what's changed. Do now what's still worth doing; drop with drop_wake_up what's moot",
          "or too late, and move with move_wake_up what a later time fits better. A repeating one comes back by itself.",
        ]),
    ...(missed.length === 0
      ? []
      : [
          "",
          `What couldn't run meanwhile; look at each with your tools as you would have, since ${since}:`,
          ...missed.map((line) => `- ${line}`),
        ]),
    "",
    "Don't message them with post as you go: what you write at the end is the one message they get, in the chat.",
    "Keep it short: what you missed while you were paused and what you've done about it, in a line or a few short",
    "lines. If none of it needed them, say that in a line.",
  ].join("\n");

export const createBackground = ({
  engine,
  clock,
  settings,
  info,
  timeZone,
  ready,
  frame,
  wakeUps,
  post,
  report,
  onPause,
  silenceMs: silence = silenceMs,
  unknownResetMs: unknownReset = unknownResetMs,
  retryMs = catchUpRetryMs,
}: BackgroundOptions): Background => {
  const state = createCell<State>(fromSaved(settings.setting(pauseSetting)));
  const touched = createCell<ReadonlySet<string>>(new Set());
  const timer = createCell<Cancel | undefined>(undefined);
  const isCatchingUp = createCell(false);
  const isClosed = createCell(false);

  const setState = (next: State): void => {
    state.set(next);
    const saved = toSaved(next);
    settings.setSetting(pauseSetting, saved === undefined ? "" : JSON.stringify(saved));
    onPause();
  };

  const disarm = (): void => {
    timer.get()?.();
    timer.set(undefined);
  };

  // Runs `then` at `at`, however far off, with timers no longer than the clock can hold.
  const armAt = (at: number, then: () => void): void => {
    disarm();
    if (isClosed.get()) return;
    const wait = Math.min(Math.max(0, at - clock.now()), longestTimerMs);
    const fire = (): void => {
      timer.set(undefined);
      if (clock.now() < at) armAt(at, then);
      else then();
    };
    timer.set(clock.after(wait, fire));
  };

  // One try, stopped once the model has shown no sign of life for a long while. Whatever the engine says after
  // that is too late.
  const tryOnce = (
    prompt: string,
    run: string,
    choice: ModelChoice | undefined,
  ): Promise<Result<string, WorkFailure>> =>
    new Promise((resolve) => {
      const controller = new AbortController();
      const silenceTimer = createCell<Cancel | undefined>(undefined);
      const isSettled = createCell(false);
      const settle = (done: Result<string, WorkFailure>): void => {
        if (isSettled.get()) return;
        isSettled.set(true);
        silenceTimer.get()?.();
        resolve(done);
      };
      const arm = (): void => {
        if (isSettled.get()) return;
        silenceTimer.get()?.();
        silenceTimer.set(
          clock.after(silence, () => {
            controller.abort();
            settle(fail({ code: "model_timeout", detail: silentDetail(silence) }));
          }),
        );
      };
      arm();
      const working = async (): Promise<void> => {
        try {
          settle(
            await engine.work(frame(prompt), run, {
              ...(choice && { choice }),
              onActivity: arm,
              signal: controller.signal,
            }),
          );
        } catch (error) {
          settle(fail({ code: "engine_failed", detail: String(error) }));
        }
      };
      void working();
    });

  // A run cut off by Codex restarting, before it acted, is tried again; a silent one is stopped and tried once more.
  const attempt = async (
    prompt: string,
    run: string,
    choice: ModelChoice | undefined,
    restarts = 2,
    isRetry = false,
  ): Promise<Result<string, WorkFailure>> => {
    const done = await tryOnce(isRetry ? `${retryNote}\n\n${prompt}` : prompt, run, choice);
    if (done.ok) return done;
    const isCutOff = done.failure.detail === restartedDetail && !touched.get().has(run);
    if (isCutOff && restarts > 0) return attempt(prompt, run, choice, restarts - 1, isRetry);
    if (!isRetry && done.failure.code === "model_timeout" && done.failure.detail === silentDetail(silence)) {
      info("Kumo's background work went quiet, so it was stopped and is tried once more", {
        run,
        silent_minutes: Math.round(silence / 60_000),
      });
      return attempt(prompt, run, choice, restarts, true);
    }
    return done;
  };

  const forget = (run: string): void => {
    touched.update((runs) => new Set([...runs].filter((other) => other !== run)));
  };

  const catchUp = async (): Promise<void> => {
    const current = state.get();
    if (current.kind === "working" || isCatchingUp.get() || isClosed.get()) return;
    disarm();
    isCatchingUp.set(true);
    try {
      await catchUpFrom(current.kind === "paused" ? current.pause.since : current.since, current.missed);
    } finally {
      isCatchingUp.set(false);
    }
  };

  const catchUpFrom = async (since: number, missed: readonly string[]): Promise<void> => {
    setState({ kind: "catching_up", since, missed });
    const held = wakeUps();
    const overdue = held.overdue();
    if (overdue.length === 0 && missed.length === 0) {
      info("Kumo's pause is over, and nothing was missed", { since: toTimestamp(since) });
      setState({ kind: "working" });
      held.resume();
      return;
    }
    await ready();
    const run = `catch-up-${randomUUID()}`;
    const lines = overdue.map((wakeUp) => held.describe(wakeUp));
    const sinceWords = whenWords(since, clock.now(), timeZone());
    const done = await attempt(catchUpPrompt(sinceWords, lines, missed), run, undefined);
    forget(run);
    const after = state.get();
    if (isClosed.get() || after.kind !== "catching_up") return;
    if (!done.ok && done.failure.code === "usage_limit") {
      pause(after.missed);
      return;
    }
    // The limit is over but the model didn't answer: wake-ups keep waiting, the problem shows once it lasts, and
    // Kumo tries the catch-up again later, as it would a wake-up.
    if (!done.ok) {
      info("Kumo couldn't catch up after its pause, so it tries again later", { error: done.failure.detail });
      report({ ok: false, reason: done.failure.detail, isAuth: false });
      armAt(clock.now() + retryMs, () => void catchUp());
      return;
    }
    report({ ok: true });
    held.caughtUp(overdue, run);
    const message = done.value.trim();
    if (message !== "") post(message);
    info("Kumo caught up after its pause", { wake_ups: overdue.length, missed: after.missed });
    setState({ kind: "working" });
    held.resume();
  };

  const pause = (missed: readonly string[] = []): void => {
    const now = clock.now();
    const resetsAt = engine.usageResetsAt();
    const isKnown = resetsAt !== undefined && resetsAt > now;
    const until = isKnown ? resetsAt : now + unknownReset;
    const current = state.get();
    const since =
      current.kind === "paused" ? current.pause.since : current.kind === "catching_up" ? current.since : now;
    const kept = current.kind === "working" ? [] : current.missed;
    const all = missed.reduce(withMissed, kept);
    if (current.kind === "paused" && current.pause.until >= until) {
      if (all.length !== current.missed.length) setState({ ...current, missed: all });
      return;
    }
    info("Kumo's model reached its usage limit, so background work pauses until it resets", {
      until: toTimestamp(until),
      is_known: isKnown,
    });
    setState({ kind: "paused", pause: { since, until, isKnown }, missed: all });
    armAt(until, () => void catchUp());
  };

  const work = async (
    prompt: string,
    { run: given, choice, missed }: BackgroundWork = {},
  ): Promise<Result<string, string>> => {
    await ready();
    const current = state.get();
    if (current.kind === "paused") {
      const all = withMissed(current.missed, missed);
      if (all !== current.missed) setState({ ...current, missed: all });
      return fail(pausedDetail);
    }
    const run = given ?? randomUUID();
    const done = await attempt(prompt, run, choice);
    forget(run);
    if (done.ok) {
      report({ ok: true });
      return ok(done.value);
    }
    if (done.failure.code === "usage_limit") {
      pause(missed === undefined ? [] : [missed]);
      report({ ok: true });
      return fail(pausedDetail);
    }
    info("Kumo's background work didn't finish", { error: done.failure.detail });
    report({ ok: false, reason: done.failure.detail, isAuth: false });
    return fail(done.failure.detail);
  };

  // A pause saved before a restart picks up where it was; one that's over catches up straight away.
  const saved = state.get();
  if (saved.kind === "paused") {
    if (saved.pause.until <= clock.now()) {
      state.set({ kind: "catching_up", since: saved.pause.since, missed: saved.missed });
    }
    armAt(saved.pause.until, () => void catchUp());
  }

  return {
    work,
    touch: (run) => {
      touched.update((runs) => new Set([...runs, run]));
    },
    limitReached: () => {
      pause();
    },
    answered: () => {
      void catchUp();
    },
    isHolding: () => state.get().kind !== "working",
    paused: () => {
      const current = state.get();
      return current.kind === "paused" ? current.pause : undefined;
    },
    close: () => {
      isClosed.set(true);
      disarm();
    },
  };
};
