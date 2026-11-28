import { createCell } from "#cell.ts";
import type { Clock } from "#clock.ts";
import { fieldOf } from "#tools/input.ts";

// What Kumo is working on right now, for Going on: the things in motion and memory pages that a running turn or a
// piece of background work has touched with a tool. A turn's touches last until it ends, background work's until
// its run ends, and none outlives the backstop, so a run that never says it ended can't keep a thing busy. A call
// from neither, such as from the command line, touches nothing.
export type Busy = {
  // A tool was called: from background work (`run`), or else from the turn running in the chat or a side thread.
  readonly called: (tool: string, input: unknown, run: string | undefined) => void;
  // A piece of background work ended.
  readonly ended: (run: string) => void;
  // A turn in the chat or a side thread started, or ended.
  readonly turnStarted: () => void;
  readonly turnEnded: () => void;
  // Whether anything running has touched it: a `motion:` id or a `memory:` address.
  readonly isWorking: (target: string) => boolean;
};

type Touch = { readonly target: string; readonly by: string; readonly at: number };

const turnRun = "turn";

const backstopMs = 30 * 60 * 1000;

// What a tool call touches: the thing in motion a motion tool names, or the memory page a tool names.
export const targetsOf = (tool: string, input: unknown): readonly string[] => {
  const id = fieldOf(input, "id");
  const address = fieldOf(input, "address");
  return [
    ...(typeof id === "string" && id !== "" && tool.endsWith("_motion") ? [`motion:${id}`] : []),
    ...(typeof address === "string" && address.startsWith("memory:") ? [address] : []),
  ];
};

export const createBusy = (clock: Clock): Busy => {
  const touches = createCell<readonly Touch[]>([]);
  const isTurnRunning = createCell(false);
  const drop = (by: string): void => {
    touches.update((current) => current.filter((touch) => touch.by !== by));
  };

  return {
    called: (tool, input, run) => {
      if (run === undefined && !isTurnRunning.get()) return;
      const by = run ?? turnRun;
      const at = clock.now();
      const fresh = targetsOf(tool, input).map((target) => ({ target, by, at }));
      if (fresh.length === 0) return;
      touches.update((current) => [
        ...current.filter(
          (touch) =>
            at - touch.at < backstopMs && fresh.every(({ target }) => !(target === touch.target && touch.by === by)),
        ),
        ...fresh,
      ]);
    },
    ended: (run) => {
      drop(run);
    },
    turnStarted: () => {
      isTurnRunning.set(true);
    },
    turnEnded: () => {
      isTurnRunning.set(false);
      drop(turnRun);
    },
    isWorking: (target) => {
      const now = clock.now();
      return touches.get().some((touch) => touch.target === target && now - touch.at < backstopMs);
    },
  };
};
