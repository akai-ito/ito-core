import { mkdirSync } from "node:fs";
import path from "node:path";
import type { FastifyInstance, FastifyServerOptions } from "fastify";
import { createCell } from "#cell.ts";
import { systemClock, toTimestamp, type Cancel, type Clock } from "#clock.ts";
import { codexVersion } from "#engine/codex/binary.ts";
import type { Engine, ToolServer } from "#engine/engine.ts";
import { createApp } from "#http/app.ts";
import { createGate, createToken, tokenSetting } from "#http/auth.ts";
import { registerTools, toolsPath } from "#http/tools.ts";
import { randomIdentifiers, type Identifiers } from "#identifiers.ts";
import { loadSchemas } from "#protocol/schemas.ts";
import { createGitHub } from "#reports/github.ts";
import { createReporter, defaultDailyLimit } from "#reports/reporter.ts";
import { createReportTool } from "#reports/tool.ts";
import { createAskTool } from "#asks/tool.ts";
import { createAttachments } from "#attachments/attachments.ts";
import { appleHosts, createApns, readApnsCredentials, type ApnsHosts } from "#notifications/apns.ts";
import { createNotifier, defaultReminderMs } from "#notifications/notifier.ts";
import { createPresence } from "#notifications/presence.ts";
import { openDatabase } from "#store/database.ts";
import { createStore, type Settings, type Store } from "#store/store.ts";
import { createSecrets } from "#conversation/secrets.ts";
import { createTurns, defaultLimits, type Info, type Limits, type Log, type Turns } from "#turns/turns.ts";
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
  readonly reports?: Partial<ReportsOptions>;
  readonly push?: Partial<PushOptions>;
};

export type PushOptions = { readonly hosts: ApnsHosts; readonly reminderMs: number };

export type ReportsOptions = { readonly apiUrl: string; readonly repository: string; readonly dailyLimit: number };

export type EngineContext = {
  readonly settings: Settings;
  readonly log: Log;
  readonly info: Info;
  readonly tools: () => ToolServer | undefined;
};

export type Server = {
  readonly app: FastifyInstance;
  readonly store: Store;
  readonly turns: Turns;
  readonly close: () => Promise<void>;
};

const dayMs = 24 * 60 * 60 * 1000;
const textRetentionMs = 30 * dayMs;
const defaultHeartbeatMs = 15_000;
const defaultReports: ReportsOptions = {
  apiUrl: "https://api.github.com",
  repository: "akai-ito/ito-core",
  dailyLimit: defaultDailyLimit,
};

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
  const logInfo = createCell<Info>((message, details) => {
    console.log(message, details);
  });
  const info: Info = (message, details) => {
    logInfo.get()(message, details);
  };
  const toolsToken = createToken();
  const toolServer = (): ToolServer | undefined => {
    const address = app.server.address();
    return address && typeof address === "object"
      ? { url: `http://${address.address}:${String(address.port)}${toolsPath}`, token: toolsToken }
      : undefined;
  };
  const engine = options.createEngine({ settings: store, log, info, tools: toolServer });
  const attachments = createAttachments(store, path.join(options.dataDirectory, "attachments"));
  const secrets = createSecrets();
  const turns = createTurns(store, engine, clock, identifiers, log, {
    limits: options.limits ?? defaultLimits,
    attachmentPath: attachments.pathOf,
    secrets,
  });
  const agentName = options.agentName ?? "Ari";
  const presence = createPresence();
  const push = { hosts: appleHosts, reminderMs: defaultReminderMs, ...options.push };
  const apns = createApns(() => readApnsCredentials(store), push.hosts, clock);
  const notifier = createNotifier({ store, apns, clock, presence, agentName, log, reminderMs: push.reminderMs });

  const app = createApp({
    store,
    turns,
    clock,
    schemas: loadSchemas(),
    info: { name: options.name, version: packageVersion(), agentName },
    gate: createGate(() => [store.setting(tokenSetting) ?? "", ...store.pairedTokenHashes()].filter(Boolean), clock),
    presence,
    attachments,
    heartbeatMs: options.heartbeatMs ?? defaultHeartbeatMs,
    logger: options.logger ?? false,
  });
  logError.set((message, error) => {
    app.log.error({ err: error }, message);
  });
  logInfo.set((message, details) => {
    app.log.info(details, message);
  });
  const reports = { ...defaultReports, ...options.reports };
  const reporter = createReporter({
    settings: store,
    clock,
    info,
    versions: { ito: packageVersion(), codex: codexVersion() },
    connect: (token) =>
      createGitHub({
        apiUrl: reports.apiUrl,
        repository: reports.repository,
        token,
        userAgent: `ito/${packageVersion()}`,
      }),
    dailyLimit: reports.dailyLimit,
  });
  registerTools(app, {
    token: toolsToken,
    tools: [createReportTool(reporter, () => store.runningTurn()?.id, secrets), createAskTool(turns)],
    version: packageVersion(),
  });

  const compaction = createCell<Cancel | undefined>(undefined);
  const compact = (): void => {
    store.compactText(toTimestamp(clock.now() - textRetentionMs));
    attachments.sweep(toTimestamp(clock.now() - dayMs));
    compaction.set(clock.after(dayMs, compact));
  };
  compact();
  turns.recover();

  const shutdown = async (): Promise<void> => {
    compaction.get()?.();
    notifier.close();
    await app.close();
    await turns.close();
    await engine.close();
    apns.close();
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
