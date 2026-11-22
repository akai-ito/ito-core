import { createCell } from "#cell.ts";
import type { Clock } from "#clock.ts";
import { toThreadId, type MessageId, type ThreadId } from "#conversation/ids.ts";
import type { Engine } from "#engine/engine.ts";
import type { Identifiers } from "#identifiers.ts";
import { lineOf } from "#notifications/text.ts";
import type { Store } from "#store/store.ts";
import { contextThread } from "#tools/context.ts";
import { createTurns, type Log, type Turns, type TurnsOptions } from "#turns/turns.ts";

// The main chat and each side thread are conversations of their own, each with its own turns, so talking in one
// never steers another aside or waits behind it. Each runs the same turn logic, over its own part of the store and
// its own conversation in the engine; this hands every command to the one it belongs to.
export type Lanes = Turns & {
  // Kumo moved messages out of the main chat's running turn into a thread of their own: the thread answers them in
  // its own turn, and the main chat's turn ends quietly when they were all it had. True when it did.
  readonly branched: (thread: ThreadId, moved: readonly MessageId[], brief: string) => boolean;
  // You moved a message: both conversations hear of it with their next turn, and it's answered where it went if it
  // was still waiting.
  readonly moved: (message: MessageId, from: ThreadId | undefined, to: ThreadId | undefined) => void;
};

export type LanesOptions = {
  readonly store: Store;
  readonly engine: Engine;
  readonly clock: Clock;
  readonly identifiers: Identifiers;
  readonly log: Log;
  readonly turns?: TurnsOptions;
};

const mainKey = "";

const postLength = 1500;

const keyOf = (thread: ThreadId | undefined): string => thread ?? mainKey;

export const createLanes = ({ store, engine, clock, identifiers, log, turns: options = {} }: LanesOptions): Lanes => {
  const lanes = createCell<ReadonlyMap<string, Turns>>(new Map());
  // One-off notes for a conversation's next turn, such as a message moved in or out.
  const notes = createCell<ReadonlyMap<string, readonly string[]>>(new Map());

  const addNote = (thread: ThreadId | undefined, note: string): void => {
    notes.update((current) => new Map([...current, [keyOf(thread), [...(current.get(keyOf(thread)) ?? []), note]]]));
  };

  const takeNotes = (thread: ThreadId | undefined): readonly string[] => {
    const taken = notes.get().get(keyOf(thread)) ?? [];
    notes.update((current) => new Map([...current].filter(([key]) => key !== keyOf(thread))));
    return taken;
  };

  // What this conversation hasn't seen: Kumo's posts here since its last turn, which its background work wrote.
  const notesFor = (thread: ThreadId | undefined): string =>
    [
      options.moreNotes?.() ?? "",
      ...store.postsSinceTurn(thread).map((post) => {
        const text = post.text.length > postLength ? `${post.text.slice(0, postLength)}…` : post.text;
        return `(Meanwhile, your background work posted this here: “${text}”)`;
      }),
      ...takeNotes(thread),
    ]
      .filter(Boolean)
      .join("\n\n");

  const laneFor = (thread: ThreadId | undefined): Turns => {
    const existing = lanes.get().get(keyOf(thread));
    if (existing) return existing;
    const scoped: Store = {
      ...store,
      pendingWork: () => store.pendingWork(thread),
      runningTurn: () => store.runningTurn(thread),
      startTurn: (turn, inputs, retryOf) => {
        store.startTurn(turn, inputs, retryOf, thread);
      },
    };
    const conversation: Engine = {
      ...engine,
      start: (turn, inputs) => engine.start(turn, inputs, thread),
      restart: () => engine.reset(thread),
    };
    const lane = createTurns(scoped, conversation, clock, identifiers, log, {
      ...options,
      moreNotes: () => notesFor(thread),
    });
    lanes.update((current) => new Map([...current, [keyOf(thread), lane]]));
    return lane;
  };

  const placeOf = (message: MessageId): ThreadId | undefined => {
    const thread = store.findMessage(message)?.thread;
    return thread === undefined ? undefined : toThreadId(thread);
  };

  const titleOf = (thread: ThreadId | undefined): string => {
    if (thread === undefined) return "the main chat";
    const title = store.findThread(thread)?.title;
    return title === undefined ? "a side thread" : `the thread “${title}”`;
  };

  const everyLane = (): readonly Turns[] => lanes.get().values().toArray();

  return {
    route: (message, text) => {
      laneFor(placeOf(message)).route(message, text);
    },

    amend: (message, text, added) => {
      laneFor(placeOf(message)).amend(message, text, added);
    },

    stop: (turn) => laneFor(store.findTurn(turn)?.thread).stop(turn),

    retry: (failed) => laneFor(store.findTurn(failed)?.thread).retry(failed),

    // Asks, approvals and steps come from a tool call, which knows the conversation it's in.
    ask: (fields) => laneFor(contextThread()).ask(fields),

    approve: (fields) => laneFor(contextThread()).approve(fields),

    recordStep: (kind, facts) => laneFor(contextThread()).recordStep(kind, facts),

    cancelAsk: (ask) => {
      const thread = store.findAsk(ask)?.thread;
      return laneFor(thread === undefined ? undefined : toThreadId(thread)).cancelAsk(ask);
    },

    recover: () => {
      const threads = [
        ...new Set([...store.runningTurns().flatMap(({ thread }) => thread ?? []), ...store.waitingThreads()]),
      ];
      laneFor(undefined).recover();
      for (const thread of threads) laneFor(thread).recover();
    },

    handOff: () => laneFor(contextThread()).handOff(),

    wake: () => {
      for (const lane of everyLane()) lane.wake();
    },

    branched: (thread, moved, brief) => {
      const turn = store.runningTurn();
      if (!turn) return false;
      for (const message of moved) store.queueMessage(turn.id, message);
      if (brief !== "")
        addNote(thread, `(You started this thread from the main chat, with this note for it: ${brief})`);
      const isAll = [...turn.inputs, ...turn.read].every((message) => moved.includes(message));
      const isHandedOff = isAll && laneFor(undefined).handOff();
      laneFor(thread).wake();
      return isHandedOff;
    },

    moved: (message, from, to) => {
      const found = store.findMessage(message);
      const line = found ? lineOf(found.text, found.attachments) : "a message";
      addNote(to, `(They moved a message here from ${titleOf(from)}: “${line}”)`);
      addNote(from, `(They moved the message “${line}” from here to ${titleOf(to)}.)`);
      if (store.pendingWork(to).some((work) => work.kind === "message" && work.message === message)) laneFor(to).wake();
    },

    settled: async () => {
      await Promise.all(everyLane().map((lane) => lane.settled()));
    },

    close: async () => {
      await Promise.all(everyLane().map((lane) => lane.close()));
    },
  };
};
