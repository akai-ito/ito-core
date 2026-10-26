import { mkdirSync } from "node:fs";
import path from "node:path";
import type { FastifyInstance, FastifyServerOptions } from "fastify";
import { createCell } from "#cell.ts";
import { createDoors } from "#capabilities/doors.ts";
import { createHost, type Host, type Installed } from "#capabilities/host.ts";
import { writeLauncher } from "#capabilities/launcher.ts";
import { writeSkills } from "#capabilities/skills.ts";
import { createTrail } from "#capabilities/trail.ts";
import type { Embedder } from "#memory/embedder.ts";
import { createMemory, type Memory } from "#memory/memory.ts";
import { createMemoryStore } from "#store/memory.ts";
import type { Tool, ToolResult } from "#tools/mcp.ts";
import { systemClock, toTimestamp, type Cancel, type Clock } from "#clock.ts";
import { codexVersion } from "#engine/codex/binary.ts";
import type { Engine, ToolServer } from "#engine/engine.ts";
import { createApp } from "#http/app.ts";
import { createGate, createToken, tokenSetting } from "#http/auth.ts";
import { registerTools, toolsPath } from "#http/tools.ts";
import { randomIdentifiers, type Identifiers } from "#identifiers.ts";
import { loadSchemas } from "#protocol/schemas.ts";
import { createAskTool } from "#asks/tool.ts";
import { createAttachments, type Attachments } from "#attachments/attachments.ts";
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
  readonly push?: Partial<PushOptions>;
  readonly capabilities?: readonly Installed[];
  readonly embedder: Embedder;
  readonly timeZone?: string;
};

export type PushOptions = { readonly hosts: ApnsHosts; readonly reminderMs: number };

export type EngineContext = {
  readonly settings: Settings;
  readonly log: Log;
  readonly info: Info;
  readonly tools: () => ToolServer | undefined;
  readonly skills: () => string;
  readonly inMind: () => string;
  readonly callTool: (name: string, input: unknown) => Promise<ToolResult>;
};

export type Server = {
  readonly app: FastifyInstance;
  readonly store: Store;
  readonly turns: Turns;
  readonly attachments: Attachments;
  readonly host: Host;
  readonly memory: Memory;
  readonly callTool: (name: string, input: unknown) => Promise<ToolResult>;
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
  const database = openDatabase(databaseFile(options.dataDirectory));
  const store = createStore(database, clock, identifiers);
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
    if (!address || typeof address !== "object") return undefined;
    const origin = `http://${address.address}:${String(address.port)}`;
    return { url: `${origin}${toolsPath}`, origin, token: toolsToken };
  };
  const host = createHost({
    installed: options.capabilities ?? [],
    settings: store,
    folders: path.join(options.dataDirectory, "capabilities"),
    server: { version: packageVersion(), engine: `Codex ${codexVersion()}` },
    clock,
    info,
  });
  const launcher = writeLauncher(path.join(options.dataDirectory, "bin", "ito"));
  const skills = (): string => writeSkills(path.join(options.dataDirectory, "skills"), host.offered(), launcher);
  const memory = createMemory({
    directory: path.join(options.dataDirectory, "thread"),
    store: createMemoryStore(database),
    settings: store,
    clock,
    identifiers,
    embedder: options.embedder,
    recordStep: (facts) => turns.recordStep("memory", facts),
    info,
    timeZone: options.timeZone ?? new Intl.DateTimeFormat().resolvedOptions().timeZone,
  });
  const engine = options.createEngine({
    settings: store,
    log,
    info,
    tools: toolServer,
    skills,
    inMind: memory.inMindText,
    callTool: (name, input) => callTool(name, input),
  });
  host.subscribe(() => {
    void engine.refresh();
  });
  const attachments = createAttachments(store, path.join(options.dataDirectory, "attachments"));
  const secrets = createSecrets();
  const turns = createTurns(store, engine, clock, identifiers, log, {
    limits: options.limits ?? defaultLimits,
    attachmentPath: attachments.pathOf,
    secrets,
    trail: createTrail(host, launcher),
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
    host,
    memory,
    heartbeatMs: options.heartbeatMs ?? defaultHeartbeatMs,
    logger: options.logger ?? false,
  });
  logError.set((message, error) => {
    app.log.error({ err: error }, message);
  });
  logInfo.set((message, details) => {
    app.log.info(details, message);
  });
  const doors = createDoors({ host, secrets, currentTurn: () => store.runningTurn()?.id, command: launcher });
  const coreTools: readonly Tool[] = [createAskTool(turns), ...memory.tools];
  const allTools = (): readonly Tool[] => [...coreTools, ...doors.tools()];
  const callTool = async (name: string, input: unknown): Promise<ToolResult> => {
    const tool = allTools().find((candidate) => candidate.name === name);
    return tool ? tool.call(input) : { text: `Ito has no tool ${name}.`, isError: true };
  };
  store.subscribe(({ event }) => {
    if (event.type === "turn.ended") memory.indexConversation();
  });
  registerTools(app, {
    token: toolsToken,
    tools: allTools,
    command: doors.command,
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
    await host.close();
    await memory.close();
    apns.close();
    store.close();
  };
  const closing = createCell<Promise<void> | undefined>(undefined);

  return {
    app,
    store,
    turns,
    attachments,
    host,
    memory,
    callTool,
    close: () => {
      const pending = closing.get() ?? shutdown();
      closing.set(pending);
      return pending;
    },
  };
};
