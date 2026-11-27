import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { createCell } from "#cell.ts";
import { toTimestamp, type Clock } from "#clock.ts";
import {
  toAskId,
  toDeviceId,
  toMessageId,
  toThreadId,
  toTurnId,
  type AskId,
  type DeviceId,
  type EventId,
  type MessageId,
  type ThreadId,
  type TurnId,
} from "#conversation/ids.ts";
import type { Identifiers } from "#identifiers.ts";
import type {
  Ask,
  Attachment,
  Browser,
  Call,
  Desk,
  DoneEntry,
  Onboarding,
  Error as ErrorBody,
  Spoken,
  LiveTurn,
  Message,
  Made,
  MadeChange,
  MadeState,
  Motion,
  MotionChange,
  Outcome,
  Problem,
  Recording,
  Snapshot,
  Status,
  Step,
  StepId,
  StepKind,
  Thread,
  Quote,
  VoiceState,
} from "#protocol/types.ts";
import { fail, ok, type Result } from "#result.ts";
import type { AskFields, StepFacts } from "#engine/engine.ts";
import { project, type LoggedEvent } from "#store/projection.ts";
import { lineOf } from "#notifications/text.ts";

export type LogEntry = { readonly seq: number; readonly event: LoggedEvent };

export type SnapshotEntry = { readonly seq: number; readonly event: Snapshot };

export type Listener = (entry: LogEntry) => void;

export type MessageKind = "reply" | "note";

export type ReplayGap = "cursor_unknown" | "too_far_behind";

export type PendingWork =
  | { readonly kind: "message"; readonly message: MessageId }
  | { readonly kind: "retry"; readonly turn: TurnId; readonly retryOf: TurnId };

export type StoredTurn = {
  readonly id: TurnId;
  readonly inputs: readonly MessageId[];
  readonly read: readonly MessageId[];
  readonly hasStartedReply: boolean;
  readonly outcome: Outcome | undefined;
  // The side thread it answers in; undefined for the main chat.
  readonly thread: ThreadId | undefined;
};

export type OpenMessage = { readonly id: MessageId; readonly text: string };

export type Accepted = { readonly message: Message; readonly isNew: boolean };

export type Page = {
  readonly messages: readonly Message[];
  readonly steps: readonly Step[];
  readonly asks: readonly Ask[];
  readonly calls: readonly Call[];
  readonly threads: readonly Thread[];
  readonly hasMore: boolean;
};

export type ThreadPage = {
  readonly thread: Thread;
  readonly anchor: Message | undefined;
  readonly messages: readonly Message[];
  readonly steps: readonly Step[];
  readonly asks: readonly Ask[];
  readonly turn: LiveTurn | null;
  readonly next: readonly string[];
  readonly hasMore: boolean;
};

export type ThreadList = {
  readonly open: readonly Thread[];
  readonly done: readonly Thread[];
  readonly hasMore: boolean;
};

// Where a message you send goes: the main chat unless it names a thread, replies to a message, or starts a thread.
export type Where = {
  readonly thread?: ThreadId;
  readonly replyTo?: MessageId;
  readonly isNewThread?: boolean;
};

export type ThreadChange = {
  readonly by: "kumo" | "you";
  readonly title?: string;
  readonly result?: string;
  readonly state?: Thread["state"];
};

export type MoveFailure = "not_found" | "unknown_thread" | "anchor";

export type Exchange = {
  readonly turn: TurnId;
  readonly position: number;
  readonly said: string;
  readonly answered: string;
};

export type AcceptFailure =
  "id_conflict" | "unknown_attachment" | "attachment_taken" | "call_not_on" | "unknown_thread" | "unknown_message";

export const onboardingSetting = "onboarding";

export const problemsSetting = "problems";

export const browserSetting = "browser";

export type DonePage = { readonly entries: readonly DoneEntry[]; readonly hasMore: boolean };

export type SpokenInput = { readonly call: string; readonly audio?: string };

export type StartedCall = { readonly call: Call; readonly isNew: boolean };

export type DeletedAudio = { readonly call: Call; readonly audio: readonly string[] };

export type SavedAttachment = { readonly attachment: Attachment; readonly isNew: boolean };

export type PairingCode = { readonly expiresAt: string; readonly deviceName: string | undefined };

export type Registration = {
  readonly apnsToken: string;
  readonly environment: "sandbox" | "production";
  readonly notificationKey: string;
};

export type StoredDevice = Registration & {
  readonly id: DeviceId;
  readonly keyId: string;
  readonly registeredAt: string;
};

export type Settings = {
  readonly setting: (key: string) => string | undefined;
  readonly setSetting: (key: string, value: string) => void;
};

export type Store = Settings & {
  readonly subscribe: (listener: Listener) => () => void;
  readonly eventsAfter: (cursor: EventId) => Result<readonly LogEntry[], ReplayGap>;
  readonly snapshot: (reason: Snapshot["reason"]) => SnapshotEntry;
  readonly acceptMessage: (
    id: MessageId,
    text: string,
    attachments?: readonly string[],
    spoken?: SpokenInput,
    done?: string,
    where?: Where,
  ) => Result<Accepted, AcceptFailure>;
  // A message from Kumo outside any turn; an urgent one is sent time-sensitive.
  readonly postMessage: (
    text: string,
    options?: { readonly isUrgent?: boolean; readonly thread?: ThreadId },
  ) => Message;
  readonly desk: () => Desk;
  readonly setDesk: (desk: Desk) => void;
  readonly onboarding: () => Onboarding;
  readonly setOnboarding: (onboarding: Onboarding) => void;
  readonly problems: () => readonly Problem[];
  readonly setProblems: (problems: readonly Problem[]) => void;
  // Kumo's browser as it stands; idle until it does something.
  readonly browser: () => Browser;
  readonly setBrowser: (browser: Browser) => void;
  readonly addDone: (entry: DoneEntry, undoWith?: unknown) => void;
  readonly listDone: (before: string | undefined, limit: number) => DonePage;
  readonly doneSince: (at: string) => readonly DoneEntry[];
  readonly findDone: (id: string) => { readonly entry: DoneEntry; readonly payload: unknown } | undefined;
  readonly replaceDone: (entry: DoneEntry) => void;
  readonly amendMessage: (
    id: MessageId,
    text: string,
    audio: string,
  ) => Result<{ readonly message: Message; readonly replaced?: string }, "not_spoken" | "unknown_attachment">;
  readonly startCall: (id: string) => StartedCall;
  readonly endCall: (id: string, reason?: string) => Call | undefined;
  readonly deleteCallAudio: (id: string) => DeletedAudio | undefined;
  readonly recordVoiceStatus: (state: VoiceState, reason?: string) => void;
  // Where a recording's transcript stands, for the app to follow.
  readonly recordRecording: (recording: Recording) => void;
  readonly latestCall: () => Call | undefined;
  readonly exchanges: (through: TurnId | undefined, limit: number, thread?: ThreadId) => readonly Exchange[];
  // A thread Kumo starts empty, for a post; it sits at the end of the main chat.
  readonly startThread: (by: Thread["by"], title?: string) => Thread;
  // Kumo moves messages out of the main chat into a thread of its own, which sits where the first of them was.
  readonly branchThread: (title: string, messages: readonly MessageId[]) => Result<Thread, "not_found">;
  readonly changeThread: (thread: ThreadId, change: ThreadChange) => Thread | undefined;
  readonly seeThread: (thread: ThreadId) => Thread | undefined;
  readonly moveMessage: (message: MessageId, thread: ThreadId | undefined) => Result<Message, MoveFailure>;
  readonly findThread: (thread: ThreadId) => Thread | undefined;
  readonly findMessage: (message: MessageId) => Message | undefined;
  readonly openThreads: () => readonly Thread[];
  readonly listThreads: (query: string, before: ThreadId | undefined, limit: number) => ThreadList;
  readonly threadPage: (thread: ThreadId) => ThreadPage | undefined;
  // A thread's latest messages, oldest first, that someone would read: yours, Kumo's replies and posts.
  readonly threadMessages: (thread: ThreadId | undefined, limit: number) => readonly Message[];
  // Kumo's posts in the main chat or a thread since its last turn there, which that conversation hasn't seen.
  readonly postsSinceTurn: (thread: ThreadId | undefined) => readonly Message[];
  readonly saveAttachment: (attachment: Attachment, sha256: string) => Result<SavedAttachment, "id_conflict">;
  readonly findAttachment: (id: string) => { readonly attachment: Attachment; readonly sha256: string } | undefined;
  readonly sentAttachment: (sha256: string) => string | undefined;
  readonly unattachedBefore: (before: string) => readonly string[];
  readonly deleteAttachment: (id: string) => void;
  readonly pairedTokenHashes: () => readonly string[];
  readonly clearPairing: () => void;
  readonly createPairingCode: (hash: string, expiresAt: string) => void;
  readonly forgetPairingCode: (hash: string) => void;
  readonly pairDevice: (codeHash: string, deviceName: string, tokenHash: string) => boolean;
  readonly pairingCode: (hash: string) => PairingCode | undefined;
  readonly listMessages: (before: MessageId, limit: number) => Result<Page, "not_found">;
  readonly messageText: (message: MessageId) => string | undefined;
  // The conversation's latest messages with words in them, oldest first.
  readonly latestMessages: (limit: number) => readonly Message[];
  readonly recordMotion: (
    type: "motion.started" | "motion.changed" | "motion.finished",
    motion: Omit<Motion, "position"> & { readonly position?: number },
    note: string,
  ) => { readonly motion: Motion; readonly change: MotionChange };
  readonly setMotionState: (motion: string, state: Readonly<Record<string, unknown>>) => void;
  readonly removeMotion: (motion: string) => void;
  readonly findMotion: (motion: string) => Motion | undefined;
  readonly listMotions: () => readonly Motion[];
  readonly motionChanges: (motion: string, limit: number) => readonly MotionChange[];
  readonly motionState: (motion: string) => Readonly<Record<string, unknown>>;
  readonly motionTicksSinceLastTurn: () => readonly {
    readonly motion: string;
    readonly before: Readonly<Record<string, unknown>>;
    readonly after: Readonly<Record<string, unknown>>;
  }[];
  // A page Kumo made, or changed, with its whole content at that version.
  readonly recordMade: (
    type: "made.created" | "made.changed",
    made: Omit<Made, "position"> & { readonly position?: number },
    note: string,
    content: Readonly<Record<string, unknown>>,
  ) => { readonly made: Made; readonly change: MadeChange };
  readonly setMadeState: (made: string, state: MadeState) => void;
  readonly removeMade: (made: string) => void;
  readonly findMade: (made: string) => Made | undefined;
  readonly listMade: () => readonly Made[];
  readonly madeChanges: (made: string, limit: number) => readonly MadeChange[];
  readonly madeState: (made: string) => MadeState;
  readonly madeContent: (made: string, version: number) => Readonly<Record<string, unknown>> | undefined;
  readonly keepAttachment: (id: string) => void;
  readonly messageAttachments: (message: MessageId) => readonly Attachment[];
  readonly answeredAsk: (message: MessageId) => AskId | undefined;
  // What waits in the main chat, or in a thread.
  readonly pendingWork: (thread?: ThreadId) => readonly PendingWork[];
  // The running turn in the main chat, or in a thread.
  readonly runningTurn: (thread?: ThreadId) => StoredTurn | undefined;
  // Every running turn, wherever it is.
  readonly runningTurns: () => readonly StoredTurn[];
  // The threads where something waits to be answered.
  readonly waitingThreads: () => readonly ThreadId[];
  readonly findTurn: (turn: TurnId) => StoredTurn | undefined;
  // The latest turn in the main chat, or in a thread, running or not.
  readonly latestTurn: (thread?: ThreadId) => StoredTurn | undefined;
  readonly openMessage: (turn: TurnId) => OpenMessage | undefined;
  readonly retryFor: (failed: TurnId) => TurnId | undefined;
  readonly requestRetry: (failed: TurnId, turn: TurnId) => TurnId;
  readonly startTurn: (turn: TurnId, inputs: readonly MessageId[], retryOf?: TurnId, thread?: ThreadId) => void;
  readonly setStatus: (turn: TurnId, status: Status) => void;
  readonly markRead: (turn: TurnId, message: MessageId) => void;
  readonly queueMessage: (turn: TurnId, message: MessageId) => void;
  readonly startMessage: (turn: TurnId, kind: MessageKind) => MessageId;
  readonly startStep: (turn: TurnId, kind: StepKind, title: string, facts: StepFacts) => Step;
  readonly updateStep: (step: Step) => void;
  readonly endStep: (step: Step) => void;
  readonly openSteps: (turn: TurnId) => readonly Step[];
  readonly findStep: (step: StepId) => Step | undefined;
  readonly appendText: (message: MessageId, text: string) => void;
  readonly endMessage: (message: MessageId, outcome: Outcome, length: number, error?: ErrorBody) => void;
  readonly endTurn: (turn: TurnId, outcome: Outcome, error?: ErrorBody) => void;
  readonly startAsk: (turn: TurnId, fields: AskFields) => Ask;
  readonly cancelAsk: (ask: AskId) => Result<Ask, "not_found">;
  readonly findAsk: (ask: AskId) => Ask | undefined;
  readonly waitingAsk: (thread?: ThreadId) => Ask | undefined;
  readonly registerDevice: (
    id: DeviceId,
    registration: Registration,
  ) => { readonly device: StoredDevice; readonly isNew: boolean };
  readonly removeDevice: (id: DeviceId) => void;
  readonly lastReply: (turn: TurnId) => OpenMessage | undefined;
  readonly devices: () => readonly StoredDevice[];
  readonly importEvents: (events: readonly LoggedEvent[]) => void;
  // Forgets what's only needed to replay events from before an instant: streamed text, and the Desk, problems and
  // getting started as they were, which their projections already hold as they are.
  readonly compact: (before: string) => void;
  readonly backupTo: (filePath: string) => void;
  readonly close: () => void;
};

type MessageRow = {
  readonly id: string;
  readonly position: number;
  readonly role: "user" | "agent";
  readonly kind: MessageKind | "post" | null;
  readonly turn: string | null;
  readonly text: string;
  readonly at: string;
  readonly ended_at: string | null;
  readonly outcome: Outcome | null;
  readonly error: string | null;
  readonly answers: string | null;
  readonly attachments: string | null;
  readonly spoken: string | null;
  readonly done: string | null;
  readonly urgent: number;
  readonly thread: string | null;
  readonly quotes: string | null;
};

type AttachmentRow = { readonly body: string; readonly sha256: string; readonly message: string | null };

type AskRow = { readonly body: string };

type DeviceRow = {
  readonly id: string;
  readonly apns_token: string;
  readonly environment: "sandbox" | "production";
  readonly notification_key: string;
  readonly key_id: string;
  readonly registered_at: string;
};

type TurnRow = {
  readonly id: string;
  readonly position: number;
  readonly inputs: string;
  readonly read: string;
  readonly retry_of: string | null;
  readonly status: string | null;
  readonly has_started_reply: number;
  readonly outcome: Outcome | null;
  readonly thread: string | null;
};

type PendingRow = {
  readonly kind: "message" | "retry";
  readonly message: string | null;
  readonly turn: string | null;
  readonly retry_of: string | null;
};

type EventRow = { readonly seq: number; readonly id: string; readonly body: string };

type StepRow = { readonly body: string };

const snapshotSize = 50;
const compactedSetting = "compacted_through_seq";

const compactedTypes =
  "('message.delta', 'desk.changed', 'problems.changed', 'onboarding.changed', 'recording.changed', 'browser.changed')";

const parseIds = (json: string): readonly string[] => JSON.parse(json) as readonly string[];

const toMessage = (row: MessageRow): Message =>
  row.role === "user"
    ? {
        id: row.id,
        role: "user",
        text: row.text,
        at: row.at,
        position: row.position,
        ...(row.answers && { answers: row.answers }),
        ...(row.attachments && { attachments: JSON.parse(row.attachments) as Attachment[] }),
        ...(row.spoken && { spoken: JSON.parse(row.spoken) as Spoken }),
        ...(row.done && { done: row.done }),
        ...(row.thread && { thread: row.thread }),
        ...(row.quotes && { quotes: JSON.parse(row.quotes) as Quote }),
      }
    : {
        id: row.id,
        role: "agent",
        kind: row.kind ?? "reply",
        ...(row.kind !== "post" && { turn: row.turn ?? "" }),
        text: row.text,
        at: row.at,
        position: row.position,
        ...(row.ended_at && { ended_at: row.ended_at }),
        ...(row.outcome && { outcome: row.outcome }),
        ...(row.error && { error: JSON.parse(row.error) as ErrorBody }),
        ...(row.urgent === 1 && { urgent: true }),
        ...(row.thread && { thread: row.thread }),
      };

const toStoredTurn = (row: TurnRow): StoredTurn => ({
  id: toTurnId(row.id),
  inputs: parseIds(row.inputs).map((input) => toMessageId(input)),
  read: parseIds(row.read).map((input) => toMessageId(input)),
  hasStartedReply: row.has_started_reply === 1,
  outcome: row.outcome ?? undefined,
  thread: row.thread === null ? undefined : toThreadId(row.thread),
});

// A message the agent took back unfinished, ended discarded, is out of everything read from the conversation.
const kept = "outcome IS NOT 'discarded'";

const toLiveTurn = (row: TurnRow, startedAt: string | undefined): LiveTurn => ({
  id: row.id,
  inputs: [...parseIds(row.inputs)],
  read: [...parseIds(row.read)],
  ...(row.retry_of && { retry_of: row.retry_of }),
  ...(startedAt !== undefined && { started_at: startedAt }),
  status: row.status ? (JSON.parse(row.status) as Status) : null,
  ...(row.thread && { thread: row.thread }),
});

const toPendingWork = (row: PendingRow): PendingWork =>
  row.kind === "message"
    ? { kind: "message", message: toMessageId(row.message ?? "") }
    : { kind: "retry", turn: toTurnId(row.turn ?? ""), retryOf: toTurnId(row.retry_of ?? "") };

const toLogEntry = (row: EventRow): LogEntry => ({ seq: row.seq, event: JSON.parse(row.body) as LoggedEvent });

const toStep = (row: StepRow): Step => JSON.parse(row.body) as Step;

const toAsk = (row: AskRow): Ask => JSON.parse(row.body) as Ask;

const toDevice = (row: DeviceRow): StoredDevice => ({
  id: toDeviceId(row.id),
  apnsToken: row.apns_token,
  environment: row.environment,
  notificationKey: row.notification_key,
  keyId: row.key_id,
  registeredAt: row.registered_at,
});

export const toKeyId = (notificationKey: string): string =>
  createHash("sha256").update(Buffer.from(notificationKey, "base64")).digest("hex").slice(0, 8);

// The main chat is where `thread` is null, and `IS ?` matches a null parameter too.
const placeOf = (thread: string | undefined): string | null => thread ?? null;

type ThreadMessageRow = Pick<MessageRow, "id" | "role" | "kind" | "text" | "at" | "attachments" | "position">;

const imagesBlock = /^```ari:images[^\n]*\n(?<body>[\s\S]*?)^```[ \t]*$/mu;

const pageBlock = /^```ari:made\b/mu;

const without = <Value extends object, Key extends keyof Value>(
  value: Value,
  ...keys: readonly Key[]
): Omit<Value, Key> =>
  Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key as Key))) as Omit<Value, Key>;

const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, inner: unknown) =>
    inner !== null && typeof inner === "object" && !Array.isArray(inner)
      ? Object.fromEntries(Object.entries(inner).toSorted(([left], [right]) => left.localeCompare(right)))
      : inner,
  );

// A thread's picture: your first photo in it, or the first picture Kumo found for it.
const pictureIn = (row: ThreadMessageRow): string | undefined => {
  if (row.role === "user") {
    const attached = row.attachments ? (JSON.parse(row.attachments) as readonly Attachment[]) : [];
    return attached.find((attachment) => attachment.kind === "image")?.id;
  }
  const body = imagesBlock.exec(row.text)?.groups?.body;
  if (body === undefined) return undefined;
  try {
    const first = (JSON.parse(body) as { readonly images?: readonly { readonly attachment?: unknown }[] }).images?.[0];
    return typeof first?.attachment === "string" ? first.attachment : undefined;
  } catch {
    return undefined;
  }
};

const isShownRow = (row: ThreadMessageRow): boolean =>
  (row.role === "user" || row.kind === "reply" || row.kind === "post") && (row.text !== "" || row.attachments !== null);

export const createStore = (database: DatabaseSync, clock: Clock, identifiers: Identifiers): Store => {
  const listeners = createCell<ReadonlySet<Listener>>(new Set());
  const unannounced = createCell<readonly LogEntry[]>([]);
  const now = (): string => toTimestamp(clock.now());

  const announce = (): void => {
    const entries = unannounced.get();
    unannounced.set([]);
    for (const entry of entries) for (const listener of listeners.get()) listener(entry);
  };

  const transaction = <Value>(work: () => Value): Value => {
    database.exec("BEGIN IMMEDIATE");
    try {
      const value = work();
      database.exec("COMMIT");
      announce();
      return value;
    } catch (error) {
      database.exec("ROLLBACK");
      unannounced.set([]);
      throw error;
    }
  };

  const nextSeq = (): number =>
    (database.prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM events").get() as { readonly seq: number }).seq;

  const append = (event: LoggedEvent): void => {
    const seq = nextSeq();
    database
      .prepare("INSERT INTO events (seq, id, type, at, body) VALUES (?, ?, ?, ?, ?)")
      .run(seq, event.id, event.type, event.at, JSON.stringify(event));
    project(database, seq, event);
    unannounced.update((entries) => [...entries, { seq, event }]);
  };

  const record = (
    build: (stamp: { readonly id: string; readonly at: string }, position: number) => LoggedEvent,
  ): void => {
    transaction(() => {
      append(build({ id: identifiers.event(), at: now() }, nextSeq()));
    });
  };

  // When a turn started, from its turn.started in the log, unless that's been compacted away.
  const turnStartedAt = (turn: string): string | undefined =>
    (
      database
        .prepare(
          "SELECT at FROM events WHERE type = 'turn.started' AND json_extract(body, '$.turn') = ? ORDER BY seq DESC LIMIT 1",
        )
        .get(turn) as { readonly at: string } | undefined
    )?.at;

  const stepsFrom = (from: number, until: number, thread: string | undefined): readonly Step[] =>
    (
      database
        .prepare(
          `SELECT steps.body FROM steps JOIN turns ON turns.id = steps.turn
           WHERE steps.position >= ? AND steps.position < ? AND turns.thread IS ? ORDER BY steps.position`,
        )
        .all(from, until, placeOf(thread)) as unknown as readonly StepRow[]
    ).map((row) => toStep(row));

  const callsFrom = (from: number, until = Number.MAX_SAFE_INTEGER): readonly Call[] =>
    (
      database
        .prepare(
          "SELECT body FROM calls WHERE (position >= ? AND position < ?) OR (ended = 0 AND ? = ?) ORDER BY position",
        )
        .all(from, until, until, Number.MAX_SAFE_INTEGER) as unknown as readonly { readonly body: string }[]
    ).map((row) => JSON.parse(row.body) as Call);

  const callRow = (id: string): { readonly body: string; readonly ended: number } | undefined =>
    database.prepare("SELECT body, ended FROM calls WHERE id = ?").get(id) as
      { readonly body: string; readonly ended: number } | undefined;

  const openCallRow = (): { readonly body: string } | undefined =>
    database.prepare("SELECT body FROM calls WHERE ended = 0 ORDER BY position DESC LIMIT 1").get() as
      { readonly body: string } | undefined;

  const endCallNow = (call: Call, reason?: string): Call => {
    if (call.ended_at !== undefined) return call;
    const at = now();
    const ended: Call = {
      ...call,
      ended_at: at,
      duration_ms: Math.max(0, Date.parse(at) - Date.parse(call.started_at)),
      ...(reason !== undefined && { end_reason: reason }),
    };
    append({ id: identifiers.event(), type: "call.ended", at, call: ended });
    return ended;
  };

  const threadsWhere = (where: string, ...parameters: readonly (string | number | null)[]): readonly Thread[] =>
    (
      database.prepare(`SELECT body FROM threads WHERE ${where}`).all(...parameters) as unknown as readonly {
        readonly body: string;
      }[]
    ).map((row) => JSON.parse(row.body) as Thread);

  const threadRow = (id: string): Thread | undefined => threadsWhere("id = ?", id).at(0);

  const anchoredThread = (message: string): Thread | undefined => threadsWhere("anchor = ? LIMIT 1", message).at(0);

  const asksFrom = (from: number, until: number, thread: string | undefined): readonly Ask[] =>
    (
      database
        .prepare(
          `SELECT asks.body FROM asks JOIN turns ON turns.id = asks.turn
           WHERE asks.position >= ? AND asks.position < ? AND turns.thread IS ? ORDER BY asks.position`,
        )
        .all(from, until, placeOf(thread)) as unknown as readonly AskRow[]
    ).map((row) => toAsk(row));

  const askRow = (id: string): (AskRow & { readonly outcome: string | null }) | undefined =>
    database.prepare("SELECT body, outcome FROM asks WHERE id = ?").get(id) as
      (AskRow & { readonly outcome: string | null }) | undefined;

  const waitingRow = (thread: string | undefined): AskRow | undefined =>
    database
      .prepare(
        "SELECT body FROM asks WHERE outcome IS NULL AND json_extract(body, '$.thread') IS ? ORDER BY position DESC LIMIT 1",
      )
      .get(placeOf(thread)) as AskRow | undefined;

  const endAsk = (ask: Ask, outcome: "answered" | "cancelled", answer?: MessageId): Ask => {
    const at = now();
    const ended: Ask = { ...ask, ended_at: at, outcome, ...(answer && { answer }) };
    append({ id: identifiers.event(), type: "ask.ended", at, ask: ended });
    return ended;
  };

  const attachmentRow = (id: string): AttachmentRow | undefined =>
    database.prepare("SELECT body, sha256, message FROM attachments WHERE id = ?").get(id) as AttachmentRow | undefined;

  const messageRow = (id: string): MessageRow | undefined =>
    database.prepare("SELECT * FROM messages WHERE id = ?").get(id) as MessageRow | undefined;

  const turnRow = (id: string): TurnRow | undefined =>
    database.prepare("SELECT * FROM turns WHERE id = ?").get(id) as TurnRow | undefined;

  const putThread = (type: "thread.started" | "thread.changed", thread: Thread): Thread => {
    append({ id: identifiers.event(), type, at: now(), thread });
    return thread;
  };

  const newThread = (
    by: Thread["by"],
    position: number,
    { title, anchor }: { readonly title?: string; readonly anchor?: string } = {},
  ): Thread => {
    const at = now();
    return putThread("thread.started", {
      id: identifiers.thread(),
      ...(title !== undefined && title !== "" && { title }),
      by,
      state: "open",
      started_at: at,
      position,
      ...(anchor !== undefined && { anchor }),
      replies: 0,
      last_at: at,
    });
  };

  // A thread's replies, latest time, picture and page follow its messages; `patch` changes the rest. It says so
  // only when something changed.
  const refreshThread = (id: string, patch: (thread: Thread) => Thread = (thread) => thread): Thread | undefined => {
    const before = threadRow(id);
    if (!before) return undefined;
    const rows = database
      .prepare(
        `SELECT id, role, kind, text, at, attachments, position FROM messages WHERE thread = ? AND ${kept} ORDER BY position`,
      )
      .all(id) as unknown as readonly ThreadMessageRow[];
    const shown = rows.filter((row) => isShownRow(row));
    const picture = rows.map((row) => pictureIn(row)).find((found) => found !== undefined);
    const hasPage = shown.some((row) => row.role === "agent" && pageBlock.test(row.text));
    const after = patch({
      ...without(before, "picture", "page"),
      replies: shown.length,
      last_at: shown.at(-1)?.at ?? before.started_at,
      ...(picture !== undefined && { picture }),
      ...(hasPage && { page: true as const }),
    });
    return canonical(after) === canonical(before) ? before : putThread("thread.changed", after);
  };

  const pendingRows = (where: string, ...parameters: readonly (string | null)[]): readonly PendingRow[] =>
    database
      .prepare(
        `SELECT pending.* FROM pending
         LEFT JOIN messages ON messages.id = pending.message
         LEFT JOIN turns ON turns.id = pending.retry_of
         WHERE ${where} ORDER BY pending.position`,
      )
      .all(...parameters) as unknown as readonly PendingRow[];

  const pendingIn = (thread: string | undefined): readonly PendingRow[] =>
    pendingRows("COALESCE(messages.thread, turns.thread) IS ?", placeOf(thread));

  const pageOf = (thread: string | undefined, before: number, limit: number): readonly MessageRow[] =>
    database
      .prepare(`SELECT * FROM messages WHERE thread IS ? AND position < ? AND ${kept} ORDER BY position DESC LIMIT ?`)
      .all(placeOf(thread), before, limit) as unknown as readonly MessageRow[];

  const readSetting = (key: string): string | undefined => {
    const row = database.prepare("SELECT value FROM settings WHERE key = ?").get(key) as
      { readonly value: string } | undefined;
    return row?.value;
  };

  const writeSetting = (key: string, value: string): void => {
    database
      .prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
      .run(key, value);
  };

  const compactedThrough = (): number => Number(readSetting(compactedSetting) ?? 0);

  const currentOnboarding = (): Onboarding => {
    const stored = readSetting(onboardingSetting);
    return stored === undefined ? { state: "reading" } : (JSON.parse(stored) as Onboarding);
  };

  const currentProblems = (): readonly Problem[] => {
    const stored = readSetting(problemsSetting);
    return stored === undefined ? [] : (JSON.parse(stored) as Problem[]);
  };

  const currentBrowser = (): Browser => {
    const stored = readSetting(browserSetting);
    return stored === undefined ? { state: "idle" } : (JSON.parse(stored) as Browser);
  };

  const currentDesk = (): Desk => {
    const row = database.prepare("SELECT body FROM desk WHERE id = 1").get() as { readonly body: string } | undefined;
    return row ? (JSON.parse(row.body) as Desk) : { plans: [], coming_up: [], waiting: [], handled: 0 };
  };

  return {
    subscribe: (listener) => {
      listeners.update((current) => new Set([...current, listener]));
      return () => {
        listeners.update((current) => new Set([...current].filter((candidate) => candidate !== listener)));
      };
    },

    eventsAfter: (cursor) => {
      const anchor = database.prepare("SELECT seq FROM events WHERE id = ?").get(cursor) as
        { readonly seq: number } | undefined;
      if (!anchor) return fail("cursor_unknown");
      if (anchor.seq < compactedThrough()) return fail("too_far_behind");
      const rows = database.prepare("SELECT seq, id, body FROM events WHERE seq > ? ORDER BY seq").all(anchor.seq);
      return ok((rows as unknown as readonly EventRow[]).map((row) => toLogEntry(row)));
    },

    snapshot: (reason) => {
      const latest = database.prepare("SELECT seq, id FROM events ORDER BY seq DESC LIMIT 1").get() as
        { readonly seq: number; readonly id: string } | undefined;
      const rows = pageOf(undefined, Number.MAX_SAFE_INTEGER, snapshotSize + 1);
      const turn = database
        .prepare("SELECT * FROM turns WHERE outcome IS NULL AND thread IS NULL ORDER BY position DESC LIMIT 1")
        .get() as TurnRow | undefined;
      const next = pendingIn(undefined).flatMap((row) => (row.kind === "message" && row.message ? [row] : []));
      const window = rows.slice(0, snapshotSize).toReversed();
      const from = (rows[snapshotSize]?.position ?? 0) + 1;
      return {
        seq: latest?.seq ?? 0,
        event: {
          ...(latest && { id: latest.id }),
          type: "snapshot",
          at: now(),
          reason,
          messages: window.map((row) => toMessage(row)),
          has_more: rows.length > snapshotSize,
          steps: window[0] ? [...stepsFrom(window[0].position, Number.MAX_SAFE_INTEGER, undefined)] : [],
          asks: window[0] ? [...asksFrom(window[0].position, Number.MAX_SAFE_INTEGER, undefined)] : [],
          calls: [...callsFrom(from)],
          threads: [...threadsWhere("position >= ? OR state = 'open' ORDER BY position", from)],
          turn: turn ? toLiveTurn(turn, turnStartedAt(turn.id)) : null,
          next: next.map((row) => row.message ?? ""),
          desk: currentDesk(),
          ...(currentOnboarding().state !== "done" && { onboarding: currentOnboarding() }),
          ...(currentProblems().length > 0 && { problems: [...currentProblems()] }),
          ...(currentBrowser().state !== "idle" && { browser: currentBrowser() }),
        },
      };
    },

    acceptMessage: (id, text, attachments = [], spoken, done, where = {}) =>
      transaction(() => {
        const existing = messageRow(id);
        if (existing) {
          const message = toMessage(existing);
          const isSame =
            existing.text === text &&
            JSON.stringify((message.attachments ?? []).map((attachment) => attachment.id)) ===
              JSON.stringify(attachments);
          return isSame ? ok({ message, isNew: false }) : fail("id_conflict");
        }
        const call = spoken ? callRow(spoken.call) : undefined;
        if (spoken && call?.ended !== 0) return fail("call_not_on");
        const audioRow = spoken?.audio === undefined ? undefined : attachmentRow(spoken.audio);
        if (!audioRow && spoken?.audio !== undefined) return fail("unknown_attachment");
        const attachedRows = attachments.map((attachment) => attachmentRow(attachment));
        if (attachedRows.includes(undefined)) return fail("unknown_attachment");
        if ([...attachedRows, audioRow].some((row) => row !== undefined && row.message !== null))
          return fail("attachment_taken");
        const attached = attachedRows.flatMap((row) => (row ? [JSON.parse(row.body) as Attachment] : []));
        const target = where.replyTo === undefined ? undefined : messageRow(where.replyTo);
        if (!target && where.replyTo !== undefined) return fail("unknown_message");
        if (where.thread !== undefined && !threadRow(where.thread)) return fail("unknown_thread");
        // A reply in the main chat goes into the thread under that message, started now if there's none yet.
        const thread = target
          ? (target.thread ??
            anchoredThread(target.id)?.id ??
            newThread("you", target.position, { anchor: target.id }).id)
          : where.isNewThread === true
            ? newThread("you", nextSeq()).id
            : where.thread;
        const quotes: Quote | undefined =
          target?.thread == null
            ? undefined
            : {
                message: target.id,
                text: lineOf(target.text, target.attachments ? (JSON.parse(target.attachments) as Attachment[]) : []),
              };
        const waiting = waitingRow(thread);
        const at = now();
        const message: Message = {
          id,
          role: "user",
          text,
          at,
          position: nextSeq(),
          ...(waiting && { answers: toAsk(waiting).id }),
          ...(attached.length > 0 && { attachments: attached }),
          ...(spoken && {
            spoken: { call: spoken.call, ...(audioRow && { audio: JSON.parse(audioRow.body) as Attachment }) },
          }),
          ...(done !== undefined && { done }),
          ...(thread !== undefined && { thread }),
          ...(quotes && { quotes }),
        };
        append({ id: identifiers.event(), type: "message.accepted", at, message });
        if (waiting) endAsk(toAsk(waiting), "answered", id);
        // Replying in a thread opens it again, and you've seen what's new there.
        if (thread !== undefined)
          refreshThread(thread, (current) => ({ ...without(current, "news", "done"), state: "open" }));
        return ok({ message, isNew: true });
      }),

    postMessage: (text, { isUrgent = false, thread } = {}) =>
      transaction(() => {
        const at = now();
        const message: Message = {
          id: identifiers.message(),
          role: "agent",
          kind: "post",
          text,
          at,
          position: nextSeq(),
          outcome: "completed",
          ...(isUrgent && { urgent: true }),
          ...(thread !== undefined && threadRow(thread) && { thread }),
        };
        append({ id: identifiers.event(), type: "message.posted", at, message });
        // Kumo coming back to a thread moves its line to the end of the main chat, with what's new.
        if (message.thread !== undefined) {
          refreshThread(message.thread, (current) => ({
            ...current,
            position: message.position,
            news: { message: message.id, text: lineOf(text), at },
          }));
        }
        return message;
      }),

    desk: () => currentDesk(),

    onboarding: () => currentOnboarding(),

    setOnboarding: (onboarding) => {
      transaction(() => {
        if (JSON.stringify(onboarding) === JSON.stringify(currentOnboarding())) return;
        append({ id: identifiers.event(), type: "onboarding.changed", at: now(), onboarding });
      });
    },

    problems: () => currentProblems(),

    browser: () => currentBrowser(),

    setBrowser: (browser) => {
      transaction(() => {
        if (JSON.stringify(browser) === JSON.stringify(currentBrowser())) return;
        append({ id: identifiers.event(), type: "browser.changed", at: now(), browser });
      });
    },

    setProblems: (problems) => {
      transaction(() => {
        if (JSON.stringify(problems) === JSON.stringify(currentProblems())) return;
        append({ id: identifiers.event(), type: "problems.changed", at: now(), problems: [...problems] });
      });
    },

    setDesk: (desk) => {
      transaction(() => {
        if (JSON.stringify(desk) === JSON.stringify(currentDesk())) return;
        append({ id: identifiers.event(), type: "desk.changed", at: now(), desk });
      });
    },

    addDone: (entry, undoWith) => {
      database
        .prepare("INSERT OR REPLACE INTO done (id, at, body, undo_with) VALUES (?, ?, ?, ?)")
        .run(entry.id, entry.at, JSON.stringify(entry), undoWith === undefined ? null : JSON.stringify(undoWith));
    },

    listDone: (before, limit) => {
      const anchor =
        before === undefined
          ? undefined
          : (database.prepare("SELECT at, id FROM done WHERE id = ?").get(before) as
              { readonly at: string; readonly id: string } | undefined);
      const rows = database
        .prepare("SELECT body FROM done WHERE at < ? OR (at = ? AND id < ?) ORDER BY at DESC, id DESC LIMIT ?")
        .all(anchor?.at ?? "9999", anchor?.at ?? "9999", anchor?.id ?? "", limit + 1) as unknown as readonly {
        readonly body: string;
      }[];
      return {
        entries: rows.slice(0, limit).map((row) => JSON.parse(row.body) as DoneEntry),
        hasMore: rows.length > limit,
      };
    },

    doneSince: (at) =>
      (
        database
          .prepare("SELECT body FROM done WHERE at >= ? ORDER BY at DESC, id DESC")
          .all(at) as unknown as readonly {
          readonly body: string;
        }[]
      ).map((row) => JSON.parse(row.body) as DoneEntry),

    findDone: (id) => {
      const row = database.prepare("SELECT body, undo_with FROM done WHERE id = ?").get(id) as
        { readonly body: string; readonly undo_with: string | null } | undefined;
      return row
        ? {
            entry: JSON.parse(row.body) as DoneEntry,
            payload: row.undo_with === null ? undefined : (JSON.parse(row.undo_with) as unknown),
          }
        : undefined;
    },

    replaceDone: (entry) => {
      database.prepare("UPDATE done SET body = ? WHERE id = ?").run(JSON.stringify(entry), entry.id);
    },

    amendMessage: (id, text, audio) =>
      transaction(() => {
        const row = messageRow(id);
        const before = row ? toMessage(row) : undefined;
        if (before?.role !== "user" || !before.spoken) return fail("not_spoken");
        const audioRow = attachmentRow(audio);
        if (audioRow?.message !== null) return fail("unknown_attachment");
        const message: Message = {
          ...before,
          text,
          spoken: { call: before.spoken.call, audio: JSON.parse(audioRow.body) as Attachment },
        };
        append({ id: identifiers.event(), type: "message.amended", at: now(), message });
        return ok({ message, ...(before.spoken.audio && { replaced: before.spoken.audio.id }) });
      }),

    startCall: (id) =>
      transaction(() => {
        const existing = callRow(id);
        if (existing) return { call: JSON.parse(existing.body) as Call, isNew: false };
        const open = openCallRow();
        if (open) endCallNow(JSON.parse(open.body) as Call);
        const at = now();
        const call: Call = { id, started_at: at, position: nextSeq() };
        append({ id: identifiers.event(), type: "call.started", at, call });
        return { call, isNew: true };
      }),

    endCall: (id, reason) =>
      transaction(() => {
        const row = callRow(id);
        return row ? endCallNow(JSON.parse(row.body) as Call, reason) : undefined;
      }),

    recordVoiceStatus: (state, reason) => {
      record((stamp) => ({ ...stamp, type: "voice.status", state, ...(reason !== undefined && { reason }) }));
    },

    recordRecording: (recording) => {
      record((stamp) => ({ ...stamp, type: "recording.changed", recording }));
    },

    deleteCallAudio: (id) =>
      transaction(() => {
        const row = callRow(id);
        if (!row) return;
        const call = JSON.parse(row.body) as Call;
        const audio = (
          database
            .prepare(
              "SELECT json_extract(spoken, '$.audio.id') AS audio FROM messages WHERE json_extract(spoken, '$.call') = ?",
            )
            .all(id) as unknown as readonly { readonly audio: string | null }[]
        )
          .map((spokenRow) => spokenRow.audio)
          .filter((audio) => audio !== null);
        if (call.audio_deleted) return { call, audio };
        const deleted: Call = { ...call, audio_deleted: true };
        append({ id: identifiers.event(), type: "call.audio_deleted", at: now(), call: deleted });
        return { call: deleted, audio };
      }),

    exchanges: (through, limit, thread) => {
      const until = through === undefined ? Number.MAX_SAFE_INTEGER : (turnRow(through)?.position ?? -1);
      const rows = database
        .prepare(
          "SELECT * FROM turns WHERE outcome IS NOT NULL AND position <= ? AND thread IS ? ORDER BY position DESC LIMIT ?",
        )
        .all(until, placeOf(thread), limit) as unknown as readonly TurnRow[];
      return rows.toReversed().map((row) => {
        const inputs = parseIds(row.inputs).flatMap((id) => messageRow(id) ?? []);
        const replies = database
          .prepare(`SELECT text FROM messages WHERE turn = ? AND kind = 'reply' AND ${kept} ORDER BY position`)
          .all(row.id) as unknown as readonly { readonly text: string }[];
        return {
          turn: toTurnId(row.id),
          position: inputs[0]?.position ?? row.position,
          said: inputs.map(({ text }) => text).join("\n\n"),
          answered: replies.map(({ text }) => text).join("\n\n"),
        };
      });
    },

    startThread: (by, title) => transaction(() => newThread(by, nextSeq(), { ...(title !== undefined && { title }) })),

    branchThread: (title, messages) =>
      transaction(() => {
        const rows = messages
          .flatMap((message) => messageRow(message) ?? [])
          .filter((row) => row.thread === null && !anchoredThread(row.id))
          .toSorted((left, right) => left.position - right.position);
        const [first] = rows;
        if (!first) return fail("not_found");
        const thread = newThread("kumo", first.position, { title });
        for (const row of rows) {
          append({
            id: identifiers.event(),
            type: "message.moved",
            at: now(),
            message: { ...toMessage(row), thread: thread.id },
          });
        }
        return ok(refreshThread(thread.id) ?? thread);
      }),

    changeThread: (thread, { by, title, result, state }) =>
      transaction(() =>
        refreshThread(thread, (current) => {
          const changed = {
            ...current,
            ...(title !== undefined && title !== "" && { title }),
            ...(result !== undefined && result !== "" && { result }),
          };
          if (state === undefined || state === current.state) return changed;
          return state === "done"
            ? { ...changed, state, done: { at: now(), by } }
            : { ...without(changed, "done"), state };
        }),
      ),

    seeThread: (thread) => transaction(() => refreshThread(thread, (current) => without(current, "news"))),

    moveMessage: (id, thread) =>
      transaction(() => {
        const row = messageRow(id);
        if (!row) return fail("not_found");
        if (thread !== undefined && !threadRow(thread)) return fail("unknown_thread");
        if (anchoredThread(id)) return fail("anchor");
        const from = row.thread ?? undefined;
        const before = toMessage(row);
        if (from === thread) return ok(before);
        const message: Message = { ...without(before, "thread"), ...(thread !== undefined && { thread }) };
        append({ id: identifiers.event(), type: "message.moved", at: now(), message, ...(from && { from }) });
        if (from !== undefined) refreshThread(from);
        if (thread !== undefined) refreshThread(thread);
        return ok(message);
      }),

    findThread: (thread) => threadRow(thread),

    findMessage: (message) => {
      const row = messageRow(message);
      return row ? toMessage(row) : undefined;
    },

    openThreads: () => threadsWhere("state = 'open' ORDER BY last_at DESC, id DESC"),

    listThreads: (query, before, limit) => {
      const words = query
        .toLowerCase()
        .split(/\s+/u)
        .filter(Boolean)
        .map((word) => `%${word.replaceAll(/[%_\\]/gu, (character) => `\\${character}`)}%`);
      const matching = words
        .map(
          () =>
            `(lower(COALESCE(json_extract(body, '$.title'), '') || ' ' || COALESCE(json_extract(body, '$.result'), ''))
              LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM messages WHERE messages.thread = threads.id
              AND lower(messages.text) LIKE ? ESCAPE '\\'))`,
        )
        .join(" AND ");
      const filter = matching === "" ? "1" : matching;
      const parameters = words.flatMap((word) => [word, word]);
      const anchor = before === undefined ? undefined : threadRow(before);
      const done = threadsWhere(
        `state = 'done' AND ${filter} AND (started_at < ? OR (started_at = ? AND id < ?))
         ORDER BY started_at DESC, id DESC LIMIT ?`,
        ...parameters,
        anchor?.started_at ?? "9999",
        anchor?.started_at ?? "9999",
        anchor?.id ?? "",
        limit + 1,
      );
      return {
        open:
          before === undefined
            ? threadsWhere(`state = 'open' AND ${filter} ORDER BY last_at DESC, id DESC`, ...parameters)
            : [],
        done: done.slice(0, limit),
        hasMore: done.length > limit,
      };
    },

    threadPage: (id) => {
      const thread = threadRow(id);
      if (!thread) return;
      const rows = pageOf(id, Number.MAX_SAFE_INTEGER, snapshotSize + 1);
      const window = rows.slice(0, snapshotSize).toReversed();
      const turn = database
        .prepare("SELECT * FROM turns WHERE outcome IS NULL AND thread = ? ORDER BY position DESC LIMIT 1")
        .get(id) as TurnRow | undefined;
      const anchor = thread.anchor === undefined ? undefined : messageRow(thread.anchor);
      return {
        thread,
        anchor: anchor ? toMessage(anchor) : undefined,
        messages: window.map((row) => toMessage(row)),
        steps: window[0] ? stepsFrom(window[0].position, Number.MAX_SAFE_INTEGER, id) : [],
        asks: window[0] ? asksFrom(window[0].position, Number.MAX_SAFE_INTEGER, id) : [],
        turn: turn ? toLiveTurn(turn, turnStartedAt(turn.id)) : null,
        next: pendingIn(id).flatMap((row) => (row.kind === "message" && row.message ? row.message : [])),
        hasMore: rows.length > snapshotSize,
      };
    },

    threadMessages: (thread, limit) =>
      (
        database
          .prepare(
            `SELECT * FROM messages WHERE thread IS ? AND (role = 'user' OR kind IN ('reply', 'post'))
             AND (text != '' OR attachments IS NOT NULL) AND ${kept} ORDER BY position DESC LIMIT ?`,
          )
          .all(placeOf(thread), limit) as unknown as readonly MessageRow[]
      )
        .toReversed()
        .map((row) => toMessage(row)),

    postsSinceTurn: (thread) =>
      (
        database
          .prepare(
            `SELECT * FROM messages WHERE kind = 'post' AND thread IS ?
             AND position > COALESCE((SELECT MAX(position) FROM turns WHERE thread IS ?), 0) ORDER BY position`,
          )
          .all(placeOf(thread), placeOf(thread)) as unknown as readonly MessageRow[]
      ).map((row) => toMessage(row)),

    latestCall: () => {
      const row = database.prepare("SELECT body FROM calls ORDER BY position DESC LIMIT 1").get() as
        { readonly body: string } | undefined;
      return row ? (JSON.parse(row.body) as Call) : undefined;
    },

    listMessages: (before, limit) => {
      const anchor = database.prepare("SELECT position, thread FROM messages WHERE id = ?").get(before) as
        { readonly position: number; readonly thread: string | null } | undefined;
      if (!anchor) return fail("not_found");
      const thread = anchor.thread ?? undefined;
      const rows = pageOf(thread, anchor.position, limit + 1);
      const page = rows.slice(0, limit).toReversed();
      const from = (rows[limit]?.position ?? 0) + 1;
      return ok({
        messages: page.map((row) => toMessage(row)),
        steps: page[0] ? stepsFrom(page[0].position, anchor.position, thread) : [],
        asks: page[0] ? asksFrom(page[0].position, anchor.position, thread) : [],
        calls: thread === undefined ? callsFrom(from, anchor.position) : [],
        threads:
          thread === undefined
            ? threadsWhere("position >= ? AND position < ? ORDER BY position", from, anchor.position)
            : [],
        hasMore: rows.length > limit,
      });
    },

    messageText: (message) => messageRow(message)?.text,

    latestMessages: (limit) =>
      (
        database
          .prepare(
            `SELECT * FROM messages WHERE text != '' AND thread IS NULL AND ${kept} ORDER BY position DESC LIMIT ?`,
          )
          .all(limit) as unknown as readonly MessageRow[]
      )
        .toReversed()
        .map((row) => toMessage(row)),

    recordMotion: (type, given, note) =>
      transaction(() => {
        const latest = database.prepare("SELECT MAX(position) AS position FROM messages WHERE role = 'user'").get() as {
          readonly position: number | null;
        };
        const position = latest.position ?? nextSeq();
        const motion: Motion = { ...given, position: given.position ?? position };
        const change: MotionChange = { version: motion.version, at: motion.changed_at, note, position };
        append({ id: identifiers.event(), type, at: now(), motion, change });
        return { motion, change };
      }),

    setMotionState: (motion, state) => {
      record((stamp) => ({ ...stamp, type: "motion.state", motion, state }));
    },

    removeMotion: (motion) => {
      record((stamp) => ({ ...stamp, type: "motion.removed", motion }));
    },

    recordMade: (type, given, note, content) =>
      transaction(() => {
        const latest = database.prepare("SELECT MAX(position) AS position FROM messages WHERE role = 'user'").get() as {
          readonly position: number | null;
        };
        const position = latest.position ?? nextSeq();
        const made: Made = { ...given, position: given.position ?? position };
        const change: MadeChange = { version: made.version, at: made.changed_at, note, position };
        database
          .prepare("INSERT OR REPLACE INTO made_contents (made, version, content) VALUES (?, ?, ?)")
          .run(made.id, made.version, JSON.stringify(content));
        append({ id: identifiers.event(), type, at: now(), made, change });
        return { made, change };
      }),

    setMadeState: (made, state) => {
      record((stamp) => ({ ...stamp, type: "made.state", made, state }));
    },

    removeMade: (made) => {
      record((stamp) => ({ ...stamp, type: "made.removed", made }));
    },

    findMade: (made) => {
      const row = database.prepare("SELECT body FROM made WHERE id = ?").get(made) as
        { readonly body: string } | undefined;
      return row ? (JSON.parse(row.body) as Made) : undefined;
    },

    listMade: () =>
      (
        database.prepare("SELECT body FROM made ORDER BY changed_at DESC, id").all() as unknown as readonly {
          readonly body: string;
        }[]
      ).map((row) => JSON.parse(row.body) as Made),

    madeChanges: (made, limit) =>
      (
        database
          .prepare("SELECT body FROM made_changes WHERE made = ? ORDER BY version DESC LIMIT ?")
          .all(made, limit) as unknown as readonly { readonly body: string }[]
      ).map((row) => JSON.parse(row.body) as MadeChange),

    madeState: (made) => {
      const row = database.prepare("SELECT state FROM made_states WHERE made = ?").get(made) as
        { readonly state: string } | undefined;
      return row ? (JSON.parse(row.state) as MadeState) : {};
    },

    madeContent: (made, version) => {
      const row = database
        .prepare("SELECT content FROM made_contents WHERE made = ? AND version = ?")
        .get(made, version) as { readonly content: string } | undefined;
      return row ? (JSON.parse(row.content) as Readonly<Record<string, unknown>>) : undefined;
    },

    findMotion: (motion) => {
      const row = database.prepare("SELECT body FROM motions WHERE id = ?").get(motion) as
        { readonly body: string } | undefined;
      return row ? (JSON.parse(row.body) as Motion) : undefined;
    },

    listMotions: () =>
      (
        database
          .prepare("SELECT body FROM motions ORDER BY status = 'done', changed_at DESC")
          .all() as unknown as readonly { readonly body: string }[]
      ).map((row) => JSON.parse(row.body) as Motion),

    motionChanges: (motion, limit) =>
      (
        database
          .prepare("SELECT body FROM motion_changes WHERE motion = ? ORDER BY version DESC LIMIT ?")
          .all(motion, limit) as unknown as readonly { readonly body: string }[]
      ).map((row) => JSON.parse(row.body) as MotionChange),

    motionState: (motion) => {
      const row = database.prepare("SELECT state FROM motion_states WHERE motion = ?").get(motion) as
        { readonly state: string } | undefined;
      return row ? (JSON.parse(row.state) as Readonly<Record<string, unknown>>) : {};
    },

    motionTicksSinceLastTurn: () => {
      const since = (
        database.prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM events WHERE type = 'turn.started'").get() as {
          readonly seq: number;
        }
      ).seq;
      const latestState = (motion: string, comparison: "<=" | ">"): Readonly<Record<string, unknown>> | undefined => {
        const row = database
          .prepare(
            `SELECT json_extract(body, '$.state') AS state FROM events WHERE type = 'motion.state'
             AND json_extract(body, '$.motion') = ? AND seq ${comparison} ? ORDER BY seq DESC LIMIT 1`,
          )
          .get(motion, since) as { readonly state: string } | undefined;
        return row ? (JSON.parse(row.state) as Readonly<Record<string, unknown>>) : undefined;
      };
      return (
        database
          .prepare(
            `SELECT DISTINCT json_extract(body, '$.motion') AS motion FROM events
             WHERE type = 'motion.state' AND seq > ? ORDER BY seq`,
          )
          .all(since) as unknown as readonly { readonly motion: string }[]
      ).map(({ motion }) => ({
        motion,
        before: latestState(motion, "<=") ?? {},
        after: latestState(motion, ">") ?? {},
      }));
    },

    keepAttachment: (id) => {
      database.prepare("UPDATE attachments SET kept = 1 WHERE id = ?").run(id);
    },

    answeredAsk: (message) => {
      const answers = messageRow(message)?.answers;
      return answers ? toAskId(answers) : undefined;
    },

    messageAttachments: (message) => {
      const row = messageRow(message);
      return row?.attachments ? (JSON.parse(row.attachments) as Attachment[]) : [];
    },

    pendingWork: (thread) => pendingIn(thread).map((row) => toPendingWork(row)),

    runningTurn: (thread) => {
      const row = database
        .prepare("SELECT * FROM turns WHERE outcome IS NULL AND thread IS ? ORDER BY position DESC LIMIT 1")
        .get(placeOf(thread)) as TurnRow | undefined;
      return row ? toStoredTurn(row) : undefined;
    },

    runningTurns: () =>
      (
        database
          .prepare("SELECT * FROM turns WHERE outcome IS NULL ORDER BY position")
          .all() as unknown as readonly TurnRow[]
      ).map((row) => toStoredTurn(row)),

    waitingThreads: () => [
      ...new Set(
        (
          database
            .prepare(
              `SELECT COALESCE(messages.thread, turns.thread) AS thread FROM pending
               LEFT JOIN messages ON messages.id = pending.message
               LEFT JOIN turns ON turns.id = pending.retry_of
               WHERE COALESCE(messages.thread, turns.thread) IS NOT NULL ORDER BY pending.position`,
            )
            .all() as unknown as readonly { readonly thread: string }[]
        ).map((row) => toThreadId(row.thread)),
      ),
    ],

    findTurn: (turn) => {
      const row = turnRow(turn);
      return row ? toStoredTurn(row) : undefined;
    },

    latestTurn: (thread) => {
      const row = database
        .prepare("SELECT * FROM turns WHERE thread IS ? ORDER BY position DESC LIMIT 1")
        .get(placeOf(thread)) as TurnRow | undefined;
      return row ? toStoredTurn(row) : undefined;
    },

    openMessage: (turn) => {
      const row = database
        .prepare("SELECT id, text FROM messages WHERE turn = ? AND outcome IS NULL ORDER BY position DESC LIMIT 1")
        .get(turn) as { readonly id: string; readonly text: string } | undefined;
      return row ? { id: toMessageId(row.id), text: row.text } : undefined;
    },

    retryFor: (failed) => {
      const row = (database.prepare("SELECT id FROM turns WHERE retry_of = ?").get(failed) ??
        database.prepare("SELECT turn AS id FROM pending WHERE retry_of = ?").get(failed)) as
        { readonly id: string } | undefined;
      return row ? toTurnId(row.id) : undefined;
    },

    requestRetry: (failed, turn) =>
      transaction(() => {
        const existing = (database.prepare("SELECT id FROM turns WHERE retry_of = ?").get(failed) ??
          database.prepare("SELECT turn AS id FROM pending WHERE retry_of = ?").get(failed)) as
          { readonly id: string } | undefined;
        if (existing) return toTurnId(existing.id);
        database.prepare("INSERT INTO pending (kind, turn, retry_of) VALUES ('retry', ?, ?)").run(turn, failed);
        return turn;
      }),

    startTurn: (turn, inputs, retryOf, thread) => {
      record((stamp) => ({
        ...stamp,
        type: "turn.started",
        turn,
        inputs: [...inputs],
        ...(retryOf && { retry_of: retryOf }),
        ...(thread !== undefined && { thread }),
      }));
    },

    setStatus: (turn, status) => {
      record((stamp) => ({ ...stamp, type: "turn.status", turn, ...status }));
    },

    markRead: (turn, message) => {
      record((stamp) => ({ ...stamp, type: "message.read", message, turn }));
    },

    queueMessage: (turn, message) => {
      record((stamp) => ({ ...stamp, type: "message.queued", message, turn }));
    },

    startMessage: (turn, kind) => {
      const id = identifiers.message();
      const thread = turnRow(turn)?.thread ?? undefined;
      record((stamp, position) => ({
        ...stamp,
        type: "message.started",
        message: { id, role: "agent", kind, turn, text: "", at: stamp.at, position, ...(thread && { thread }) },
      }));
      return id;
    },

    startStep: (turn, kind, title, facts) => {
      const id = identifiers.step();
      const started = createCell<Step | undefined>(undefined);
      record((stamp, position) => {
        const step: Step = { ...facts, id, turn, kind, title, at: stamp.at, position };
        started.set(step);
        return { ...stamp, type: "step.started", step };
      });
      const step = started.get();
      if (!step) throw new Error(`step ${id} wasn't recorded`);
      return step;
    },

    updateStep: (step) => {
      record((stamp) => ({ ...stamp, type: "step.updated", step }));
    },

    endStep: (step) => {
      record((stamp) => ({ ...stamp, type: "step.ended", step }));
    },

    findStep: (step) => {
      const row = database.prepare("SELECT body FROM steps WHERE id = ?").get(step) as StepRow | undefined;
      return row ? toStep(row) : undefined;
    },

    openSteps: (turn) =>
      (
        database
          .prepare("SELECT body FROM steps WHERE turn = ? AND outcome IS NULL ORDER BY position")
          .all(turn) as unknown as readonly StepRow[]
      ).map((row) => toStep(row)),

    appendText: (message, text) => {
      const row = messageRow(message);
      record((stamp) => ({
        ...stamp,
        type: "message.delta",
        message,
        offset: row?.text.length ?? 0,
        text,
        ...(row?.thread != null && { thread: row.thread }),
      }));
    },

    endMessage: (message, outcome, length, error) => {
      transaction(() => {
        const before = messageRow(message);
        append({
          id: identifiers.event(),
          type: "message.ended",
          at: now(),
          message,
          outcome,
          length,
          ...(error && { error }),
          ...(before?.thread != null && { thread: before.thread }),
        });
        const row = messageRow(message);
        if (row?.thread == null) return;
        const isNews = row.kind === "reply" && outcome === "completed" && row.text !== "";
        refreshThread(row.thread, (current) =>
          isNews ? { ...current, news: { message: row.id, text: lineOf(row.text), at: row.at } } : current,
        );
      });
    },

    endTurn: (turn, outcome, error) => {
      record((stamp) => ({ ...stamp, type: "turn.ended", turn, outcome, ...(error && { error }) }));
    },

    startAsk: (turn, fields) =>
      transaction(() => {
        const thread = turnRow(turn)?.thread ?? undefined;
        const waiting = waitingRow(thread);
        if (waiting) endAsk(toAsk(waiting), "cancelled");
        const at = now();
        const ask: Ask = {
          id: identifiers.ask(),
          turn,
          kind: fields.kind,
          question: fields.question,
          options: fields.options,
          allows_text: fields.allows_text,
          ...(fields.preview && { preview: fields.preview }),
          ...(fields.attachments && fields.attachments.length > 0 && { attachments: [...fields.attachments] }),
          at,
          position: nextSeq(),
          ...(thread !== undefined && { thread }),
        };
        append({ id: identifiers.event(), type: "ask.started", at, ask });
        return ask;
      }),

    cancelAsk: (ask) =>
      transaction(() => {
        const row = askRow(ask);
        if (!row) return fail("not_found");
        return ok(row.outcome ? toAsk(row) : endAsk(toAsk(row), "cancelled"));
      }),

    findAsk: (ask) => {
      const row = askRow(ask);
      return row ? toAsk(row) : undefined;
    },

    waitingAsk: (thread) => {
      const row = waitingRow(thread);
      return row ? toAsk(row) : undefined;
    },

    registerDevice: (id, registration) => {
      const isNew = database.prepare("SELECT 1 FROM devices WHERE id = ?").get(id) === undefined;
      const device: StoredDevice = {
        id,
        ...registration,
        keyId: toKeyId(registration.notificationKey),
        registeredAt: now(),
      };
      database
        .prepare(
          `INSERT INTO devices (id, apns_token, environment, notification_key, key_id, registered_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT (id) DO UPDATE SET apns_token = excluded.apns_token, environment = excluded.environment,
              notification_key = excluded.notification_key, key_id = excluded.key_id,
              registered_at = excluded.registered_at`,
        )
        .run(id, device.apnsToken, device.environment, device.notificationKey, device.keyId, device.registeredAt);
      return { device, isNew };
    },

    removeDevice: (id) => {
      database.prepare("DELETE FROM devices WHERE id = ?").run(id);
    },

    lastReply: (turn) => {
      const row = database
        .prepare(
          `SELECT id, text FROM messages WHERE turn = ? AND kind = 'reply' AND text != '' AND ${kept} ORDER BY position DESC LIMIT 1`,
        )
        .get(turn) as { readonly id: string; readonly text: string } | undefined;
      return row ? { id: toMessageId(row.id), text: row.text } : undefined;
    },

    devices: () =>
      (database.prepare("SELECT * FROM devices ORDER BY registered_at").all() as unknown as readonly DeviceRow[]).map(
        (row) => toDevice(row),
      ),

    saveAttachment: (attachment, sha256) =>
      transaction(() => {
        const existing = attachmentRow(attachment.id);
        if (existing) {
          return existing.sha256 === sha256
            ? ok({ attachment: JSON.parse(existing.body) as Attachment, isNew: false })
            : fail("id_conflict");
        }
        database
          .prepare("INSERT INTO attachments (id, body, sha256, at) VALUES (?, ?, ?, ?)")
          .run(attachment.id, JSON.stringify(attachment), sha256, now());
        return ok({ attachment, isNew: true });
      }),

    findAttachment: (id) => {
      const row = attachmentRow(id);
      return row ? { attachment: JSON.parse(row.body) as Attachment, sha256: row.sha256 } : undefined;
    },

    sentAttachment: (sha256) =>
      (
        database.prepare("SELECT id FROM attachments WHERE sha256 = ? AND message IS NOT NULL LIMIT 1").get(sha256) as
          { readonly id: string } | undefined
      )?.id,

    unattachedBefore: (before) =>
      (
        database
          .prepare("SELECT id FROM attachments WHERE message IS NULL AND kept = 0 AND at < ?")
          .all(before) as unknown as readonly {
          readonly id: string;
        }[]
      ).map((row) => row.id),

    deleteAttachment: (id) => {
      database.prepare("DELETE FROM attachments WHERE id = ? AND message IS NULL").run(id);
    },

    pairedTokenHashes: () =>
      (database.prepare("SELECT hash FROM tokens").all() as unknown as readonly { readonly hash: string }[]).map(
        (row) => row.hash,
      ),

    clearPairing: () => {
      transaction(() => {
        database.prepare("DELETE FROM tokens").run();
        database.prepare("DELETE FROM pairing_codes").run();
      });
    },

    createPairingCode: (hash, expiresAt) => {
      database.prepare("INSERT OR REPLACE INTO pairing_codes (hash, expires_at) VALUES (?, ?)").run(hash, expiresAt);
    },

    forgetPairingCode: (hash) => {
      database.prepare("DELETE FROM pairing_codes WHERE hash = ? AND device_name IS NULL").run(hash);
    },

    pairDevice: (codeHash, deviceName, tokenHash) =>
      transaction(() => {
        const used = database
          .prepare("UPDATE pairing_codes SET device_name = ? WHERE hash = ? AND device_name IS NULL AND expires_at > ?")
          .run(deviceName, codeHash, now());
        if (used.changes === 0) return false;
        database
          .prepare("INSERT INTO tokens (hash, device_name, created_at) VALUES (?, ?, ?)")
          .run(tokenHash, deviceName, now());
        return true;
      }),

    pairingCode: (hash) => {
      const row = database.prepare("SELECT expires_at, device_name FROM pairing_codes WHERE hash = ?").get(hash) as
        { readonly expires_at: string; readonly device_name: string | null } | undefined;
      return row ? { expiresAt: row.expires_at, deviceName: row.device_name ?? undefined } : undefined;
    },

    setting: readSetting,

    setSetting: writeSetting,

    importEvents: (events) => {
      transaction(() => {
        for (const event of events) append(event);
      });
    },

    compact: (before) => {
      const { through } = database
        .prepare(`SELECT MAX(seq) AS through FROM events WHERE type IN ${compactedTypes} AND at < ?`)
        .get(before) as { readonly through: number | null };
      if (through === null) return;
      transaction(() => {
        database.prepare(`DELETE FROM events WHERE type IN ${compactedTypes} AND seq <= ?`).run(through);
        const compacted = Math.max(through, compactedThrough());
        writeSetting(compactedSetting, String(compacted));
      });
    },

    backupTo: (filePath) => {
      database.prepare("VACUUM INTO ?").run(filePath);
    },

    close: () => {
      database.close();
    },
  };
};
