import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { createCell } from "#cell.ts";
import { toTimestamp, type Clock } from "#clock.ts";
import {
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
  Error as ErrorBody,
  LiveTurn,
  Message,
  Outcome,
  Snapshot,
  Status,
  Step,
  StepKind,
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
  readonly hasMore: boolean;
};

export type AcceptFailure = "id_conflict" | "unknown_ask" | "unknown_attachment" | "attachment_taken";

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
    answers?: AskId,
    attachments?: readonly string[],
  ) => Result<Accepted, AcceptFailure>;
  readonly saveAttachment: (attachment: Attachment, sha256: string) => Result<SavedAttachment, "id_conflict">;
  readonly findAttachment: (id: string) => { readonly attachment: Attachment; readonly sha256: string } | undefined;
  readonly unattachedBefore: (before: string) => readonly string[];
  readonly deleteAttachment: (id: string) => void;
  readonly pairedTokenHashes: () => readonly string[];
  readonly addToken: (hash: string, deviceName: string) => void;
  readonly clearPairedTokens: () => void;
  readonly createPairingCode: (hash: string, expiresAt: string) => void;
  readonly usePairingCode: (hash: string, deviceName: string) => boolean;
  readonly pairingCode: (hash: string) => PairingCode | undefined;
  readonly listMessages: (before: MessageId, limit: number) => Result<Page, "not_found">;
  readonly messageText: (message: MessageId) => string | undefined;
  readonly messageAttachments: (message: MessageId) => readonly Attachment[];
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
  readonly secret: number;
  readonly attachments: string | null;
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
        ...(row.secret === 1 && { secret: true }),
        ...(row.attachments && { attachments: JSON.parse(row.attachments) as Attachment[] }),
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
          turn: turn ? toLiveTurn(turn) : null,
          next: next.map((row) => row.message),
        },
      };
    },

    acceptMessage: (id, text, answers, attachments = []) =>
      transaction(() => {
        const existing = messageRow(id);
        if (existing) {
          const isSame = existing.secret === 1 || existing.text === text;
          return isSame ? ok({ message: toMessage(existing), isNew: false }) : fail("id_conflict");
        }
        const named = answers === undefined ? undefined : askRow(answers);
        if (answers !== undefined && !named) return fail("unknown_ask");
        const attachedRows = attachments.map((attachment) => attachmentRow(attachment));
        if (attachedRows.includes(undefined)) return fail("unknown_attachment");
        if (attachedRows.some((row) => row?.message !== null)) return fail("attachment_taken");
        const attached = attachedRows.flatMap((row) => (row ? [JSON.parse(row.body) as Attachment] : []));
        const isSecret = named !== undefined && toAsk(named).secret;
        const waiting = waitingRow();
        const at = now();
        const message: Message = {
          id,
          role: "user",
          text: isSecret ? "" : text,
          at,
          position: nextSeq(),
          ...(waiting && { answers: toAsk(waiting).id }),
          ...(isSecret && { secret: true }),
          ...(attached.length > 0 && { attachments: attached }),
        };
        append({ id: identifiers.event(), type: "message.accepted", at, message });
        if (waiting) endAsk(toAsk(waiting), "answered", id);
        return ok({ message, isNew: true });
      }),

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
        hasMore: rows.length > limit,
      });
    },

    messageText: (message) => messageRow(message)?.text,

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
          secret: fields.secret,
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

    unattachedBefore: (before) =>
      (
        database
          .prepare("SELECT id FROM attachments WHERE message IS NULL AND at < ?")
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

    addToken: (hash, deviceName) => {
      database
        .prepare("INSERT INTO tokens (hash, device_name, created_at) VALUES (?, ?, ?)")
        .run(hash, deviceName, now());
    },

    clearPairedTokens: () => {
      database.prepare("DELETE FROM tokens").run();
    },

    createPairingCode: (hash, expiresAt) => {
      database.prepare("INSERT OR REPLACE INTO pairing_codes (hash, expires_at) VALUES (?, ?)").run(hash, expiresAt);
    },

    usePairingCode: (hash, deviceName) =>
      transaction(() => {
        const used = database
          .prepare("UPDATE pairing_codes SET device_name = ? WHERE hash = ? AND device_name IS NULL AND expires_at > ?")
          .run(deviceName, hash, now());
        return used.changes > 0;
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
