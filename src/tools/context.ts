import { AsyncLocalStorage } from "node:async_hooks";

export type ToolContext = { readonly run?: string };

const context = new AsyncLocalStorage<ToolContext>();

export const inToolContext = <Value>(given: ToolContext, work: () => Value): Value => context.run(given, work);

export const contextRun = (): string | undefined => context.getStore()?.run;
