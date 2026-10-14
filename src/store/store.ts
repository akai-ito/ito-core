import type { DatabaseSync } from "node:sqlite";
import { createCell } from "#cell.ts";
import { toTimestamp, type Clock } from "#clock.ts";
import { toMessageId, toTurnId, type EventId, type MessageId, type TurnId } from "#conversation/ids.ts";
import type { Identifiers } from "#identifiers.ts";
import type {
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
import type { StepFacts } from "#engine/engine.ts";
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
  readonly hasMore: boolean;
};

export type Settings = {
  readonly setting: (key: string) => string | undefined;
  readonly setSetting: (key: string, value: string) => void;
};

export type Store = Settings & {
  readonly subscribe: (listener: Listener) => () => void;
  readonly eventsAfter: (cursor: EventId) => Result<readonly LogEntry[], ReplayGap>;
  readonly snapshot: (reason: Snapshot["reason"]) => SnapshotEntry;
  readonly acceptMessage: (id: MessageId, text: string) => Result<Accepted, "id_conflict">;
  readonly listMessages: (before: MessageId, limit: number) => Result<Page, "not_found">;
  readonly messageText: (message: MessageId) => string | undefined;
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
    ? { id: row.id, role: "user", text: row.text, at: row.at, position: row.position }
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
          turn: turn ? toLiveTurn(turn) : null,
          next: next.map((row) => row.message),
        },
      };
    },

    acceptMessage: (id, text) =>
      transaction(() => {
        const existing = messageRow(id);
        if (existing)
          return existing.text === text ? ok({ message: toMessage(existing), isNew: false }) : fail("id_conflict");
        const at = now();
        const message: Message = { id, role: "user", text, at, position: nextSeq() };
        append({ id: identifiers.event(), type: "message.accepted", at, message });
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
        hasMore: rows.length > limit,
      });
    },

    messageText: (message) => messageRow(message)?.text,

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
