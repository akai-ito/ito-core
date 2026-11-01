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
import { leadOf, notBeforeOf } from "#http/settings.ts";
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
import type { DoneEntry, ModelChoice } from "#protocol/types.ts";
import type { Result } from "#result.ts";
import { toLocal } from "#desk/day.ts";
import { createDesk } from "#desk/desk.ts";
import { createMoments } from "#desk/moments.ts";
import { createWorkTools } from "#work/tools.ts";
import { createTrust, sectionOf, type Trust } from "#work/trust.ts";
import { createJobs, type Jobs } from "#jobs/jobs.ts";
import { registerJobs } from "#http/jobs.ts";
import { createJobStore } from "#store/jobs.ts";
import { createGettingStarted } from "#onboarding/onboarding.ts";
import { createCalendar, type Calendar } from "#calendar/calendar.ts";
import { createCalendarSource, type CalendarSource } from "#calendar/caldav.ts";
import type { Values } from "#capabilities/manifest.ts";
import { toSources } from "#sources/sources.ts";
import { createContacts, type Contacts, type PersonPage } from "#contacts/contacts.ts";
import { createContactsSource, type ContactsSource } from "#contacts/carddav.ts";
import { contactsGroup } from "#contacts/group.ts";
import { mailGroup } from "#mail/group.ts";
import { parsePage, toAddress } from "#memory/pages.ts";
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
  pushProblem,
  type Problems,
} from "#problems/problems.ts";
import { createModestChoice, createQuickChoice, createStakesChoice } from "#engine/quick-model.ts";
import { createBlockStore } from "#day/blocks.ts";
import { createCheckins, type DemoCheckin } from "#day/checkins.ts";
import { createNights } from "#day/nights.ts";
import { createDayPicture, type DayPicture } from "#day/picture.ts";
import { createQuestions } from "#day/questions.ts";
import { createStatus } from "#day/status.ts";
import { registerStatus } from "#http/status.ts";
import { toSpoken } from "#desk/day.ts";
import { sampleDay } from "#day/samples.ts";
import { registerDay } from "#http/day.ts";
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
  readonly createContactsSource?: (values: Values) => ContactsSource;
  readonly createMailSource?: CreateMailSource;
  readonly github?: GitHubHosts;
  readonly backupCheckMs?: number;
  // Picks the trust ladder's spot checks; a test fixes it.
  readonly random?: () => number;
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
  readonly backup: Backup;
  readonly motions: Motions;
  readonly jobs: Jobs;
  readonly voice: VoiceLoop;
  readonly calls: Calls;
  readonly calendar: Calendar;
  readonly contacts: Contacts;
  readonly mail: Mailbox;
  readonly problems: Problems;
  readonly trust: Trust;
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

const demoMail = (subject: string): NonNullable<DoneEntry["mail"]> => ({
  account: "icloud",
  message_id: `demo-${randomUUID()}@acme.com`,
  from: "Acme",
  subject,
});
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
    timeZone: options.timeZone ?? new Intl.DateTimeFormat().resolvedOptions().timeZone,
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
  const zone = options.timeZone ?? new Intl.DateTimeFormat().resolvedOptions().timeZone;
  const statusCell = createCell<() => readonly string[]>(() => []);
  // The time and what Kumo knows they're doing now, so replies fit the moment.
  const nowText = (): string =>
    ["<now>", `It's ${toSpoken(clock.now(), zone)}.`, ...statusCell.get()(), "</now>"].join("\n");
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
        jobs.inMindText(),
        trust.inMindText(),
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
  const runWork = async (prompt: string, choice?: ModelChoice): Promise<Result<string, string>> => {
    await listening.get();
    const attempt = async (retries: number): Promise<Result<string, string>> => {
      const run = randomUUID();
      const done = await engine.work(`${workRules}\n\n${prompt}`, run, choice);
      const isTouched = touchedRuns.get().has(run);
      touchedRuns.update((runs) => new Set([...runs].filter((other) => other !== run)));
      const isCutOff = !done.ok && done.failure === restartedDetail && !isTouched;
      return isCutOff && retries > 0 ? attempt(retries - 1) : done;
    };
    const done = await attempt(2);
    if (!done.ok) info("Kumo's background work didn't finish", { error: done.failure });
    return done;
  };
  const timeZone = zone;
  // One part of their How to help you page, such as how they like their mail sorted.
  const howToHelp = (section: string): string => {
    const page = memory.page("memory:helping-you");
    return page.ok ? sectionOf(page.value.markdown, section) : "";
  };
  const desk = createDesk({ store, identifiers, clock, timeZone, work: runWork, info });
  const jobs = createJobs({
    store: createJobStore(database),
    isMotion: (id) => store.findMotion(id) !== undefined,
    clock,
    identifiers,
    work: runWork,
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
  const presence = createPresence();
  const listedModels = async (): ReturnType<Engine["models"]> => {
    await listening.get();
    return engine.models();
  };
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
  const pictureCell = createCell<DayPicture | undefined>(undefined);
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
    enrich: (item) => pictureCell.get()?.enrich(item) ?? item,
  });
  const nights = createNights(store, timeZone);
  const questions = createQuestions(store, clock, timeZone);
  const status = createStatus(store, clock, timeZone, nights);
  statusCell.set(status.lines);
  const picture = createDayPicture({
    blocks: createBlockStore(database),
    calendar,
    motions,
    nights,
    settings: store,
    clock,
    timeZone,
    work: runWork,
    info,
    lead: () => leadOf(store),
    morning: () => notBeforeOf(store),
    now: status.lines,
  });
  pictureCell.set(picture);
  calendar.onEventEnded((uid) => {
    jobs.onEventEnded(uid);
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
  const isBusy = (): boolean => calendar.isBusy();
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
  const moments = createMoments({
    store,
    desk,
    clock,
    timeZone,
    presence,
    complete: quickComplete,
    choice: createModestChoice(listedModels, () => readChoice(store.setting)),
    isBusy,
    isGettingStarted: () => gettingStarted.state().state !== "done",
    identifiers,
    lead: () => leadOf(store),
    notify: notifier.moment,
    info,
    beforeDay: () => picture.plan(),
    now: status.lines,
  });
  const checkins = createCheckins({
    store,
    clock,
    timeZone,
    presence,
    isBusy,
    isGettingStarted: () => gettingStarted.state().state !== "done",
    nights,
    picture,
    questions,
    moments,
    complete: quickComplete,
    choice: createModestChoice(listedModels, () => readChoice(store.setting)),
    work: runWork,
    motions,
    lead: () => leadOf(store),
    morning: () => notBeforeOf(store),
    info,
    now: status.lines,
    likely: status.likely,
    isAsleep: status.isAsleep,
  });
  const trust = createTrust({
    store,
    desk,
    clock,
    timeZone,
    tell: moments.tell,
    work: runWork,
    isGettingStarted: () => gettingStarted.state().state !== "done",
    ...(options.random && { random: options.random }),
    info,
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
    backup,
    motions,
    voice,
    calls,
    voiceprints,
    models: () => engine.models(),
    heartbeatMs: options.heartbeatMs ?? defaultHeartbeatMs,
    desk,
    trust,
    timeZone,
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
  // A made-up day for the demo: what Kumo did, where it stands on the ladder, and a card to glance at.
  const showWork = (): void => {
    const filed = { kind: "mail_filed", account: "icloud", id: "demo", back: "inbox" };
    const cleared = [
      ["Bank statement", "Routine, nothing due"],
      ["CI passed on ito-core", "You saw it on the PR"],
      ["Weekly running summary", "Nothing new"],
      ["Water bill", "Direct debit, nothing to do"],
      ["Daily digest from Acme", "You rarely open these"],
      ["Leo: “ha, see you there”", "A reply, no action"],
    ] as const;
    const clearedToday = Array.from({ length: 38 }, (_, at) => cleared[at % cleared.length] ?? cleared[0]);
    for (const [text, reason] of clearedToday) desk.addDone({ text, reason, mail: demoMail(text), quiet: true });
    const handled = [
      { text: "Drafted a thank-you to Tess Harlow at Halcyon", reason: "She sent the next steps.", work: "drafts" },
      { text: "Drafted a reply to Clara Voss at Northwind", reason: "She asked for times next week.", work: "drafts" },
      { text: "Northwind: Clara's note → Job search", reason: "A reply to yours; nothing to answer yet." },
      { text: "Climbing with Leo → your calendar, 20:00", reason: "Leo confirmed by mail.", work: "calendar" },
      { text: "Acme Pizza promos: unsubscribed, binned", reason: "You haven't opened one since March." },
      {
        text: "Quillfield Dental moved to Fri 13, 9:30",
        reason: "Their mail confirmed the new time.",
        work: "calendar",
      },
      { text: "Electricity bill → Admin, due 14 Nov", reason: "A bill with a date on it; a reminder's set." },
    ] as const;
    for (const entry of handled.toReversed()) {
      desk.addDone({
        text: entry.text,
        reason: entry.reason,
        quiet: false,
        ...("work" in entry ? { work: entry.work } : { mail: demoMail(entry.text), undo: filed }),
      });
    }
    const daysAgo = (days: number): string => toTimestamp(clock.now() - days * dayMs);
    trust.hold("sorting", { step: "trusted", since: daysAgo(1), change: { kind: "climb", days: 15 } });
    trust.hold("calendar", {
      step: "spot_checks",
      since: daysAgo(2),
      change: { kind: "corrected", quote: "Quillfield Dental moved to Thu 12", at: daysAgo(2), stepped: true },
    });
    trust.hold("drafts", { step: "learning", since: daysAgo(9), change: { kind: "start" } });
    trust.review(toLocal(clock.now(), timeZone).day, "Today");
  };
  const coreTools: readonly Tool[] = [
    createAskTool(turns),
    imageTool,
    ...memory.tools,
    ...motions.tools,
    ...createWorkTools({ post: moments.tell, desk }),
    ...trust.tools,
    ...calendar.tools,
    ...picture.tools,
    questions.tool,
    status.tool,
    ...contacts.tools,
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
      description: "Read a sample mail: put a draft on the Desk and tell them about it, for the demo.",
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
        desk.setLastMail(toTimestamp(clock.now()));
        moments.tell(
          "Hotel Orto confirmed you for 20–23 Nov. One snag: you land 22:10 and check-in closes 22:00, so I " +
            "drafted a note.",
          false,
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
          title: "Halcyon technical, tomorrow",
          options: [{ label: "Accept", acts: true }, { label: "Maybe" }, { label: "Decline" }],
          allows_text: false,
          invite: {
            event: {
              id: identifiers.calendarItem(),
              uid: `demo-${start}@ito.local`,
              title: "Halcyon technical",
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
      name: "show_work",
      title: "Show a sample day of Kumo's work",
      audience: "hidden",
      description: "Fill today's Done and the trust ladder with a sample day, and a card to glance at, for the demo.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      call: () => {
        showWork();
        return Promise.resolve({ text: "Filled today's work with a sample day." });
      },
    },
    {
      name: "show_day",
      title: "Show a sample day",
      audience: "hidden",
      description:
        "Put a sample day, Kumo's plan and its guesses, in Coming up, then write the day's line, for the demo.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      call: async () => {
        desk.setComingUp(sampleDay(clock.now(), timeZone, identifiers));
        await moments.dayNow();
        return { text: "Showed a sample day." };
      },
    },
    {
      name: "show_checkin",
      title: "Show a check-in",
      audience: "hidden",
      description: "Show one of Kumo's check-ins now, whatever the time, for the demo.",
      inputSchema: {
        type: "object",
        properties: { kind: { enum: ["commit", "pre", "past", "question", "drift"] } },
        required: ["kind"],
        additionalProperties: false,
      },
      call: async (input) => {
        const said = await checkins.show((input as { readonly kind: DemoCheckin }).kind);
        return { text: said === "" ? "Nothing to say." : `Said: ${said}` };
      },
    },
    {
      name: "moment_now",
      title: "Write Kumo's line now",
      audience: "hidden",
      description: "Write Kumo's first line of the day now, whatever the time, for the demo.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      call: async () => {
        await moments.dayNow();
        return { text: "Wrote Kumo's line." };
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
  registerJobs(app, { jobs, schemas });
  registerDay(app, { picture, schemas });
  registerStatus(app, { status, schemas });
  registerTools(app, {
    token: toolsToken,
    tools: allTools,
    command: (id, rest) => groups.command(id, rest) ?? doors.command(id, rest),
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
  problems.start();
  backup.start();

  const shutdown = async (): Promise<void> => {
    compaction.get()?.();
    problems.close();
    await backup.close();
    motions.close();
    topics.close();
    checkins.close();
    moments.close();
    trust.close();
    jobs.close();
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
    jobs,
    voice,
    calls,
    calendar,
    contacts,
    mail,
    problems,
    trust,
    callTool,
    close: () => {
      const pending = closing.get() ?? shutdown();
      closing.set(pending);
      return pending;
    },
  };
};
