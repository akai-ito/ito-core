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
import { createBackup, type Backup } from "#memory/backup.ts";
import type { GitHubHosts } from "#memory/github.ts";
import { createImageTool } from "#replies/images.ts";
import type { Fetch } from "#capabilities/connect.ts";
import { createCapabilityApprovals } from "#capabilities/approvals.ts";
import { createTopics } from "#topics/topics.ts";
import { createMemoryStore } from "#store/memory.ts";
import type { Tool, ToolResult } from "#tools/mcp.ts";
import { createGroups } from "#tools/groups.ts";
import { withCheckedInput } from "#tools/input.ts";
import { systemClock, toTimestamp, type Cancel, type Clock } from "#clock.ts";
import { codexVersion } from "#engine/codex/binary.ts";
import { readChoice, restartedDetail, type Engine, type ToolServer } from "#engine/engine.ts";
import { createApp } from "#http/app.ts";
import { createGate, createToken, tokenSetting } from "#http/auth.ts";
import { leadOf } from "#http/settings.ts";
import { registerTools, toolsPath } from "#http/tools.ts";
import { randomIdentifiers, type Identifiers } from "#identifiers.ts";
import { loadSchemas } from "#protocol/schemas.ts";
import { createAskTool } from "#asks/tool.ts";
import { createAttachments, type Attachments } from "#attachments/attachments.ts";
import { appleHosts, createApns, readApnsCredentials, type ApnsHosts } from "#notifications/apns.ts";
import { createNotifier } from "#notifications/notifier.ts";
import { openDatabase } from "#store/database.ts";
import { createStore, type Settings, type Store } from "#store/store.ts";
import { createTurns, defaultLimits, type Info, type Limits, type Log, type Turns } from "#turns/turns.ts";
import { packageVersion } from "#version.ts";
import type { Message, ModelChoice } from "#protocol/types.ts";
import type { Result } from "#result.ts";
import { toSpoken } from "#desk/day.ts";
import { createDesk } from "#desk/desk.ts";
import { createWorkTools } from "#work/tools.ts";
import { createCorrections } from "#work/corrections.ts";
import { createWakeUps, type WakeUps } from "#wakeups/wakeups.ts";
import { registerWakeUps } from "#http/wakeups.ts";
import { createWakeUpStore } from "#store/wakeups.ts";
import { createCalendarChanges } from "#calendar/changes.ts";
import { createPlaces } from "#places/places.ts";
import { createTracks } from "#work/tracks.ts";
import { createDeskLine } from "#desk/line.ts";
import { createGettingStarted } from "#onboarding/onboarding.ts";
import { createCalendar, type Calendar } from "#calendar/calendar.ts";
import { createCalendarSource, type CalendarSource } from "#calendar/caldav.ts";
import type { Values } from "#capabilities/manifest.ts";
import { toSources } from "#sources/sources.ts";
import { createContacts, type Contacts, type PersonPage } from "#contacts/contacts.ts";
import { createContactsSource, type ContactsSource } from "#contacts/carddav.ts";
import { contactsGroup } from "#contacts/group.ts";
import { mailGroup } from "#mail/group.ts";
import { parsePage, sectionOf, toAddress } from "#memory/pages.ts";
import { createMailbox, type CreateMailSource, type Mailbox } from "#mail/mail.ts";
import {
  calendarId,
  calendarProblem,
  capabilityProblem,
  contactsId,
  contactsProblem,
  createProblems,
  mailProblem,
  memoryBackupId,
  memoryBackupProblem,
  pushDeliveryId,
  pushDeliveryProblem,
  pushProblem,
  workId,
  workProblem,
  type Problems,
} from "#problems/problems.ts";
import { createQuickChoice, createStakesChoice } from "#engine/quick-model.ts";
import { createBlockStore } from "#day/blocks.ts";
import { createDayPicture } from "#day/picture.ts";
import { registerDay } from "#http/day.ts";
import { contextRun, inToolContext } from "#tools/context.ts";
import { createDemoTools } from "#demo/tools.ts";

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
  readonly createContactsSource?: (values: Values) => ContactsSource;
  readonly createMailSource?: CreateMailSource;
  readonly github?: GitHubHosts;
  readonly backupCheckMs?: number;
};

export type PushOptions = { readonly hosts: ApnsHosts };

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
  readonly backup: Backup;
  readonly motions: Motions;
  readonly wakeUps: WakeUps;
  readonly voice: VoiceLoop;
  readonly calls: Calls;
  readonly calendar: Calendar;
  readonly contacts: Contacts;
  readonly mail: Mailbox;
  readonly problems: Problems;
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

export const icloudContacts = (values: Values): ContactsSource =>
  createContactsSource({ appleId: textValue(values, "apple_id"), appPassword: textValue(values, "app_password") });

const motionSkill: OwnSkill = {
  id: "things-in-motion",
  summary:
    "starting and keeping things in motion, such as a trip, a job search, a dinner or a refund, and finding photos",
  text: readFileSync(new URL("../agent/motion.md", import.meta.url), "utf8"),
};

const dayMs = 24 * 60 * 60 * 1000;

const textRetentionMs = 30 * dayMs;
const latelyMessages = 6;
const latelyLength = 280;
const defaultHeartbeatMs = 15_000;

export const databaseFile = (dataDirectory: string): string => path.join(dataDirectory, "ito.db");

export const createServer = (options: ServerOptions): Server => {
  const clock = options.clock ?? systemClock;
  const identifiers = options.identifiers ?? randomIdentifiers;
  mkdirSync(options.dataDirectory, { recursive: true });
  const database = openDatabase(databaseFile(options.dataDirectory));
  const store = createStore(database, clock, identifiers);
  const places = createPlaces({
    settings: store,
    clock,
    fallback: options.timeZone ?? new Intl.DateTimeFormat().resolvedOptions().timeZone,
    fetch: options.fetch ?? fetch,
    setAmbient: (ambient) => {
      desk.setAmbient(ambient);
    },
    info: (message, details) => {
      info(message, details);
    },
  });
  // The time zone Kumo lives by: the latest their phone said.
  const timeZone = (): string => places.timeZone();
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
      const contactsChecked = await contacts.check(values);
      if (!contactsChecked.ok) return { problem: contactsChecked.failure };
      const kumo = await calendar.ensureKumo();
      const count = checked.value.calendars.filter(({ isKumo }) => !isKumo).length;
      return kumo.ok
        ? { summary: `Connected: Mail, Contacts and ${String(count)} calendars. Kumo's calendar added.` }
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
  const groups = createGroups({ groups: [mailGroup, contactsGroup], tools: () => allTools(), command: launcher });
  const skills = (): string =>
    writeOwnSkills(path.join(options.dataDirectory, "skills"), [motionSkill, ...groups.skills()]) +
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
    timeZone,
    workspace: path.join(options.dataDirectory, "workspace"),
    remote: {
      access: () => backup.access(),
      pushed: (outcome, remote) => {
        backup.pushed(outcome, remote);
      },
    },
  });
  const callContext = (): string => {
    const latest = store.latestCall();
    if (!latest) return "";
    return latest.ended_at === undefined
      ? `<call>\n${talkRules}\n</call>`
      : "<call>\nThe call has ended, so they're reading the chat. Write as usual, and don't say you've put " +
          "something in the chat: that's only for calls.\n</call>";
  };
  // The time where they are, and the weather there, so replies fit the moment.
  const nowText = (): string =>
    [
      "<now>",
      `It's ${toSpoken(clock.now(), timeZone())} where they are (${timeZone()}).`,
      ...[places.weatherText() ?? []].flat(),
      "</now>",
    ].join("\n");
  // The end of the conversation, for background work, which doesn't see the chat: what they said lately, and when.
  const latelyText = (): string => {
    const latest = store.latestMessages(latelyMessages);
    return latest.length === 0
      ? ""
      : [
          "<lately>",
          "The end of your conversation with them:",
          ...latest.map(
            ({ role, text, at }) =>
              `- ${toSpoken(Date.parse(at), timeZone())}, ${role === "user" ? "they" : "you"}: ` +
              (text.length > latelyLength ? `${text.slice(0, latelyLength)}…` : text).replaceAll(/\s+/gu, " "),
          ),
          "</lately>",
        ].join("\n");
  };
  // What background work has in mind: the same as a turn in the chat, without the call or getting started.
  const backgroundText = (): string =>
    [
      nowText(),
      memory.inMindText(),
      motions.inMindText(),
      wakeUps.inMindText(),
      tracks.inMindText(),
      deskLine.inMindText(),
      picture.inMindText(),
      latelyText(),
    ]
      .filter(Boolean)
      .join("\n\n");
  const engine = options.createEngine({
    settings: store,
    log,
    info,
    tools: toolServer,
    skills,
    instructions: () => voiceText.replaceAll("{lead}", () => leadOf(store)) + skills(),
    inMind: () =>
      [
        nowText(),
        memory.inMindText(),
        motions.inMindText(),
        wakeUps.inMindText(),
        tracks.inMindText(),
        deskLine.inMindText(),
        picture.inMindText(),
        gettingStarted.inMindText(),
        callContext(),
      ]
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
    trail: createTrail(host, launcher, groups),
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
  const listedModels = async (): ReturnType<Engine["models"]> => {
    await listening.get();
    return engine.models();
  };
  const topics = createTopics({ store, complete: quickComplete, models: listedModels, info });
  const touchedRuns = createCell<ReadonlySet<string>>(new Set());
  // One piece of Kumo's work in the background, under a run of its own unless it's given one. When the model can't
  // act, nothing stands in for it: the problem shows until a later piece of work goes through.
  const runWork = async (prompt: string, choice?: ModelChoice, given?: string): Promise<Result<string, string>> => {
    await listening.get();
    const attempt = async (retries: number): Promise<Result<string, string>> => {
      const run = given ?? randomUUID();
      const done = await engine.work(`${workRules}\n\n${backgroundText()}\n\n${prompt}`, run, choice);
      const isTouched = touchedRuns.get().has(run);
      touchedRuns.update((runs) => new Set([...runs].filter((other) => other !== run)));
      const isCutOff = !done.ok && done.failure === restartedDetail && !isTouched;
      return isCutOff && retries > 0 ? attempt(retries - 1) : done;
    };
    const done = await attempt(2);
    if (!done.ok) info("Kumo's background work didn't finish", { error: done.failure });
    problems.report(workId, done.ok ? { ok: true } : { ok: false, reason: done.failure, isAuth: false }, workProblem);
    return done;
  };
  // The runs Kumo messaged them in, so a wake-up can say it did.
  const postedRuns = createCell<ReadonlySet<string>>(new Set());
  // One part of their How to help you page, such as how they like their mail sorted.
  const howToHelp = (section: string): string => {
    const page = memory.page("memory:helping-you");
    return page.ok ? sectionOf(page.value.markdown, section) : "";
  };
  const desk = createDesk({ store, identifiers, clock, timeZone, work: runWork, info });
  const wakeUps = createWakeUps({
    store: createWakeUpStore(database),
    isMotion: (id) => store.findMotion(id) !== undefined,
    clock,
    timeZone,
    identifiers,
    work: (prompt, run) => runWork(prompt, undefined, run),
    postedIn: (run) => {
      const isPosted = postedRuns.get().has(run);
      postedRuns.update((runs) => new Set([...runs].filter((other) => other !== run)));
      return isPosted;
    },
    event: (uid) => calendar.listItems().find((item) => item.uid === uid && !item.calendar.kumo),
    desk,
    info,
  });
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
  const problems = createProblems({
    clock,
    standing: () => [
      ...(store.devices().length > 0 && readApnsCredentials(store) === undefined ? [pushProblem] : []),
      ...host.list().flatMap((capability) => capabilityProblem(capability) ?? []),
    ],
    publish: (current) => {
      store.setProblems(current);
    },
  });
  host.subscribe(() => {
    problems.refresh();
  });
  const backup = createBackup({
    memory,
    settings: store,
    fetch: fetcher,
    clock,
    info,
    directory: path.join(options.dataDirectory, "thread"),
    report: (health, toProblem) => {
      problems.report(memoryBackupId, health, toProblem);
    },
    toProblem: memoryBackupProblem,
    ...(options.github && { hosts: options.github }),
    ...(options.backupCheckMs !== undefined && { checkMs: options.backupCheckMs }),
  });
  // People pages in memory, with the contact each is linked to.
  const peoplePages = (): Promise<readonly PersonPage[]> =>
    memory.withThread((thread) =>
      Promise.resolve(
        thread
          .files()
          .filter((file) => file.startsWith("people/"))
          .map((file) => {
            const page = parsePage(thread.read(file) ?? "", file);
            return {
              address: toAddress(file),
              title: page.title,
              ...(page.gist !== undefined && { gist: page.gist }),
              ...(page.circle !== undefined && { circle: page.circle }),
              ...(page.contact !== undefined && { contact: page.contact }),
            };
          }),
      ),
    );
  const contacts = createContacts({
    host,
    store,
    desk,
    clock,
    timeZone,
    info,
    work: runWork,
    people: peoplePages,
    createSource: options.createContactsSource ?? icloudContacts,
    onHealth: (health) => {
      problems.report(contactsId, health, contactsProblem);
    },
  });
  const mail = createMailbox({
    host,
    store,
    desk,
    clock,
    fetch: fetcher,
    complete: quickComplete,
    quickChoice: createQuickChoice(listedModels),
    work: runWork,
    stakesChoice: createStakesChoice(listedModels, () => readChoice(store.setting)),
    matters: () =>
      motions
        .list()
        .filter(({ status }) => status === "active")
        .map(({ kind, title }) => `${title} (${kind})`),
    preferences: () => howToHelp("Sorting mail"),
    info,
    comingUp: () => store.desk().coming_up,
    onHealth: (account, health) => {
      problems.report(`mail:${account}`, health, mailProblem(account));
    },
    onReading: (at) => {
      desk.setLastMail(at);
    },
    ...(options.createMailSource && { createSource: options.createMailSource }),
    workspace: path.join(options.dataDirectory, "workspace"),
    contacts,
  });
  const calendar = createCalendar({
    host,
    desk,
    clock,
    timeZone,
    info,
    createSource: calendarSourceFor,
    onHealth: (health) => {
      problems.report(calendarId, health, calendarProblem);
    },
    enrich: (item) => picture.enrich(item),
  });
  const tracks = createTracks({ database, clock, identifiers, info });
  const picture = createDayPicture({
    blocks: createBlockStore(database),
    calendar,
    motions,
    desk,
    tracks,
    settings: store,
    clock,
    timeZone,
    info,
    lead: () => leadOf(store),
  });
  const calendarChanges = createCalendarChanges({
    calendar,
    settings: store,
    clock,
    timeZone,
    work: runWork,
    wakeUps,
    describe: wakeUps.describe,
    info,
  });
  const gettingStarted = createGettingStarted({
    store,
    identifiers,
    work: runWork,
    catchUp: mail.catchUp,
    mailAccounts: mail.accounts,
    onSources: (listener) => host.subscribe(listener),
    onAdded: calendar.onAdded,
    motionIds: () =>
      motions
        .list()
        .filter(({ status }) => status === "active")
        .map(({ id }) => id),
    info,
  });
  const push = { hosts: appleHosts, ...options.push };
  const apns = createApns(() => readApnsCredentials(store), push.hosts, clock);
  const notifier = createNotifier({
    store,
    apns,
    clock,
    agentName: () => leadOf(store),
    log,
    // Push that isn't set up at all is its own standing problem.
    onHealth: (health) => {
      problems.report(
        pushDeliveryId,
        readApnsCredentials(store) === undefined ? { ok: true } : health,
        pushDeliveryProblem,
      );
    },
  });
  const corrections = createCorrections({ store, desk, clock, work: runWork, tracks, info });
  const deskLine = createDeskLine({ store, desk, clock });
  // Their phone moved to another time zone: repeating wake-ups follow at once, and Kumo looks at the rest.
  places.onMoved((from, to) => {
    wakeUps.refit();
    void runWork(
      [
        `Their phone moved from ${from} to ${to}; it's ${toSpoken(clock.now(), to)} there.`,
        "Your repeating wake-ups already come back at their local times there. Move your other wake-ups and your",
        "blocks on Kumo's calendar that should follow their day, keep Now true about where they are, and message",
        "them only if something needs them, such as a call that now falls in their night.",
        "End with one line saying what you moved.",
      ].join("\n"),
    );
  });
  const post = (text: string, isUrgent: boolean): Message => {
    const run = contextRun();
    if (run !== undefined) postedRuns.update((runs) => new Set([...runs, run]));
    return store.postMessage(text, { isUrgent });
  };

  const app = createApp({
    store,
    turns,
    clock,
    schemas,
    info: { name: options.name, version: packageVersion() },
    gate: createGate(() => [store.setting(tokenSetting) ?? "", ...store.pairedTokenHashes()].filter(Boolean), clock),
    attachments,
    host,
    memory,
    backup,
    motions,
    voice,
    calls,
    voiceprints,
    models: () => engine.models(),
    heartbeatMs: options.heartbeatMs ?? defaultHeartbeatMs,
    desk,
    corrections,
    tracks,
    places,
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
    // A note that carries an error or a reason is something that went wrong: a warning, so
    // `ito logs --problems` finds it.
    if ("error" in details || "reason" in details) app.log.warn(details, message);
    else app.log.info(details, message);
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
    ...createWorkTools({ post, desk, isTrack: (id) => tracks.find(id) !== undefined }),
    ...tracks.tools,
    deskLine.tool,
    ...calendar.tools,
    ...picture.tools,
    ...contacts.tools,
    ...wakeUps.tools,
    ...mail.tools,
    ...gettingStarted.tools,
    ...createDemoTools({ store, desk, post, gettingStarted, identifiers, clock, timeZone }),
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
    [...coreTools, ...doors.tools()].map((tool) => groups.reporting(noteRun(withCheckedInput(tool))));
  const callTool = async (name: string, input: unknown, run?: string): Promise<ToolResult> => {
    const tool = allTools().find((candidate) => candidate.name === name);
    return tool
      ? inToolContext(run === undefined ? {} : { run }, () => tool.call(input))
      : { text: `Ito has no tool ${name}.`, isError: true };
  };
  store.subscribe(({ event }) => {
    if (event.type === "turn.ended") memory.indexConversation();
  });
  registerWakeUps(app, { wakeUps, schemas });
  registerDay(app, { picture, schemas });
  registerTools(app, {
    token: toolsToken,
    tools: allTools,
    command: (id, rest) => groups.command(id, rest) ?? doors.command(id, rest),
    version: packageVersion(),
  });

  const compaction = createCell<Cancel | undefined>(undefined);
  const compact = (): void => {
    store.compact(toTimestamp(clock.now() - textRetentionMs));
    attachments.sweep(toTimestamp(clock.now() - dayMs));
    compaction.set(clock.after(dayMs, compact));
  };
  compact();
  turns.recover();
  problems.start();
  backup.start();

  const shutdown = async (): Promise<void> => {
    compaction.get()?.();
    problems.close();
    await backup.close();
    motions.close();
    topics.close();
    desk.close();
    wakeUps.close();
    calendarChanges.close();
    places.close();
    gettingStarted.close();
    calendar.close();
    contacts.close();
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
    backup,
    motions,
    wakeUps,
    voice,
    calls,
    calendar,
    contacts,
    mail,
    problems,
    callTool,
    close: () => {
      const pending = closing.get() ?? shutdown();
      closing.set(pending);
      return pending;
    },
  };
};
