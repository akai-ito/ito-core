import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { FastifyInstance, FastifyServerOptions } from "fastify";
import { randomUUID } from "node:crypto";
import { createCell } from "#cell.ts";
import { createDoors } from "#capabilities/doors.ts";
import { createHost, type Host, type Installed } from "#capabilities/host.ts";
import { writeLauncher } from "#capabilities/launcher.ts";
import { writeOwnSkills, writeSkills, type OwnSkill } from "#capabilities/skills.ts";
import { createKinds } from "#motion/kinds.ts";
import { createMotions, type Motions } from "#motion/motion.ts";
import { createTrail } from "#capabilities/trail.ts";
import type { Embedder } from "#memory/embedder.ts";
import { noVoice, type VoiceContext, type VoiceLoop } from "#voice/loop.ts";
import { createCalls, type Calls } from "#voice/calls.ts";
import { createVoiceprints } from "#voice/voiceprints.ts";
import { chosenVoice } from "#voice/voices.ts";
import { createMemory, type Memory } from "#memory/memory.ts";
import { createImageTool } from "#replies/images.ts";
import type { Fetch } from "#capabilities/connect.ts";
import { createCapabilityApprovals } from "#capabilities/approvals.ts";
import { createTopics } from "#topics/topics.ts";
import { createMemoryStore } from "#store/memory.ts";
import type { Tool, ToolResult } from "#tools/mcp.ts";
import { withCheckedInput } from "#tools/input.ts";
import { systemClock, toTimestamp, type Cancel, type Clock } from "#clock.ts";
import { codexVersion } from "#engine/codex/binary.ts";
import type { Engine, ToolServer } from "#engine/engine.ts";
import { createApp } from "#http/app.ts";
import { createGate, createToken, tokenSetting } from "#http/auth.ts";
import { leadOf } from "#http/settings.ts";
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
import { createTurns, defaultLimits, type Info, type Limits, type Log, type Turns } from "#turns/turns.ts";
import { packageVersion } from "#version.ts";
import type { Result } from "#result.ts";
import { createDesk } from "#desk/desk.ts";
import { createBriefings } from "#desk/briefing.ts";
import { createWorkTools } from "#work/tools.ts";
import { inToolContext } from "#tools/context.ts";

export type ServerOptions = {
  readonly dataDirectory: string;
  readonly createEngine: (context: EngineContext) => Engine;
  readonly name: string;
  readonly clock?: Clock;
  readonly identifiers?: Identifiers;
  readonly limits?: Limits;
  readonly heartbeatMs?: number;
  readonly logger?: FastifyServerOptions["logger"];
  readonly push?: Partial<PushOptions>;
  readonly capabilities?: readonly Installed[];
  readonly embedder: Embedder;
  readonly createVoice?: (context: VoiceContext) => VoiceLoop;
  readonly timeZone?: string;
  readonly fetch?: Fetch;
};

export type PushOptions = { readonly hosts: ApnsHosts; readonly reminderMs: number };

export type EngineContext = {
  readonly settings: Settings;
  readonly log: Log;
  readonly info: Info;
  readonly tools: () => ToolServer | undefined;
  readonly skills: () => string;
  readonly instructions: () => string;
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
  readonly motions: Motions;
  readonly voice: VoiceLoop;
  readonly calls: Calls;
  readonly callTool: (name: string, input: unknown, run?: string) => Promise<ToolResult>;
  readonly close: () => Promise<void>;
};

const voiceText = readFileSync(new URL("../agent/instructions.md", import.meta.url), "utf8");

const talkRules = readFileSync(new URL("../agent/talk.md", import.meta.url), "utf8").trim();

const workRules = readFileSync(new URL("../agent/work.md", import.meta.url), "utf8").trim();

const isBusy = (): boolean => false;

const motionSkill: OwnSkill = {
  id: "things-in-motion",
  summary: "starting and keeping things in motion, such as a trip being planned, and finding their photos",
  text: readFileSync(new URL("../agent/motion.md", import.meta.url), "utf8"),
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
  const listening = createCell<Promise<void>>(Promise.resolve());
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
  const fetcher = options.fetch ?? fetch;
  const host = createHost({
    installed: options.capabilities ?? [],
    fetch: fetcher,
    settings: store,
    folders: path.join(options.dataDirectory, "capabilities"),
    server: {
      version: packageVersion(),
      engine: `Codex ${codexVersion()}`,
      workspace: path.join(options.dataDirectory, "workspace"),
    },
    clock,
    info,
    approve: createCapabilityApprovals({ store, approve: (fields) => turns.approve(fields) }),
  });
  const launcher = writeLauncher(path.join(options.dataDirectory, "bin", "ito"));
  const skills = (): string =>
    writeOwnSkills(path.join(options.dataDirectory, "skills"), [motionSkill]) +
    writeSkills(path.join(options.dataDirectory, "skills"), host.offered(), launcher);
  const memory = createMemory({
    directory: path.join(options.dataDirectory, "thread"),
    store: createMemoryStore(database),
    settings: store,
    clock,
    identifiers,
    embedder: options.embedder,
    recordStep: (facts) => turns.recordStep("memory", facts),
    approve: (fields) => turns.approve(fields),
    info,
    timeZone: options.timeZone ?? new Intl.DateTimeFormat().resolvedOptions().timeZone,
  });
  const callContext = (): string => {
    const latest = store.latestCall();
    if (!latest) return "";
    return latest.ended_at === undefined
      ? `<call>\n${talkRules}\n</call>`
      : "<call>\nThe call has ended, so they're reading the chat. Write as usual, and don't say you've put " +
          "something in the chat: that's only for calls.\n</call>";
  };
  const engine = options.createEngine({
    settings: store,
    log,
    info,
    tools: toolServer,
    skills,
    instructions: () => voiceText.replaceAll("{lead}", () => leadOf(store)) + skills(),
    inMind: () => [memory.inMindText(), motions.inMindText(), callContext()].filter(Boolean).join("\n\n"),
    callTool: (name, input) => callTool(name, input),
  });
  host.subscribe(() => {
    void engine.refresh();
  });
  const voice =
    options.createVoice?.({
      onReadiness: ({ state, reason }) => {
        store.recordVoiceStatus(state, reason);
      },
      vocabulary: () => memory.boostedNames(),
      clock,
      info,
      log,
    }) ?? noVoice("This server runs without a voice.");
  const attachments = createAttachments(store, path.join(options.dataDirectory, "attachments"));
  const turns = createTurns(store, engine, clock, identifiers, log, {
    limits: options.limits ?? defaultLimits,
    attachmentPath: attachments.pathOf,
    trail: createTrail(host, launcher),
    moreNotes: () => motions.tickNote(),
  });
  const schemas = loadSchemas();
  const motions = createMotions({
    memory,
    store,
    kinds: createKinds(schemas),
    clock,
    picturePath: attachments.pathOf,
    approve: (fields) => turns.approve(fields),
    recordStep: (facts) => turns.recordStep("motion", facts),
    info,
    complete: (prompt, schema) => engine.complete(prompt, schema),
  });
  const quickComplete: Engine["complete"] = async (prompt, schema, choice) => {
    await listening.get();
    return engine.complete(prompt, schema, choice);
  };
  const topics = createTopics({
    store,
    complete: quickComplete,
    models: async () => {
      await listening.get();
      return engine.models();
    },
    info,
  });
  const runWork = async (prompt: string): Promise<Result<string, string>> => {
    await listening.get();
    const done = await engine.work(`${workRules}\n\n${prompt}`, randomUUID());
    if (!done.ok) info("Kumo's background work didn't finish", { error: done.failure });
    return done;
  };
  const desk = createDesk({ store, identifiers, clock, work: runWork, info });
  const timeZone = options.timeZone ?? new Intl.DateTimeFormat().resolvedOptions().timeZone;
  const voiceprints = createVoiceprints(path.join(options.dataDirectory, "voice", "voiceprint.json"));
  const calls = createCalls({
    store,
    turns,
    attachments,
    voice,
    voiceprints,
    chosenVoice: () => chosenVoice(store),
    identifiers,
    clock,
    info,
    log,
  });
  const presence = createPresence();
  const briefings = createBriefings({
    store,
    desk,
    clock,
    timeZone,
    presence,
    complete: quickComplete,
    isBusy,
    identifiers,
    info,
  });
  const push = { hosts: appleHosts, reminderMs: defaultReminderMs, ...options.push };
  const apns = createApns(() => readApnsCredentials(store), push.hosts, clock);
  const notifier = createNotifier({
    store,
    apns,
    clock,
    presence,
    agentName: () => leadOf(store),
    log,
    reminderMs: push.reminderMs,
    timeZone,
    isBusy,
  });

  const app = createApp({
    store,
    turns,
    clock,
    schemas,
    info: { name: options.name, version: packageVersion() },
    gate: createGate(() => [store.setting(tokenSetting) ?? "", ...store.pairedTokenHashes()].filter(Boolean), clock),
    presence,
    attachments,
    host,
    memory,
    motions,
    voice,
    calls,
    voiceprints,
    models: () => engine.models(),
    heartbeatMs: options.heartbeatMs ?? defaultHeartbeatMs,
    desk,
    onLeadRenamed: () => {
      void engine.refresh();
    },
    logger: options.logger ?? false,
  });
  listening.set(
    new Promise<void>((resolve) => {
      app.addHook("onListen", (done) => {
        resolve();
        done();
      });
    }),
  );
  logError.set((message, error) => {
    app.log.error({ err: error }, message);
  });
  logInfo.set((message, details) => {
    app.log.info(details, message);
  });
  const doors = createDoors({ host, currentTurn: () => store.runningTurn()?.id, command: launcher });
  const imageTool = createImageTool({
    attachments,
    keep: (id) => {
      store.keepAttachment(id);
    },
    newId: () => identifiers.attachment(),
    fetchImage: (url, signal) => fetcher(url, { signal }),
  });
  const coreTools: readonly Tool[] = [
    createAskTool(turns),
    imageTool,
    ...memory.tools,
    ...motions.tools,
    ...createWorkTools({ store, desk }),
    {
      name: "brief_now",
      title: "Write the briefing now",
      audience: "hidden",
      description: "Write the morning briefing now, whatever the time.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      call: async () => {
        await briefings.briefNow();
        return { text: "Wrote the briefing." };
      },
    },
  ];
  const allTools = (): readonly Tool[] => [...coreTools, ...doors.tools()].map((tool) => withCheckedInput(tool));
  const callTool = async (name: string, input: unknown, run?: string): Promise<ToolResult> => {
    const tool = allTools().find((candidate) => candidate.name === name);
    return tool
      ? inToolContext(run === undefined ? {} : { run }, () => tool.call(input))
      : { text: `Ito has no tool ${name}.`, isError: true };
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
    motions.close();
    topics.close();
    briefings.close();
    notifier.close();
    await app.close();
    await turns.close();
    await engine.close();
    await host.close();
    await calls.close();
    await voice.close();
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
    motions,
    voice,
    calls,
    callTool,
    close: () => {
      const pending = closing.get() ?? shutdown();
      closing.set(pending);
      return pending;
    },
  };
};
