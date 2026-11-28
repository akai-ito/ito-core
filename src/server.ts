import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance, FastifyServerOptions } from "fastify";
import { createAccess } from "#access/access.ts";
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
import { createMadePages } from "#made/made.ts";
import type { Fetch } from "#capabilities/connect.ts";
import { createCapabilityApprovals } from "#capabilities/approvals.ts";
import { createNaming } from "#threads/naming.ts";
import { createThreads } from "#threads/threads.ts";
import { createLanes, type Lanes } from "#threads/lanes.ts";
import { createShares, type Shares } from "#shares/shares.ts";
import { toThreadId, type ThreadId } from "#conversation/ids.ts";
import { createMemoryStore } from "#store/memory.ts";
import type { Tool, ToolResult } from "#tools/mcp.ts";
import { createGroups } from "#tools/groups.ts";
import { withCheckedInput } from "#tools/input.ts";
import { systemClock, toTimestamp, type Cancel, type Clock } from "#clock.ts";
import { codexVersion } from "#engine/codex/binary.ts";
import { readChoice, type Engine, type ToolServer } from "#engine/engine.ts";
import { createApp } from "#http/app.ts";
import { createGate, createToken, tokenSetting } from "#http/auth.ts";
import { leadOf } from "#http/settings.ts";
import { registerTools, toolsPath } from "#http/tools.ts";
import { randomIdentifiers, type Identifiers } from "#identifiers.ts";
import { loadSchemas } from "#protocol/schemas.ts";
import { createAskTool } from "#asks/tool.ts";
import { createAttachments, type Attachments } from "#attachments/attachments.ts";
import {
  createUploads,
  defaultLimits as defaultUploadLimits,
  type Limits as UploadLimits,
} from "#attachments/uploads.ts";
import { createRecordings, type Recordings } from "#recordings/recordings.ts";
import { createRecordingTools } from "#recordings/tools.ts";
import { createShownFiles, type ShownFiles } from "#files/files.ts";
import { appleHosts, createApns, readApnsCredentials, type ApnsHosts } from "#notifications/apns.ts";
import { createNotifier } from "#notifications/notifier.ts";
import { openDatabase } from "#store/database.ts";
import { createStore, type Settings, type Store } from "#store/store.ts";
import { defaultLimits, type Info, type Limits, type Log } from "#turns/turns.ts";
import { createBackground, whenWords, type Background } from "#turns/background.ts";
import { packageVersion } from "#version.ts";
import type { Message, ModelChoice } from "#protocol/types.ts";
import { fail, type Result } from "#result.ts";
import { toSpoken } from "#desk/day.ts";
import { createDesk } from "#desk/desk.ts";
import { createWorkTools, type PostPlace } from "#work/tools.ts";
import { createCorrections } from "#work/corrections.ts";
import { createWakeUps, type WakeUps } from "#wakeups/wakeups.ts";
import { registerWakeUps } from "#http/wakeups.ts";
import { createWakeUpStore } from "#store/wakeups.ts";
import { createCalendarChanges } from "#calendar/changes.ts";
import { createPlaces } from "#places/places.ts";
import { createTracks } from "#work/tracks.ts";
import { createQuestions } from "#work/questions.ts";
import { registerUnderstanding } from "#http/understanding.ts";
import { registerPeople } from "#http/people.ts";
import { createPeople, type PeopleKeeper } from "#people/people.ts";
import { createSenders } from "#people/senders.ts";
import { registerLocation } from "#http/location.ts";
import { createLocation } from "#location/location.ts";
import { createComingsAndGoings } from "#location/events.ts";
import { createPlaceTools, whereaboutsText, type PlaceToolsOptions } from "#location/tools.ts";
import { createPeoplePlaces } from "#location/people.ts";
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
import { chaptersSkill } from "#memory/chapters.ts";
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
  pausedProblem,
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
import { createToday } from "#day/today.ts";
import { registerDay } from "#http/day.ts";
import { contextRun, contextThread, inToolContext, isDreamRun } from "#tools/context.ts";
import { createDemoTools } from "#demo/tools.ts";
import { createBrowserHand } from "#hands/browser.ts";
import { createDayNotes } from "#dream/notes.ts";
import { createDreams, dreamInstructions, type Dreams } from "#dream/dream.ts";
import { createDreamStore } from "#store/dreams.ts";
import { registerDream } from "#http/dream.ts";

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
  // The largest big upload of each kind, and the largest chunk; ITO_MAX_RECORDING_MB and ITO_MAX_FILE_MB set them.
  readonly uploadLimits?: Partial<UploadLimits>;
  readonly freeBytes?: (directory: string) => number;
  // Whether Kumo dreams by itself each night at the dream time; `ito serve` turns it on. Dream now works either way.
  readonly dreams?: boolean;
};

export type PushOptions = { readonly hosts: ApnsHosts };

export type EngineContext = {
  readonly settings: Settings;
  readonly log: Log;
  readonly info: Info;
  readonly tools: () => ToolServer | undefined;
  readonly skills: () => string;
  readonly instructions: () => string;
  // What a turn has in mind, in the main chat or in a side thread.
  readonly inMind: (thread?: ThreadId) => string;
  readonly callTool: (name: string, input: unknown, run?: string, thread?: string) => Promise<ToolResult>;
};

export type Server = {
  readonly app: FastifyInstance;
  readonly store: Store;
  readonly turns: Lanes;
  readonly shares: Shares;
  readonly attachments: Attachments;
  readonly recordings: Recordings;
  readonly files: ShownFiles;
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
  readonly background: Background;
  readonly dreams: Dreams;
  readonly callTool: (name: string, input: unknown, run?: string, thread?: string) => Promise<ToolResult>;
  readonly close: () => Promise<void>;
};

const voiceText = readFileSync(new URL("../agent/instructions.md", import.meta.url), "utf8");

const talkRules = readFileSync(new URL("../agent/talk.md", import.meta.url), "utf8").trim();

const workRules = readFileSync(new URL("../agent/work.md", import.meta.url), "utf8").trim();

// Ito's own checkout, which Kumo may change with full access.
const checkout = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/u, "");

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
    "starting, keeping and honestly ending things in motion, such as a role, a training block or a trip, and finding photos",
  text: readFileSync(new URL("../agent/motion.md", import.meta.url), "utf8"),
};

const reviewSkill: OwnSkill = {
  id: "review-and-approve",
  summary:
    "debriefing a recording they sent, proposing changes as rows they approve one by one, and showing a file " +
    "for review before it goes in a draft",
  text: readFileSync(new URL("../agent/review.md", import.meta.url), "utf8"),
};

const memoryStyleSkill: OwnSkill = {
  id: "memory-style",
  summary:
    "how memory pages and the journal should read: second person on pages, first person in the journal, no " +
    "disclaimers or process notes, and summaries rather than raw data",
  text: readFileSync(new URL("../agent/memory-style.md", import.meta.url), "utf8"),
};

const ownSkills: readonly OwnSkill[] = [motionSkill, chaptersSkill, reviewSkill, memoryStyleSkill];

const dayMs = 24 * 60 * 60 * 1000;

const textRetentionMs = 30 * dayMs;
const mailCorrectionsMs = 14 * dayMs;
const mailCorrections = 5;
const defaultHeartbeatMs = 15_000;
// A dream is a background run with time to think: up to an hour, as long as it shows life.
const dreamBudgetMs = 60 * 60 * 1000;

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
    writeOwnSkills(path.join(options.dataDirectory, "skills"), [...ownSkills, ...groups.skills()]) +
    writeSkills(path.join(options.dataDirectory, "skills"), host.offered(), launcher);
  const memory = createMemory({
    directory: path.join(options.dataDirectory, "thread"),
    store: createMemoryStore(database),
    settings: store,
    clock,
    identifiers,
    embedder: options.embedder,
    recordStep: (facts) => turns.recordStep("memory", facts),
    // A dream has full authority over memory, such as forgetting a page it merged into another: Done can bring it
    // back. Anywhere else, forgetting a page asks them.
    approve: (fields) => (isDreamRun(contextRun()) ? Promise.resolve(true) : turns.approve(fields)),
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
  // Today so far, across the main chat and every thread, with what Kumo did and what's next: in every turn and every
  // piece of background work, so each joins the day up.
  const today = createToday({
    store,
    clock,
    timeZone,
    wakeUps: () => wakeUps.list(),
    calendar: () => calendar.listItems(),
  });
  // What background work has in mind: the same as a turn in the chat, without the call or getting started, and with
  // all of today so far, since it doesn't see the chat. A dream leaves today out: its own digest reads everything since
  // the last dream.
  const backgroundText = (run?: string): string =>
    [
      nowText(),
      access.inMindText(),
      isDreamRun(run) ? "" : today.text(),
      memory.inMindText(),
      motions.inMindText(),
      made.inMindText(),
      wakeUps.inMindText(),
      tracks.inMindText(),
      questions.inMindText(),
      deskLine.inMindText(),
      desk.inMindText(),
      picture.inMindText(),
      recordings.inMindText(),
      threads.backgroundText(),
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
    inMind: (thread) =>
      [
        threads.inMindText(thread),
        nowText(),
        today.text({ thread }),
        memory.inMindText(),
        motions.inMindText(),
        made.inMindText(),
        wakeUps.inMindText(),
        tracks.inMindText(),
        questions.inMindText(),
        deskLine.inMindText(),
        desk.inMindText(),
        picture.inMindText(),
        recordings.inMindText(),
        gettingStarted.inMindText(),
        access.inMindText(),
        callContext(),
      ]
        .filter(Boolean)
        .join("\n\n"),
    callTool: (name, input, run, thread) => callTool(name, input, run, thread),
  });
  const threads = createThreads({
    store,
    spoken: (at) => toSpoken(Date.parse(at), timeZone()),
    branched: (thread, moved, brief) => turns.branched(thread, moved, brief),
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
  const uploads = createUploads({
    directory: path.join(options.dataDirectory, "uploads"),
    attachments,
    clock,
    ...(options.uploadLimits && { limits: options.uploadLimits }),
    ...(options.freeBytes && { freeBytes: options.freeBytes }),
  });
  const turns = createLanes({
    store,
    engine,
    clock,
    identifiers,
    log,
    turns: {
      limits: options.limits ?? defaultLimits,
      attachmentPath: attachments.pathOf,
      trail: createTrail(host, launcher, groups),
      moreNotes: () => motions.tickNote(),
    },
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
  const made = createMadePages({ store, schemas, clock, timeZone, approve: (fields) => turns.approve(fields) });
  const quickComplete: Engine["complete"] = async (prompt, schema, choice, images) => {
    await listening.get();
    return engine.complete(prompt, schema, choice, images);
  };
  const listedModels = async (): ReturnType<Engine["models"]> => {
    await listening.get();
    return engine.models();
  };
  const naming = createNaming({ store, complete: quickComplete, models: listedModels, info });
  // What they share from their phone's share sheet: Kumo puts each in the thread it belongs in, which answers it.
  const shares = createShares({
    store,
    fetch: fetcher,
    complete: quickComplete,
    quickChoice: createQuickChoice(listedModels),
    attachmentPath: attachments.pathOf,
    spoken: (at) => toSpoken(Date.parse(at), timeZone()),
    route: (message, text) => {
      turns.route(message, text);
    },
    info,
  });
  // Kumo's work in the background: a backstop on silence, one retry, and a pause through a usage limit with one
  // catch-up after. When the model can't act, nothing stands in for it: the problem shows until work goes through.
  const background = createBackground({
    engine,
    clock,
    settings: store,
    info,
    timeZone,
    ready: () => listening.get(),
    frame: (prompt, run) => `${workRules}\n\n${backgroundText(run)}\n\n${prompt}`,
    wakeUps: () => wakeUps,
    post: (text) => {
      store.postMessage(text);
    },
    report: (health) => {
      problems.report(workId, health, workProblem);
    },
    onPause: () => {
      problems.refresh();
    },
  });
  // Background work that, while Kumo's paused, the catch-up takes in once under this line.
  const workFor =
    (missed: string) =>
    (prompt: string, choice?: ModelChoice): Promise<Result<string, string>> =>
      background.work(prompt, { missed, ...(choice && { choice }) });
  // The runs Kumo messaged them in, so a wake-up can say it did.
  const postedRuns = createCell<ReadonlySet<string>>(new Set());
  // One part of their How to help you page, such as how they like their mail sorted.
  const howToHelp = (section: string): string => {
    const page = memory.page("memory:helping-you");
    return page.ok ? sectionOf(page.value.markdown, section) : "";
  };
  // How they like their mail sorted: How to help you's part on it, and their corrections on mail lately, which are
  // evidence on Kumo's tracks until the dream distils what lasts into How to help you.
  const mailPreferences = (): string => {
    const lately = tracks
      .evidenceSince(toTimestamp(clock.now() - mailCorrectionsMs))
      .filter(
        ({ evidence: { kind, done } }) =>
          kind === "corrected" && done !== undefined && store.findDone(done)?.entry.mail !== undefined,
      )
      .slice(0, mailCorrections)
      .map(({ evidence }) => `- ${evidence.text}`);
    return [howToHelp("Sorting mail"), ...(lately.length === 0 ? [] : ["Lately they said:", ...lately])]
      .filter(Boolean)
      .join("\n");
  };
  const desk = createDesk({
    store,
    identifiers,
    clock,
    timeZone,
    work: workFor("Answers they gave on the Desk, which went back on it"),
    info,
  });
  const access = createAccess({
    store,
    addDone: (entry) => desk.addDone(entry),
    clock,
    info,
    spoken: (at) => toSpoken(at, timeZone()),
    checkout,
  });
  const wakeUps = createWakeUps({
    store: createWakeUpStore(database),
    isMotion: (id) => store.findMotion(id) !== undefined,
    clock,
    timeZone,
    identifiers,
    work: (prompt, run) => background.work(prompt, { run }),
    postedIn: (run) => {
      const isPosted = postedRuns.get().has(run);
      postedRuns.update((runs) => new Set([...runs].filter((other) => other !== run)));
      return isPosted;
    },
    event: (uid) => calendar.listItems().find((item) => item.uid === uid && !item.calendar.kumo),
    desk,
    info,
    isHolding: () => background.isHolding(),
  });
  const voiceprints = createVoiceprints(path.join(options.dataDirectory, "voice", "voiceprint.json"));
  const files = createShownFiles({
    database,
    attachments,
    store,
    newAttachment: () => identifiers.attachment(),
    workspace: path.join(options.dataDirectory, "workspace"),
    maxBytes: options.uploadLimits?.fileBytes ?? defaultUploadLimits.fileBytes,
    clock,
  });
  const recordings = createRecordings({
    database,
    store,
    attachments,
    voice,
    voiceprint: () => voiceprints.load(),
    work: workFor("Recordings they sent that you hadn't read yet"),
    workspace: path.join(options.dataDirectory, "workspace"),
    clock,
    info,
  });
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
      ...[background.paused() ?? []]
        .flat()
        .map(({ until, isKnown }) => pausedProblem(whenWords(until, clock.now(), timeZone()), isKnown)),
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
  const senders = createSenders(database);
  // People, made once Kumo's day notes are: answers to contact questions reach it through here.
  const peopleCell = createCell<PeopleKeeper | undefined>(undefined);
  const contacts = createContacts({
    host,
    store,
    desk,
    clock,
    timeZone,
    info,
    work: workFor("Dates coming up in their contacts, such as birthdays"),
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
    work: workFor("Mail they got or sent: look through their inboxes and Sent"),
    stakesChoice: createStakesChoice(listedModels, () => readChoice(store.setting)),
    matters: () =>
      motions
        .list()
        .filter(({ status }) => status === "active")
        .map(({ kind, title }) => `${title} (${kind})`),
    preferences: mailPreferences,
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
    onSender: (name, address) => {
      senders.record(name, address, toTimestamp(clock.now()));
    },
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
  const tracks = createTracks({ database, clock, identifiers, info, timeZone });
  // Places: where they've been, from their phone while places are on, with the places, home, trips and heat.
  const location = createLocation({
    database,
    clock,
    timeZone,
    newPlace: () => identifiers.place(),
    closeQuestion: (place, note, state) => {
      questions.closePlace(place, note, state);
    },
    info,
  });
  const placeTools: PlaceToolsOptions = { location, now: () => clock.now(), timeZone };
  const questions = createQuestions({
    database,
    store,
    attachments,
    voice,
    tracks,
    clock,
    identifiers,
    work: workFor("Answers they gave in Understanding you"),
    contactAnswered: (question) =>
      peopleCell.get()?.answered(question) ?? Promise.resolve(fail("People isn't running yet.")),
    places: {
      ask: (place) => location.askAbout(place),
      named: (place, name) => {
        location.named(place, name);
      },
    },
    info,
  });
  const blocks = createBlockStore(database);
  const picture = createDayPicture({
    blocks,
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
    work: workFor("Changes on their calendars"),
    wakeUps,
    describe: wakeUps.describe,
    info,
  });
  // Arriving at a place and leaving it are events, as a mail is: Kumo looks, and mostly stays quiet.
  const comingsAndGoings = createComingsAndGoings({
    location,
    clock,
    timeZone,
    work: workFor("Places they came and went"),
    eventsDuring: (from, to) =>
      calendar
        .agenda()
        .filter((entry) => !entry.allDay && Date.parse(entry.start) < to && Date.parse(entry.end) > from)
        .map(({ title, location: at }) => ({ title, ...(at !== undefined && { location: at }) })),
    isAsked: (place) => questions.isAsked(place),
    info,
  });
  const gettingStarted = createGettingStarted({
    store,
    identifiers,
    work: workFor("Getting started"),
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
  // Kumo's dream: once a day it looks back over everything since the last one and puts it in order. During the day
  // Kumo only keeps notes for it.
  const dayNotes = createDayNotes({ database, clock, timeZone });
  const people = createPeople({
    memory,
    contacts,
    questions,
    tracks,
    store,
    senders,
    calendar,
    wakeUps,
    dayNotes,
    clock,
    timeZone,
    ...createPeoplePlaces(location, clock, timeZone),
    info,
  });
  peopleCell.set(people);
  const dreams = createDreams({
    store: createDreamStore(database),
    settings: store,
    clock,
    timeZone,
    newId: () => identifiers.dream(),
    work: (prompt, run) => background.work(prompt, { run, budgetMs: dreamBudgetMs }),
    notes: dayNotes,
    sources: {
      messagesSince: (at, limit) => store.messagesSince(at, limit).toReversed(),
      thread: (id) => store.findThread(toThreadId(id)),
      doneSince: (at) => store.doneSince(at),
      mailSince: (since) => mail.readSince(since),
      calendar: () => calendar.listItems().map((item) => picture.enrich(item)),
      trackEvidence: (since) => tracks.evidenceText(since),
      attachmentPath: (id) => attachments.pathOf(id),
      whereabouts: (since) => whereaboutsText(placeTools, since),
    },
    changes: {
      versionOf: (address) => memory.versionOf(address),
      titleOf: (address) => {
        const page = memory.page(address);
        return page.ok ? page.value.title : undefined;
      },
      revert: (address, version, note) => memory.revert(address, version, note),
      wakeUps: () => wakeUps.list(),
      putWakeUp: (wakeUp) => wakeUps.put(wakeUp),
      cancelWakeUp: (id) => wakeUps.cancel(id),
      block: (uid) => blocks.find(uid),
    },
    desk,
    findDone: (id) => store.findDone(id),
    publish: (dream) => {
      store.recordDream(dream);
    },
    progress: (step) => {
      store.recordDreamStep(step);
    },
    instructions: dreamInstructions,
    workspace: path.join(options.dataDirectory, "workspace"),
    info,
    isScheduled: options.dreams === true,
  });
  const corrections = createCorrections({
    store,
    desk,
    clock,
    work: workFor("What they told you was wrong in your work"),
    tracks,
    info,
  });
  const deskLine = createDeskLine({ store, desk, clock });
  // Their phone moved to another time zone: repeating wake-ups follow at once, and Kumo looks at the rest.
  places.onMoved((from, to) => {
    wakeUps.refit();
    dreams.refit();
    void background.work(
      [
        `Their phone moved from ${from} to ${to}; it's ${toSpoken(clock.now(), to)} there.`,
        "Your repeating wake-ups already come back at their local times there. Move your other wake-ups and your",
        "blocks on Kumo's calendar that should follow their day, keep Now true about where they are, and message",
        "them only if something needs them, such as a call that now falls in their night.",
        "End with one line saying what you moved.",
      ].join("\n"),
      { missed: `A move from ${from} to ${to}` },
    );
  });
  const post = (text: string, isUrgent: boolean, place: PostPlace = {}): Message | undefined => {
    const existing = place.thread === undefined ? undefined : store.findThread(toThreadId(place.thread));
    if (!existing && place.thread !== undefined) return undefined;
    const thread = place.newThread === undefined ? existing : store.startThread("kumo", place.newThread);
    const run = contextRun();
    if (run !== undefined) postedRuns.update((runs) => new Set([...runs, run]));
    const message = store.postMessage(text, { isUrgent, ...(thread && { thread: toThreadId(thread.id) }) });
    dreams.posted(run, message);
    return message;
  };

  // Kumo's browser beyond its tools: the line in a thread, the live view, takeovers and commit cards.
  const browser = createBrowserHand({
    host,
    store,
    desk,
    attachments,
    identifiers,
    work: workFor("Pages in the browser that came back to you"),
    info,
  });
  const app = createApp({
    store,
    turns,
    clock,
    schemas,
    info: { name: options.name, version: packageVersion() },
    gate: createGate(() => [store.setting(tokenSetting) ?? "", ...store.pairedTokenHashes()].filter(Boolean), clock),
    attachments,
    uploads,
    recordings,
    files,
    host,
    memory,
    backup,
    motions,
    made,
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
    access,
    onLeadRenamed: () => {
      void engine.refresh();
    },
    moved: (message, from, to) => {
      turns.moved(message, from, to);
    },
    shares,
    browser,
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
  const doors = createDoors({
    host,
    currentTurn: () => store.runningTurn(contextThread())?.id,
    currentPlace: () => {
      const thread = contextThread();
      const run = contextRun();
      return { ...(thread !== undefined && { thread }), ...(run !== undefined && { run }) };
    },
    command: launcher,
  });
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
    ...made.tools,
    ...createWorkTools({ post, desk, isTrack: (id) => tracks.find(id) !== undefined, clock }),
    ...threads.tools,
    ...tracks.tools,
    ...questions.tools,
    deskLine.tool,
    ...calendar.tools,
    ...picture.tools,
    ...contacts.tools,
    people.tool,
    ...wakeUps.tools,
    ...mail.tools,
    ...gettingStarted.tools,
    ...createRecordingTools(recordings),
    files.tool,
    dayNotes.tool,
    ...createPlaceTools(placeTools),
    ...dreams.tools,
    ...createDemoTools({
      store,
      desk,
      post: (text, isUrgent) => store.postMessage(text, { isUrgent }),
      gettingStarted,
      identifiers,
      clock,
      timeZone,
    }),
  ];
  const noteRun = (tool: Tool): Tool => ({
    ...tool,
    call: (input) => {
      const run = contextRun();
      if (run !== undefined) background.touch(run);
      return tool.call(input);
    },
  });
  // Each tool checks its input first, then, in a dream, keeps what it changed.
  const prepared = (tool: Tool): Tool => withCheckedInput(dreams.watch(tool));
  const allTools = (): readonly Tool[] =>
    [...coreTools, ...doors.tools()].map((tool) => groups.reporting(noteRun(prepared(tool))));
  const callTool = async (name: string, input: unknown, run?: string, thread?: string): Promise<ToolResult> => {
    const tool = allTools().find((candidate) => candidate.name === name);
    return tool
      ? inToolContext({ ...(run !== undefined && { run }), ...(thread !== undefined && { thread }) }, () =>
          tool.call(input),
        )
      : { text: `Ito has no tool ${name}.`, isError: true };
  };
  store.subscribe(({ event }) => {
    if (event.type !== "turn.ended") return;
    memory.indexConversation();
    // A turn in the chat shows how the model stands: a usage limit pauses background work, an answer ends a pause.
    if (event.outcome === "completed") background.answered();
    if (event.error?.code === "usage_limit") background.limitReached();
  });
  registerWakeUps(app, { wakeUps, schemas });
  registerDream(app, { dreams, schemas });
  registerDay(app, { picture, schemas });
  registerUnderstanding(app, { questions, tracks, schemas });
  registerPeople(app, { people, schemas });
  registerLocation(app, { location, schemas });
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
    uploads.sweep();
    compaction.set(clock.after(dayMs, compact));
  };
  compact();
  turns.recover();
  shares.recover();
  problems.start();
  backup.start();

  const shutdown = async (): Promise<void> => {
    compaction.get()?.();
    problems.close();
    await backup.close();
    motions.close();
    naming.close();
    shares.close();
    desk.close();
    background.close();
    dreams.close();
    wakeUps.close();
    questions.close();
    calendarChanges.close();
    comingsAndGoings.close();
    places.close();
    gettingStarted.close();
    calendar.close();
    people.close();
    contacts.close();
    await mail.close();
    notifier.close();
    browser.close();
    await app.close();
    await turns.close();
    await engine.close();
    await host.close();
    await calls.close();
    await recordings.close();
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
    shares,
    attachments,
    recordings,
    files,
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
    background,
    dreams,
    callTool,
    close: () => {
      const pending = closing.get() ?? shutdown();
      closing.set(pending);
      return pending;
    },
  };
};
