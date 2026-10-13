import { mkdirSync } from "node:fs";
import path from "node:path";
import type { FastifyInstance, FastifyServerOptions } from "fastify";
import { createCell } from "#cell.ts";
import { systemClock, toTimestamp, type Cancel, type Clock } from "#clock.ts";
import type { Engine } from "#engine/engine.ts";
import { createApp } from "#http/app.ts";
import { createGate, tokenSetting } from "#http/auth.ts";
import { randomIdentifiers, type Identifiers } from "#identifiers.ts";
import { loadSchemas } from "#protocol/schemas.ts";
import { openDatabase } from "#store/database.ts";
import { createStore, type Settings, type Store } from "#store/store.ts";
import { createTurns, defaultLimits, type Limits, type Log, type Turns } from "#turns/turns.ts";
import { packageVersion } from "#version.ts";

export type ServerOptions = {
  readonly dataDirectory: string;
  readonly createEngine: (context: EngineContext) => Engine;
  readonly name: string;
  readonly agentName?: string;
  readonly clock?: Clock;
  readonly identifiers?: Identifiers;
  readonly limits?: Limits;
  readonly heartbeatMs?: number;
  readonly logger?: FastifyServerOptions["logger"];
};

export type EngineContext = { readonly settings: Settings; readonly log: Log };

export type Server = {
  readonly app: FastifyInstance;
  readonly store: Store;
  readonly turns: Turns;
  readonly close: () => Promise<void>;
};

const dayMs = 24 * 60 * 60 * 1000;
const textRetentionMs = 30 * dayMs;
const defaultHeartbeatMs = 15_000;

export const databaseFile = (dataDirectory: string): string => path.join(dataDirectory, "ito.db");

export const createServer = (options: ServerOptions): Server => {
  const clock = options.clock ?? systemClock;
  const identifiers = options.identifiers ?? randomIdentifiers;
  mkdirSync(options.dataDirectory, { recursive: true });
  const store = createStore(openDatabase(databaseFile(options.dataDirectory)), clock, identifiers);
  const logError = createCell<Log>((message, error) => {
    console.error(message, error);
  });
  const log: Log = (message, error) => {
    logError.get()(message, error);
  };
  const engine = options.createEngine({ settings: store, log });
  const turns = createTurns(store, engine, clock, identifiers, log, options.limits ?? defaultLimits);

  const app = createApp({
    store,
    turns,
    clock,
    schemas: loadSchemas(),
    info: { name: options.name, version: packageVersion(), agentName: options.agentName ?? "Ari" },
    gate: createGate(() => store.setting(tokenSetting), clock),
    heartbeatMs: options.heartbeatMs ?? defaultHeartbeatMs,
    logger: options.logger ?? false,
  });
  logError.set((message, error) => {
    app.log.error({ err: error }, message);
  });

  const compaction = createCell<Cancel | undefined>(undefined);
  const compact = (): void => {
    store.compactText(toTimestamp(clock.now() - textRetentionMs));
    compaction.set(clock.after(dayMs, compact));
  };
  compact();
  turns.recover();

  const shutdown = async (): Promise<void> => {
    compaction.get()?.();
    await app.close();
    await turns.close();
    await engine.close();
    store.close();
  };
  const closing = createCell<Promise<void> | undefined>(undefined);

  return {
    app,
    store,
    turns,
    close: () => {
      const pending = closing.get() ?? shutdown();
      closing.set(pending);
      return pending;
    },
  };
};
