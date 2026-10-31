import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { createCell } from "#cell.ts";
import { toTimestamp, type Clock } from "#clock.ts";
import {
  toAskId,
  toDeviceId,
  toMessageId,
  toTurnId,
  type AskId,
  type DeviceId,
  type EventId,
  type MessageId,
  type TurnId,
} from "#conversation/ids.ts";
import type { Identifiers } from "#identifiers.ts";
import type {
  Ask,
  Attachment,
  Call,
  Desk,
  Error as ErrorBody,
  Spoken,
  LiveTurn,
  Message,
  Motion,
  MotionChange,
  Outcome,
  Snapshot,
  Status,
  Step,
  StepKind,
  Topic,
  VoiceState,
} from "#protocol/types.ts";
import { fail, ok, type Result } from "#result.ts";
import type { AskFields, StepFacts } from "#engine/engine.ts";
import { project, type LoggedEvent } from "#store/projection.ts";

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
  readonly hasStartedReply: boolean;
  readonly outcome: Outcome | undefined;
};

export type OpenMessage = { readonly id: MessageId; readonly text: string };

export type Accepted = { readonly message: Message; readonly isNew: boolean };

export type Page = {
  readonly messages: readonly Message[];
  readonly steps: readonly Step[];
  readonly asks: readonly Ask[];
  readonly calls: readonly Call[];
  readonly topics: readonly Topic[];
  readonly hasMore: boolean;
};

export type Exchange = {
  readonly turn: TurnId;
  readonly position: number;
  readonly said: string;
  readonly answered: string;
};

export type AcceptFailure = "id_conflict" | "unknown_attachment" | "attachment_taken" | "call_not_on";

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
  ) => Result<Accepted, AcceptFailure>;
  readonly amendMessage: (
    id: MessageId,
    text: string,
    audio: string,
  ) => Result<{ readonly message: Message; readonly replaced?: string }, "not_spoken" | "unknown_attachment">;
  readonly startCall: (id: string) => StartedCall;
  readonly endCall: (id: string, reason?: string) => Call | undefined;
  readonly deleteCallAudio: (id: string) => DeletedAudio | undefined;
  readonly recordVoiceStatus: (state: VoiceState, reason?: string) => void;
  readonly latestCall: () => Call | undefined;
  readonly exchanges: (through: TurnId | undefined, limit: number) => readonly Exchange[];
  readonly listTopics: () => readonly Topic[];
  readonly startTopic: (position: number, label: string) => Result<Topic, "marked">;
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
  readonly keepAttachment: (id: string) => void;
  readonly messageAttachments: (message: MessageId) => readonly Attachment[];
  readonly answeredAsk: (message: MessageId) => AskId | undefined;
  readonly pendingWork: () => readonly PendingWork[];
  readonly runningTurn: () => StoredTurn | undefined;
  readonly findTurn: (turn: TurnId) => StoredTurn | undefined;
  readonly openMessage: (turn: TurnId) => OpenMessage | undefined;
  readonly retryFor: (failed: TurnId) => TurnId | undefined;
  readonly requestRetry: (failed: TurnId, turn: TurnId) => TurnId;
  readonly startTurn: (turn: TurnId, inputs: readonly MessageId[], retryOf?: TurnId) => void;
  readonly setStatus: (turn: TurnId, status: Status) => void;
  readonly markRead: (turn: TurnId, message: MessageId) => void;
  readonly queueMessage: (turn: TurnId, message: MessageId) => void;
  readonly startMessage: (turn: TurnId, kind: MessageKind) => MessageId;
  readonly startStep: (turn: TurnId, kind: StepKind, title: string, facts: StepFacts) => Step;
  readonly updateStep: (step: Step) => void;
  readonly endStep: (step: Step) => void;
  readonly openSteps: (turn: TurnId) => readonly Step[];
  readonly appendText: (message: MessageId, text: string) => void;
  readonly endMessage: (message: MessageId, outcome: Outcome, length: number, error?: ErrorBody) => void;
  readonly endTurn: (turn: TurnId, outcome: Outcome, error?: ErrorBody) => void;
  readonly startAsk: (turn: TurnId, fields: AskFields) => Ask;
  readonly cancelAsk: (ask: AskId) => Result<Ask, "not_found">;
  readonly findAsk: (ask: AskId) => Ask | undefined;
  readonly waitingAsk: () => Ask | undefined;
  readonly isReminded: (ask: AskId) => boolean;
  readonly markReminded: (ask: AskId) => void;
  readonly registerDevice: (
    id: DeviceId,
    registration: Registration,
  ) => { readonly device: StoredDevice; readonly isNew: boolean };
  readonly removeDevice: (id: DeviceId) => void;
  readonly lastReply: (turn: TurnId) => OpenMessage | undefined;
  readonly devices: () => readonly StoredDevice[];
  readonly importEvents: (events: readonly LoggedEvent[]) => void;
  readonly compactText: (before: string) => void;
  readonly backupTo: (filePath: string) => void;
  readonly close: () => void;
};

type MessageRow = {
  readonly id: string;
  readonly position: number;
  readonly role: "user" | "agent";
  readonly kind: MessageKind | null;
  readonly turn: string | null;
  readonly text: string;
  readonly at: string;
  readonly ended_at: string | null;
  readonly outcome: Outcome | null;
  readonly error: string | null;
  readonly answers: string | null;
  readonly attachments: string | null;
  readonly spoken: string | null;
};

type AttachmentRow = { readonly body: string; readonly sha256: string; readonly message: string | null };

type AskRow = { readonly body: string; readonly reminded: number };

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
      }
    : {
        id: row.id,
        role: "agent",
        kind: row.kind ?? "reply",
        turn: row.turn ?? "",
        text: row.text,
        at: row.at,
        position: row.position,
        ...(row.ended_at && { ended_at: row.ended_at }),
        ...(row.outcome && { outcome: row.outcome }),
        ...(row.error && { error: JSON.parse(row.error) as ErrorBody }),
      };

const toStoredTurn = (row: TurnRow): StoredTurn => ({
  id: toTurnId(row.id),
  inputs: parseIds(row.inputs).map((input) => toMessageId(input)),
  hasStartedReply: row.has_started_reply === 1,
  outcome: row.outcome ?? undefined,
});

const toLiveTurn = (row: TurnRow): LiveTurn => ({
  id: row.id,
  inputs: [...parseIds(row.inputs)],
  read: [...parseIds(row.read)],
  ...(row.retry_of && { retry_of: row.retry_of }),
  status: row.status ? (JSON.parse(row.status) as Status) : null,
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

  const stepsFrom = (from: number, until = Number.MAX_SAFE_INTEGER): readonly Step[] =>
    (
      database
        .prepare("SELECT body FROM steps WHERE position >= ? AND position < ? ORDER BY position")
        .all(from, until) as unknown as readonly StepRow[]
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

  const topicsFrom = (from: number, until = Number.MAX_SAFE_INTEGER): readonly Topic[] =>
    (
      database
        .prepare("SELECT body FROM topics WHERE position >= ? AND position < ? ORDER BY position")
        .all(from, until) as unknown as readonly { readonly body: string }[]
    ).map((row) => JSON.parse(row.body) as Topic);

  const asksFrom = (from: number, until = Number.MAX_SAFE_INTEGER): readonly Ask[] =>
    (
      database
        .prepare("SELECT body, reminded FROM asks WHERE position >= ? AND position < ? ORDER BY position")
        .all(from, until) as unknown as readonly AskRow[]
    ).map((row) => toAsk(row));

  const askRow = (id: string): (AskRow & { readonly outcome: string | null }) | undefined =>
    database.prepare("SELECT body, reminded, outcome FROM asks WHERE id = ?").get(id) as
      (AskRow & { readonly outcome: string | null }) | undefined;

  const waitingRow = (): AskRow | undefined =>
    database.prepare("SELECT body, reminded FROM asks WHERE outcome IS NULL ORDER BY position DESC LIMIT 1").get() as
      AskRow | undefined;

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

  const currentDesk = (): Desk => {
    const row = database.prepare("SELECT body FROM desk WHERE id = 1").get() as { readonly body: string } | undefined;
    return row ? (JSON.parse(row.body) as Desk) : { coming_up: [], waiting: [] };
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
      const rows = database
        .prepare("SELECT * FROM messages ORDER BY position DESC LIMIT ?")
        .all(snapshotSize + 1) as unknown as readonly MessageRow[];
      const turn = database
        .prepare("SELECT * FROM turns WHERE outcome IS NULL ORDER BY position DESC LIMIT 1")
        .get() as TurnRow | undefined;
      const next = database
        .prepare("SELECT message FROM pending WHERE kind = 'message' ORDER BY position")
        .all() as unknown as readonly { readonly message: string }[];
      const window = rows.slice(0, snapshotSize).toReversed();
      return {
        seq: latest?.seq ?? 0,
        event: {
          ...(latest && { id: latest.id }),
          type: "snapshot",
          at: now(),
          reason,
          messages: window.map((row) => toMessage(row)),
          has_more: rows.length > snapshotSize,
          steps: window[0] ? [...stepsFrom(window[0].position)] : [],
          asks: window[0] ? [...asksFrom(window[0].position)] : [],
          calls: [...callsFrom((rows[snapshotSize]?.position ?? 0) + 1)],
          topics: [...topicsFrom((rows[snapshotSize]?.position ?? 0) + 1)],
          turn: turn ? toLiveTurn(turn) : null,
          next: next.map((row) => row.message),
          desk: currentDesk(),
        },
      };
    },

    acceptMessage: (id, text, attachments = [], spoken) =>
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
        const waiting = waitingRow();
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
        };
        append({ id: identifiers.event(), type: "message.accepted", at, message });
        if (waiting) endAsk(toAsk(waiting), "answered", id);
        return ok({ message, isNew: true });
      }),

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

    exchanges: (through, limit) => {
      const until = through === undefined ? Number.MAX_SAFE_INTEGER : (turnRow(through)?.position ?? -1);
      const rows = database
        .prepare("SELECT * FROM turns WHERE outcome IS NOT NULL AND position <= ? ORDER BY position DESC LIMIT ?")
        .all(until, limit) as unknown as readonly TurnRow[];
      return rows.toReversed().map((row) => {
        const inputs = parseIds(row.inputs).flatMap((id) => messageRow(id) ?? []);
        const replies = database
          .prepare("SELECT text FROM messages WHERE turn = ? AND kind = 'reply' ORDER BY position")
          .all(row.id) as unknown as readonly { readonly text: string }[];
        return {
          turn: toTurnId(row.id),
          position: inputs[0]?.position ?? row.position,
          said: inputs.map(({ text }) => text).join("\n\n"),
          answered: replies.map(({ text }) => text).join("\n\n"),
        };
      });
    },

    listTopics: () => topicsFrom(0),

    startTopic: (position, label) =>
      transaction(() => {
        if (database.prepare("SELECT id FROM topics WHERE position = ?").get(position)) return fail("marked");
        const at = now();
        const topic: Topic = { id: identifiers.topic(), label, position, at };
        append({ id: identifiers.event(), type: "topic.started", at, topic });
        return ok(topic);
      }),

    latestCall: () => {
      const row = database.prepare("SELECT body FROM calls ORDER BY position DESC LIMIT 1").get() as
        { readonly body: string } | undefined;
      return row ? (JSON.parse(row.body) as Call) : undefined;
    },

    listMessages: (before, limit) => {
      const anchor = database.prepare("SELECT position FROM messages WHERE id = ?").get(before) as
        { readonly position: number } | undefined;
      if (!anchor) return fail("not_found");
      const rows = database
        .prepare("SELECT * FROM messages WHERE position < ? ORDER BY position DESC LIMIT ?")
        .all(anchor.position, limit + 1) as unknown as readonly MessageRow[];
      const page = rows.slice(0, limit).toReversed();
      return ok({
        messages: page.map((row) => toMessage(row)),
        steps: page[0] ? stepsFrom(page[0].position, anchor.position) : [],
        asks: page[0] ? asksFrom(page[0].position, anchor.position) : [],
        calls: callsFrom((rows[limit]?.position ?? 0) + 1, anchor.position),
        topics: topicsFrom((rows[limit]?.position ?? 0) + 1, anchor.position),
        hasMore: rows.length > limit,
      });
    },

    messageText: (message) => messageRow(message)?.text,

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

    pendingWork: () =>
      (database.prepare("SELECT * FROM pending ORDER BY position").all() as unknown as readonly PendingRow[]).map(
        (row) => toPendingWork(row),
      ),

    runningTurn: () => {
      const row = database.prepare("SELECT * FROM turns WHERE outcome IS NULL ORDER BY position DESC LIMIT 1").get() as
        TurnRow | undefined;
      return row ? toStoredTurn(row) : undefined;
    },

    findTurn: (turn) => {
      const row = turnRow(turn);
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

    startTurn: (turn, inputs, retryOf) => {
      record((stamp) => ({
        ...stamp,
        type: "turn.started",
        turn,
        inputs: [...inputs],
        ...(retryOf && { retry_of: retryOf }),
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
      record((stamp, position) => ({
        ...stamp,
        type: "message.started",
        message: { id, role: "agent", kind, turn, text: "", at: stamp.at, position },
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

    openSteps: (turn) =>
      (
        database
          .prepare("SELECT body FROM steps WHERE turn = ? AND outcome IS NULL ORDER BY position")
          .all(turn) as unknown as readonly StepRow[]
      ).map((row) => toStep(row)),

    appendText: (message, text) => {
      const row = messageRow(message);
      record((stamp) => ({ ...stamp, type: "message.delta", message, offset: row?.text.length ?? 0, text }));
    },

    endMessage: (message, outcome, length, error) => {
      record((stamp) => ({ ...stamp, type: "message.ended", message, outcome, length, ...(error && { error }) }));
    },

    endTurn: (turn, outcome, error) => {
      record((stamp) => ({ ...stamp, type: "turn.ended", turn, outcome, ...(error && { error }) }));
    },

    startAsk: (turn, fields) =>
      transaction(() => {
        const waiting = waitingRow();
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

    waitingAsk: () => {
      const row = waitingRow();
      return row ? toAsk(row) : undefined;
    },

    isReminded: (ask) => askRow(ask)?.reminded === 1,

    markReminded: (ask) => {
      database.prepare("UPDATE asks SET reminded = 1 WHERE id = ?").run(ask);
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
          "SELECT id, text FROM messages WHERE turn = ? AND kind = 'reply' AND text != '' ORDER BY position DESC LIMIT 1",
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

    compactText: (before) => {
      const { through } = database
        .prepare("SELECT MAX(seq) AS through FROM events WHERE type = 'message.delta' AND at < ?")
        .get(before) as { readonly through: number | null };
      if (through === null) return;
      transaction(() => {
        database.prepare("DELETE FROM events WHERE type = 'message.delta' AND seq <= ?").run(through);
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
