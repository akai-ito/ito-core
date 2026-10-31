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
import { restartedDetail, type Engine, type ToolServer } from "#engine/engine.ts";
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
import { createJobs, type Jobs } from "#jobs/jobs.ts";
import { registerJobs } from "#http/jobs.ts";
import { createJobStore } from "#store/jobs.ts";
import { createGettingStarted } from "#onboarding/onboarding.ts";
import { createCalendar, type Calendar } from "#calendar/calendar.ts";
import { createCalendarSource, type CalendarSource } from "#calendar/caldav.ts";
import type { Values } from "#capabilities/manifest.ts";
import { toSources } from "#sources/sources.ts";
import { createMailbox, type CreateMailSource, type Mailbox } from "#mail/mail.ts";
import { createQuickChoice } from "#engine/quick-model.ts";
import { contextRun, inToolContext } from "#tools/context.ts";

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
  readonly createCalendarSource?: (values: Values) => CalendarSource;
  readonly createMailSource?: CreateMailSource;
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
  readonly callTool: (name: string, input: unknown, run?: string) => Promise<ToolResult>;
};

export type Server = {
  readonly app: FastifyInstance;
  readonly store: Store;
  readonly turns: Turns;
  readonly attachments: Attachments;
  readonly host: Host;
  readonly memory: Memory;
  readonly motions: Motions;
  readonly jobs: Jobs;
  readonly voice: VoiceLoop;
  readonly calls: Calls;
  readonly calendar: Calendar;
  readonly mail: Mailbox;
  readonly callTool: (name: string, input: unknown, run?: string) => Promise<ToolResult>;
  readonly close: () => Promise<void>;
};

const voiceText = readFileSync(new URL("../agent/instructions.md", import.meta.url), "utf8");

const talkRules = readFileSync(new URL("../agent/talk.md", import.meta.url), "utf8").trim();

const workRules = readFileSync(new URL("../agent/work.md", import.meta.url), "utf8").trim();

const textValue = (values: Values, name: string): string => {
  const value = values[name];
  return typeof value === "string" ? value.trim() : "";
};

export const icloudCalendar = (values: Values): CalendarSource =>
  createCalendarSource({ appleId: textValue(values, "apple_id"), appPassword: textValue(values, "app_password") });

const motionSkill: OwnSkill = {
  id: "things-in-motion",
  summary:
    "starting and keeping things in motion, such as a trip, a job search, a dinner or a refund, and finding photos",
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
  const calendarSourceFor = options.createCalendarSource ?? icloudCalendar;
  const sources = toSources({
    icloud: async (values) => {
      const calendar = calendarSourceFor(values);
      const checked = await calendar.check();
      if (!checked.ok) return { problem: checked.failure };
      const mailChecked = await mail.check("icloud", values);
      if (mailChecked.problem !== undefined) return mailChecked;
      const kumo = await calendar.ensureKumo();
      const count = checked.value.calendars.filter(({ isKumo }) => !isKumo).length;
      return kumo.ok
        ? { summary: `Connected: Mail and ${String(count)} calendars. Kumo's calendar added.` }
        : { problem: kumo.failure };
    },
    outlook: (values) => mail.check("outlook", values),
    gmail: (values) => mail.check("gmail", values),
  });
  const host = createHost({
    installed: [...(options.capabilities ?? []), ...sources],
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
    inMind: () =>
      [memory.inMindText(), motions.inMindText(), jobs.inMindText(), gettingStarted.inMindText(), callContext()]
        .filter(Boolean)
        .join("\n\n"),
    callTool: (name, input, run) => callTool(name, input, run),
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
  const touchedRuns = createCell<ReadonlySet<string>>(new Set());
  const runWork = async (prompt: string): Promise<Result<string, string>> => {
    await listening.get();
    const attempt = async (retries: number): Promise<Result<string, string>> => {
      const run = randomUUID();
      const done = await engine.work(`${workRules}\n\n${prompt}`, run);
      const isTouched = touchedRuns.get().has(run);
      touchedRuns.update((runs) => new Set([...runs].filter((other) => other !== run)));
      const isCutOff = !done.ok && done.failure === restartedDetail && !isTouched;
      return isCutOff && retries > 0 ? attempt(retries - 1) : done;
    };
    const done = await attempt(2);
    if (!done.ok) info("Kumo's background work didn't finish", { error: done.failure });
    return done;
  };
  const desk = createDesk({ store, identifiers, clock, work: runWork, info });
  const jobs = createJobs({
    store: createJobStore(database),
    isMotion: (id) => store.findMotion(id) !== undefined,
    clock,
    identifiers,
    work: runWork,
    info,
  });
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
  const urgentPost = createCell(false);
  const mail = createMailbox({
    host,
    store,
    desk,
    clock,
    fetch: fetcher,
    complete: quickComplete,
    quickChoice: createQuickChoice(async () => {
      await listening.get();
      return engine.models();
    }),
    work: runWork,
    info,
    ...(options.createMailSource && { createSource: options.createMailSource }),
  });
  const calendar = createCalendar({ host, desk, clock, timeZone, info, createSource: calendarSourceFor });
  calendar.onEventEnded((uid) => {
    jobs.onEventEnded(uid);
  });
  const gettingStarted = createGettingStarted({
    store,
    identifiers,
    work: runWork,
    catchUp: mail.catchUp,
    hasMail: mail.hasSource,
    onSources: (listener) => host.subscribe(listener),
    onAdded: calendar.onAdded,
    motionIds: () => motions.list().map(({ id }) => id),
    info,
  });
  const isBusy = (): boolean => calendar.isBusy();
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
    isUrgentPost: () => urgentPost.get(),
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
    calendar,
    gettingStarted,
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
    ...createWorkTools({
      store,
      desk,
      markUrgent: (isUrgent) => {
        urgentPost.set(isUrgent);
      },
    }),
    ...calendar.tools,
    ...jobs.tools,
    ...mail.tools,
    ...gettingStarted.tools,
    {
      name: "show_getting_started",
      title: "Show what getting started found",
      audience: "hidden",
      description: "Finish a sample catch-up with a belief and a booking, for the demo.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      call: () => {
        if (gettingStarted.state().state === "done") return Promise.resolve({ text: "Getting started is done." });
        const start = toTimestamp(clock.now() + 25 * dayMs);
        const end = toTimestamp(clock.now() + 25 * dayMs + 2.5 * 60 * 60 * 1000);
        store.setOnboarding({ state: "reading", progress: { mails_read: 40, mails_total: 40 } });
        store.setOnboarding({
          state: "ready",
          proposal: {
            beliefs: [
              {
                id: identifiers.belief(),
                text: "You're training for a sub-20 5K, with parkrun on Saturdays.",
                page: "memory:now",
              },
            ],
            added: [
              {
                id: identifiers.calendarItem(),
                uid: `demo-flights-${start}@ito.local`,
                title: "Flights to Valencia",
                start,
                end,
                all_day: false,
                location: "Gatwick North",
                calendar: { name: "Home", kumo: false },
                status: "confirmed",
              },
            ],
            motions: [],
          },
        });
        return Promise.resolve({ text: "Showed what getting started found." });
      },
    },
    {
      name: "show_mail",
      title: "Show a sample mail's work",
      audience: "hidden",
      description: "Put a sample draft on the Desk and post a line, for the demo.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      call: () => {
        desk.addCard({
          kind: "draft",
          title: "Note to Hotel Orto",
          options: [{ label: "Drop it" }],
          allows_text: true,
          draft: {
            account: "icloud",
            from: "you@icloud.com",
            to: ["reservations@hotelorto.it"],
            subject: "Re: Booking confirmed: 20–23 November",
            body:
              "Hi! We land at 22:10 on the 20th, so we'll reach you around 23:00, after reception closes. Could " +
              "you leave the keys for us, or tell us how late check-in works? Thanks",
            message_id: `demo-${String(clock.now())}@ito.local`,
            in_reply_to: "confirm-48213@hotelorto.it",
          },
        });
        store.postMessage(
          "Hotel Orto confirmed you for 20–23 Nov. One snag: you land 22:10 and check-in closes 22:00, so I " +
            "drafted a note.",
        );
        return Promise.resolve({ text: "Put a sample draft on the Desk." });
      },
    },
    {
      name: "show_invite",
      title: "Show a sample invite",
      audience: "hidden",
      description: "Put a sample invite on the Desk, for the demo.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      call: () => {
        const start = toTimestamp(clock.now() + 26 * 60 * 60 * 1000);
        const end = toTimestamp(clock.now() + 27.5 * 60 * 60 * 1000);
        desk.addCard({
          kind: "invite",
          title: "QRT technical, tomorrow",
          options: [{ label: "Accept", acts: true }, { label: "Maybe" }, { label: "Decline" }],
          allows_text: false,
          invite: {
            event: {
              id: identifiers.calendarItem(),
              uid: `demo-${start}@ito.local`,
              title: "QRT technical",
              start,
              end,
              all_day: false,
              location: "Microsoft Teams",
              calendar: { name: "Home", kumo: false },
              status: "tentative",
            },
          },
        });
        return Promise.resolve({ text: "Put a sample invite on the Desk." });
      },
    },
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
  const noteRun = (tool: Tool): Tool => ({
    ...tool,
    call: (input) => {
      const run = contextRun();
      if (run !== undefined) touchedRuns.update((runs) => new Set([...runs, run]));
      return tool.call(input);
    },
  });
  const allTools = (): readonly Tool[] =>
    [...coreTools, ...doors.tools()].map((tool) => noteRun(withCheckedInput(tool)));
  const callTool = async (name: string, input: unknown, run?: string): Promise<ToolResult> => {
    const tool = allTools().find((candidate) => candidate.name === name);
    return tool
      ? inToolContext(run === undefined ? {} : { run }, () => tool.call(input))
      : { text: `Ito has no tool ${name}.`, isError: true };
  };
  store.subscribe(({ event }) => {
    if (event.type === "turn.ended") memory.indexConversation();
  });
  registerJobs(app, { jobs, schemas });
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
    jobs.close();
    gettingStarted.close();
    calendar.close();
    await mail.close();
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
    jobs,
    voice,
    calls,
    calendar,
    mail,
    callTool,
    close: () => {
      const pending = closing.get() ?? shutdown();
      closing.set(pending);
      return pending;
    },
  };
};
