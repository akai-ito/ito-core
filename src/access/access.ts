import { toTimestamp, type Clock } from "#clock.ts";
import type { NewDone } from "#desk/desk.ts";
import type { Access } from "#protocol/types.ts";
import { accessSetting, sandboxed, type Store } from "#store/store.ts";
import type { Info } from "#turns/turns.ts";

// Whether Kumo runs without its sandbox, as the setting says now. The engine reads it as each turn or piece of work
// starts, so a change applies from the next one and never to one already running.
export const isFullAccess = (read: (key: string) => string | undefined): boolean => {
  const saved = read(accessSetting);
  return saved !== undefined && (JSON.parse(saved) as Access).mode === "full";
};

export type AccessOptions = {
  readonly store: Pick<Store, "access" | "setAccess">;
  // Notes each change in Kumo's work.
  readonly addDone: (entry: NewDone) => unknown;
  readonly clock: Clock;
  readonly info: Info;
  // The time on their clock, as Kumo reads it.
  readonly spoken: (at: number) => string;
  // Ito's own checkout, which full access lets Kumo change.
  readonly checkout: string;
};

export type AccessKeeper = {
  readonly current: () => Access;
  // Turns full access on, from the next turn; already on, it changes nothing.
  readonly giveFull: () => Access;
  // Puts Kumo back in its sandbox, from the next turn; safe to repeat.
  readonly endFull: () => Access;
  // While full access is on, what it lets Kumo do and how to go about it; nothing while it's in its sandbox.
  readonly inMindText: () => string;
};

export const createAccess = ({ store, addDone, clock, info, spoken, checkout }: AccessOptions): AccessKeeper => {
  const change = (next: Access, done: NewDone): Access => {
    store.setAccess(next);
    addDone(done);
    info("Kumo's access changed, from its next turn", { mode: next.mode });
    return next;
  };

  return {
    current: () => store.access(),

    giveFull: () => {
      const current = store.access();
      if (current.mode === "full") return current;
      return change(
        { mode: "full", since: toTimestamp(clock.now()) },
        {
          text: "Full access on: Kumo runs without its sandbox from its next turn",
          reason: "You turned it on in Settings",
          quiet: false,
        },
      );
    },

    endFull: () => {
      if (store.access().mode === "sandboxed") return sandboxed;
      return change(sandboxed, {
        text: "Full access off: Kumo's back in its sandbox from its next turn",
        reason: "You turned it off in Settings",
        quiet: false,
      });
    },

    inMindText: () => {
      const current = store.access();
      if (current.mode !== "full") return "";
      const since = current.since === undefined ? "" : ` since ${spoken(Date.parse(current.since))}`;
      return [
        "<access>",
        `Full access is on${since}: they turned it on, and can turn it off in Settings. Your commands run ` +
          "without the sandbox, with nothing asked first: you can install packages, restart services and change " +
          `files anywhere their user can, Ito's own checkout at ${checkout} included, as well as your workspace.`,
        "Take care with it. Before anything that changes the machine, say in a line what you're about to do and " +
          "why, then do it, check that it worked, and say what changed. Change Ito's own code only when they ask, " +
          "and never with git history rewritten or work thrown away. Restarting Ito " +
          "(`systemctl --user restart ito`) ends the turn you're in, so say so first and make it the last thing " +
          "you do.",
        "</access>",
      ].join("\n");
    },
  };
};
