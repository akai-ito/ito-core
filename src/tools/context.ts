import { AsyncLocalStorage } from "node:async_hooks";
import { toThreadId, type ThreadId } from "#conversation/ids.ts";

// Where a tool call comes from: a piece of background work (`run`), or a side thread's conversation (`thread`);
// neither for the main chat.
export type ToolContext = { readonly run?: string; readonly thread?: string };

const context = new AsyncLocalStorage<ToolContext>();

export const inToolContext = <Value>(given: ToolContext, work: () => Value): Value => context.run(given, work);

export const contextRun = (): string | undefined => context.getStore()?.run;

export const contextThread = (): ThreadId | undefined => {
  const thread = context.getStore()?.thread;
  return thread === undefined ? undefined : toThreadId(thread);
};

// A dream's run: its tools, such as writing a day's journal entry, are offered only there.
export const dreamRunPrefix = "dream-";

export const isDreamRun = (run: string | undefined): boolean => run?.startsWith(dreamRunPrefix) === true;
