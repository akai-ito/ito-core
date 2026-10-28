import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { isImage, readDimensions } from "#attachments/media.ts";
import { createCell } from "#cell.ts";
import { toFailedText, toFirstLine, toReminderText } from "#notifications/text.ts";
import type {
  Ask,
  AskKind,
  Attachment,
  AskOption,
  Call,
  Correction,
  Error as ErrorBody,
  LiveTurn,
  Message,
  MessageKind,
  Notification,
  Outcome,
  Status,
  StatusKind,
  Step,
  StepKind,
  VoiceState,
} from "#protocol/types.ts";
import type { Event, Line } from "./spec.ts";
import { fixtureDirectory } from "./transcript-files.ts";
import type { Term } from "#memory/vocabulary.ts";
import { correct } from "#voice/corrector.ts";
import { askAloud, createSentenceFeed, type SentenceFeed } from "#voice/spoken.ts";

export type Header = {
  readonly name: string;
  readonly scenario: number;
  readonly title: string;
  readonly summary: string;
  readonly guarantees: readonly string[];
};

type Fields = Readonly<Record<string, unknown>>;

type HttpHeaders = Readonly<Record<string, string>>;

type AppStart = { readonly cursor?: string; readonly oldestCached?: string };

type RequestOptions = {
  readonly body?: unknown;
  readonly headers?: HttpHeaders;
  readonly bodyFile?: string;
  readonly bodySize?: number;
};

type ResponseOptions = { readonly headers?: HttpHeaders; readonly isLost?: boolean };

type SendOptions = {
  readonly id?: string;
  readonly isLost?: boolean;
  readonly answers?: string;
  readonly attachments?: readonly string[];
};

type UploadOptions = { readonly id?: string; readonly name?: string; readonly isLost?: boolean };

type AskFields = {
  readonly kind?: AskKind;
  readonly question: string;
  readonly options?: readonly AskOption[];
  readonly allowsText?: boolean;
  readonly preview?: string;
  readonly secret?: boolean;
};

type Device = { readonly id: string; readonly isLooking: boolean };

type WriteOptions = { readonly pieces?: number; readonly everyMs?: number };

type EndOptions = { readonly length?: number; readonly error?: ErrorBody };

type Cut = { readonly message: string; readonly offset: number };

type Exchange = { readonly user: string; readonly agent: string; readonly turn: string };

type StepOptions = {
  readonly title: string;
  readonly endedTitle: string;
  readonly fields?: Fields;
  readonly detail?: string;
};

type StepEnd = { readonly outcome?: Outcome; readonly fields?: Fields; readonly id?: string };

type StepUpdate = { readonly detail?: string; readonly id?: string };

type RunningStep = { readonly step: Step; readonly endedTitle: string };

export type Transcript = {
  readonly header: Header;
  readonly lines: () => readonly Line[];
  readonly time: (iso: string) => void;
  readonly wait: (durationMs: number) => void;
  readonly begin: (iso: string, app?: AppStart) => void;
  readonly latestEventId: () => string | undefined;
  readonly stepAtOffset: (offsetMs: number) => number;
  readonly world: (marker: string, fields?: Fields) => void;
  readonly request: (method: string, path: string, options?: RequestOptions) => void;
  readonly response: (status: number, body: unknown, options?: ResponseOptions) => void;
  readonly connect: (options?: { readonly headers?: HttpHeaders }) => void;
  readonly disconnect: (marker: string, fields?: Fields) => void;
  readonly stall: (durationMs: number) => void;
  readonly exchange: (user: string, agent: string, files?: readonly string[]) => Exchange;
  readonly callExchange: (user: string, agent: string, corrections: readonly Correction[], recording: string) => string;
  readonly send: (text: string, options?: SendOptions) => string;
  readonly startTurn: (inputs: readonly string[], options?: { readonly retryOf?: string }) => string;
  readonly status: (kind: StatusKind, label: string, detail?: string) => void;
  readonly step: (kind: StepKind, options: StepOptions) => string;
  readonly updateStep: (fields: Fields, update?: StepUpdate) => void;
  readonly endStep: (end?: StepEnd) => void;
  readonly read: (message: string) => void;
  readonly queue: (message: string) => void;
  readonly reply: (kind?: MessageKind) => string;
  readonly write: (text: string, options?: WriteOptions) => void;
  readonly endMessage: (outcome: Outcome, options?: EndOptions) => void;
  readonly endTurn: (outcome: Outcome, error?: ErrorBody) => string;
  readonly stop: (turn: string, cut?: Cut) => void;
  readonly retry: (failed: string) => string;
  readonly ask: (fields: AskFields) => string;
  readonly cancelAsk: (ask: string) => void;
  readonly registerDevice: () => string;
  readonly presence: (isLooking: boolean) => void;
  readonly remind: () => void;
  readonly upload: (file: string, options?: UploadOptions) => string;
  readonly uploadTooLarge: (name: string, size: number) => void;
  readonly forgetUnsentUploads: () => void;
  readonly fetchAttachment: (id: string) => void;
  readonly showPairingCode: (code: string) => void;
  readonly pair: (code: string, deviceName: string, token: string) => void;
  readonly listMessages: (before: string, limit: number) => void;
  readonly startCall: () => string;
  readonly endCall: (call: string) => void;
  readonly deleteCallAudio: (call: string) => void;
  readonly voiceStatus: (state: VoiceState, reason?: string) => void;
  readonly approval: (fields: AskFields) => string;
  readonly openStream: (call: string) => void;
  readonly appFrame: (frame: Fields) => void;
  readonly appAudio: (file: string) => void;
  readonly youSay: (file: string, raw: string, options?: YouSayOptions) => string;
  readonly speak: (texts: readonly string[]) => readonly string[];
  readonly played: (id: string, isCut?: boolean) => void;
  readonly unplayed: () => readonly string[];
  readonly hangUp: () => void;
  readonly voiceFails: (reason: string) => void;
  readonly streamTimesOut: () => void;
  readonly change: () => string;
  readonly restart: () => void;
  readonly restore: (to: string) => void;
  readonly toJsonl: () => string;
};

type IdPrefix = "e" | "m" | "t" | "s" | "a" | "c" | "f";

type CallState = "listening" | "hearing" | "turn_ended" | "working" | "speaking";

type CallModel = {
  readonly call: string;
  readonly state: CallState;
  readonly isAttached: boolean;
  readonly unplayed: readonly string[];
  readonly sentences: number;
  readonly feeds: ReadonlyMap<string, SentenceFeed>;
};

type YouSayOptions = { readonly heard?: readonly string[]; readonly vocabulary?: readonly Term[] };

const cannedAudioMs = 250;

type Counters = Readonly<Record<IdPrefix, number>>;

type Ids = { readonly boot: number; readonly counters: Counters; readonly issued: ReadonlySet<string> };

type Start = { readonly at: number; readonly cursor: string | undefined; readonly oldestCached: string | undefined };

type Projection = {
  readonly order: readonly string[];
  readonly byId: ReadonlyMap<string, Message>;
  readonly steps: ReadonlyMap<string, Step>;
  readonly asks: ReadonlyMap<string, Ask>;
  readonly calls: ReadonlyMap<string, Call>;
};

type SnapshotReason = "no_cursor" | "cursor_unknown" | "too_far_behind";

// Digits only, so no id can read as a word, or as a misspelling to a spell checker.
const idCharacters = "0123456789";
const serialDigits = 4;
const tokenDigits = 5;
const defaultPieceLength = 28;
const defaultPieceIntervalMs = 120;
const messagesPerSnapshot = 50;
const reminderAfterMs = 3 * 60 * 60 * 1000;
const mediaTypes: Readonly<Record<string, string>> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  csv: "text/csv",
  mov: "video/quicktime",
  m4a: "audio/mp4",
};

const mediaTypeOf = (name: string): string => mediaTypes[name.split(".").at(-1) ?? ""] ?? "application/octet-stream";

const toToken = (seed: string): string => {
  const digest = createHash("sha256").update(seed).digest();
  return Array.from({ length: tokenDigits }, (_, index) =>
    idCharacters.charAt((digest[index] ?? 0) % idCharacters.length),
  ).join("");
};

const toUuid = (seed: string): string => {
  const hex = createHash("sha256").update(seed).digest("hex");
  const variant = "89ab".charAt(Number.parseInt(hex.charAt(16), 16) % 4);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};

const projectEvent = (projection: Projection, event: Event): Projection => {
  const { order, byId } = projection;
  switch (event.type) {
    case "message.accepted":
    case "message.started": {
      const message = event.message as Message;
      return { ...projection, order: [...order, message.id], byId: new Map(byId).set(message.id, message) };
    }
    case "step.started":
    case "step.updated":
    case "step.ended": {
      const step = event.step as Step;
      return { ...projection, steps: new Map(projection.steps).set(step.id, step) };
    }
    case "ask.started":
    case "ask.ended": {
      const ask = event.ask as Ask;
      return { ...projection, asks: new Map(projection.asks).set(ask.id, ask) };
    }
    case "call.started":
    case "call.ended": {
      const call = event.call as Call;
      return { ...projection, calls: new Map(projection.calls).set(call.id, call) };
    }
    case "call.audio_deleted": {
      const call = event.call as Call;
      const silenced = byId
        .values()
        .filter((message) => message.spoken?.call === call.id && message.spoken.audio)
        .map((message) => {
          const corrections = message.spoken?.corrections;
          const spoken = { call: call.id, ...(corrections && { corrections }) };
          return [message.id, { ...message, spoken }] as const;
        })
        .toArray();
      return {
        ...projection,
        calls: new Map(projection.calls).set(call.id, call),
        byId: new Map([...byId, ...silenced]),
      };
    }
    case "message.delta": {
      const message = byId.get(event.message as string);
      if (!message) throw new Error(`text for unknown message ${String(event.message)}`);
      if (event.offset !== message.text.length) {
        throw new Error(`text at offset ${String(event.offset)}, but ${message.id} has length ${message.text.length}`);
      }
      return {
        ...projection,
        byId: new Map(byId).set(message.id, { ...message, text: message.text + (event.text as string) }),
      };
    }
    case "message.ended": {
      const message = byId.get(event.message as string);
      if (!message) throw new Error(`end of unknown message ${String(event.message)}`);
      const length = event.length as number;
      if (length > message.text.length) throw new Error(`${message.id} ended longer than its text`);
      if (event.outcome === "completed" && length !== message.text.length) {
        throw new Error(`${message.id} completed shorter than its text`);
      }
      const error = event.error as ErrorBody | undefined;
      const ended: Message = {
        ...message,
        text: message.text.slice(0, length),
        outcome: event.outcome as Outcome,
        ended_at: event.at,
        ...(error && { error }),
      };
      return { ...projection, byId: new Map(byId).set(message.id, ended) };
    }
    default: {
      return projection;
    }
  }
};

const project = (log: readonly Event[]): Projection =>
  log.reduce<Projection>(projectEvent, {
    order: [],
    byId: new Map(),
    steps: new Map(),
    asks: new Map(),
    calls: new Map(),
  });

const positionBefore = (order: readonly string[], byId: ReadonlyMap<string, Message>, index: number): number =>
  index > 0 ? (byId.get(order[index - 1] ?? "")?.position ?? 0) : 0;

const callsFrom = (calls: ReadonlyMap<string, Call>, from: number, until = Infinity): readonly Call[] =>
  calls
    .values()
    .filter((call) => (call.position >= from && call.position < until) || (until === Infinity && !call.ended_at))
    .toArray()
    .toSorted((left, right) => left.position - right.position);

const between = <Entry extends { readonly position: number }>(
  entries: ReadonlyMap<string, Entry>,
  from: number,
  until = Infinity,
): readonly Entry[] =>
  entries
    .values()
    .filter((entry) => entry.position >= from && entry.position < until)
    .toArray()
    .toSorted((left, right) => left.position - right.position);

const statusKindFor = (kind: StepKind): StatusKind => {
  if (kind === "thinking" || kind === "plan") return "thinking";
  return kind === "wait" || kind === "compacting" ? "waiting" : "working";
};

const toPieces = (rest: string, target: number): readonly string[] => {
  if (rest.length > target) {
    const lastSpace = rest.lastIndexOf(" ", target);
    const cut = lastSpace <= 0 ? rest.indexOf(" ", target) : lastSpace;
    if (cut > 0) return [rest.slice(0, cut + 1), ...toPieces(rest.slice(cut + 1), target)];
  }
  return rest ? [rest] : [];
};

const splitIntoPieces = (text: string, pieces?: number): readonly string[] =>
  pieces === 1 ? [text] : toPieces(text, pieces ? Math.ceil(text.length / pieces) : defaultPieceLength);

const idsIn = (value: unknown): readonly string[] => {
  if (typeof value === "string") return /^[emstacf]_\d{4}_/.test(value) ? [value] : [];
  if (Array.isArray(value)) return value.flatMap(idsIn);
  return value && typeof value === "object" ? Object.values(value).flatMap(idsIn) : [];
};

const toCounters = (log: readonly Event[]): Counters => {
  const ids = log.flatMap(idsIn);
  const highest = (prefix: IdPrefix): number =>
    ids.filter((id) => id.startsWith(`${prefix}_`)).reduce((max, id) => Math.max(max, Number(id.split("_", 2)[1])), 0);
  return {
    e: highest("e"),
    m: highest("m"),
    t: highest("t"),
    s: highest("s"),
    a: highest("a"),
    c: highest("c"),
    f: highest("f"),
  };
};

// A small model of the server's event log. Scenarios drive it the way the server and an app would,
// and it records what crosses the API, so offsets, ids and delivery after a disconnect can't drift.
export const createTranscript = (header: Header): Transcript => {
  const lines = createCell<readonly Line[]>([]);
  const log = createCell<readonly Event[]>([]);
  const ids = createCell<Ids>({ boot: 1, counters: { e: 0, m: 0, t: 0, s: 0, a: 0, c: 0, f: 0 }, issued: new Set() });
  const callModel = createCell<CallModel | undefined>(undefined);
  const approvals = createCell<ReadonlySet<string>>(new Set());
  const observer = createCell<((type: string, fields: Fields) => void) | undefined>(undefined);
  const users = createCell(0);
  const now = createCell(0);
  const start = createCell<Start | undefined>(undefined);
  const isConnected = createCell(false);
  const cursor = createCell<string | undefined>(undefined);
  const stallUntil = createCell<number | undefined>(undefined);
  const turn = createCell<LiveTurn | undefined>(undefined);
  const next = createCell<readonly string[]>([]);
  const writing = createCell<string | undefined>(undefined);
  const runningSteps = createCell<ReadonlyMap<string, RunningStep>>(new Map());
  const retries = createCell<ReadonlyMap<string, string>>(new Map());
  const waiting = createCell<string | undefined>(undefined);
  const askedAt = createCell<number | undefined>(undefined);
  const isReminded = createCell(false);
  const device = createCell<Device | undefined>(undefined);
  const attachments = createCell<ReadonlyMap<string, Attachment>>(new Map());
  const pairingCodes = createCell<ReadonlySet<string>>(new Set());

  const timestamp = (): string => new Date(now.get()).toISOString();

  const stepAt = (at: number): number => {
    const started = start.get();
    if (started === undefined) throw new Error("a step before begin()");
    return at - started.at;
  };

  const addLine = (line: Line): void => {
    lines.update((current) => [...current, line]);
  };

  const addStep = (fields: Fields, at = now.get()): void => {
    addLine({ at: stepAt(at), ...fields });
  };

  const latestEventId = (): string | undefined => log.get().at(-1)?.id;

  const nextPosition = (): number => log.get().length + 1;

  const newId = (prefix: IdPrefix): string => {
    const { boot, counters, issued } = ids.get();
    const count = counters[prefix] + 1;
    const serial = String(count).padStart(serialDigits, "0");
    const id = `${prefix}_${serial}_${toToken(`${header.name}:${prefix}:${boot}:${serial}`)}`;
    if (issued.has(id)) throw new Error(`id ${id} reused`);
    ids.set({ boot, counters: { ...counters, [prefix]: count }, issued: new Set([...issued, id]) });
    return id;
  };

  const newUserId = (): string => toUuid(`${header.name}:user:${users.update((count) => count + 1)}`);

  const messageById = (id: string): Message => {
    const message = project(log.get()).byId.get(id);
    if (!message) throw new Error(`unknown message ${id}`);
    return message;
  };

  const emit = (type: string, fields: Fields): void => {
    const event: Event = { id: newId("e"), type, at: timestamp(), ...fields };
    project(log.update((current) => [...current, event]));
    if (start.get() === undefined) {
      addLine({ given: event });
      return;
    }
    if (isConnected.get()) {
      const until = stallUntil.get();
      const deliveredAt = until !== undefined && now.get() < until ? until : now.get();
      addStep({ event }, deliveredAt);
      cursor.set(event.id);
    }
    observer.get()?.(type, fields);
  };

  const time = (iso: string): void => {
    const at = Date.parse(iso);
    if (at < now.get()) throw new Error(`time went backwards to ${iso}`);
    now.set(at);
  };

  const wait = (durationMs: number): void => {
    now.update((current) => current + durationMs);
  };

  const begin = (iso: string, app: AppStart = {}): void => {
    time(iso);
    const appCursor = app.cursor === "latest" ? latestEventId() : app.cursor;
    start.set({ at: now.get(), cursor: appCursor, oldestCached: app.oldestCached });
    cursor.set(appCursor);
  };

  const stepAtOffset = (offsetMs: number): number => stepAt(now.get() + offsetMs);

  const world = (marker: string, fields: Fields = {}): void => {
    addStep({ world: marker, ...fields });
  };

  const request = (method: string, path: string, options: RequestOptions = {}): void => {
    addStep({
      app: {
        method,
        path,
        ...(options.headers && { headers: options.headers }),
        ...(options.body !== undefined && { body: options.body }),
        ...(options.bodyFile && { body_file: options.bodyFile }),
        ...(options.bodySize !== undefined && { body_size: options.bodySize }),
      },
    });
  };

  const response = (status: number, body: unknown, options: ResponseOptions = {}): void => {
    addStep({
      server: {
        status,
        ...(options.headers && { headers: options.headers }),
        ...(body !== undefined && { body }),
      },
      ...(options.isLost && { lost: true }),
    });
  };

  const snapshot = (reason: SnapshotReason): void => {
    const { order, byId, steps, asks, calls } = project(log.get());
    const latest = latestEventId();
    const messages = order.slice(-messagesPerSnapshot).flatMap((id) => byId.get(id) ?? []);
    const first = messages[0]?.position;
    addStep({
      event: {
        ...(latest && { id: latest }),
        type: "snapshot",
        at: timestamp(),
        reason,
        messages,
        has_more: order.length > messagesPerSnapshot,
        steps: first === undefined ? [] : between(steps, first),
        asks: first === undefined ? [] : between(asks, first),
        calls: callsFrom(calls, positionBefore(order, byId, order.length - messagesPerSnapshot) + 1),
        turn: turn.get() ?? null,
        next: next.get(),
      },
    });
    cursor.set(latest);
  };

  const connect = (options: { readonly headers?: HttpHeaders } = {}): void => {
    const appCursor = cursor.get();
    const headers = { ...options.headers, ...(appCursor && { "Last-Event-ID": appCursor }) };
    request("GET", "/v0/events", Object.keys(headers).length > 0 ? { headers } : {});
    response(200, undefined, { headers: { "Content-Type": "text/event-stream" } });
    isConnected.set(true);
    const events = log.get();
    const known = appCursor === undefined ? -1 : events.findIndex((event) => event.id === appCursor);
    if (known === -1) {
      snapshot(appCursor === undefined ? "no_cursor" : "cursor_unknown");
      return;
    }
    const missed = events.slice(known + 1);
    for (const event of missed) addStep({ event });
    cursor.set(latestEventId());
  };

  const disconnect = (marker: string, fields: Fields = {}): void => {
    world(marker, fields);
    isConnected.set(false);
    const model = callModel.get();
    if (!model || !["offline", "app_closed"].includes(marker)) return;
    const state = model.state === "speaking" ? (turn.get() ? "working" : "listening") : model.state;
    callModel.set({ ...model, isAttached: false, unplayed: [], state });
  };

  const stall = (durationMs: number): void => {
    const until = now.get() + durationMs;
    world("network_stall", { until: stepAt(until) });
    stallUntil.set(until);
  };

  const runningTurn = (): LiveTurn => {
    const running = turn.get();
    if (!running) throw new Error("no turn is running");
    return running;
  };

  const push = (level: "active" | "time-sensitive", notification: Notification): void => {
    const current = device.get();
    if (!current || start.get() === undefined || (current.isLooking && isConnected.get())) return;
    addStep({ push: { device: current.id, level, notification } });
  };

  const askById = (id: string): Ask => {
    const found = project(log.get()).asks.get(id);
    if (!found) throw new Error(`unknown ask ${id}`);
    return found;
  };

  const endAsk = (id: string, outcome: "answered" | "cancelled", answer?: string): void => {
    emit("ask.ended", {
      ask: { ...askById(id), ended_at: timestamp(), outcome, ...(answer && { answer }) },
    });
    waiting.set(undefined);
  };

  const startTurn = (inputs: readonly string[], options: { readonly retryOf?: string } = {}): string => {
    if (turn.get()) throw new Error("a turn is already running");
    const id = newId("t");
    const retry = options.retryOf ? { retry_of: options.retryOf } : {};
    turn.set({ id, inputs: [...inputs], read: [], ...retry, status: null });
    next.update((current) => current.filter((message) => !inputs.includes(message)));
    emit("turn.started", { turn: id, inputs, ...retry });
    return id;
  };

  const setStatus = (kind: StatusKind, label: string, detail?: string): void => {
    const running = runningTurn();
    const liveStatus: Status = { kind, label, ...(detail && { detail }) };
    turn.set({ ...running, status: liveStatus });
    emit("turn.status", { turn: running.id, ...liveStatus });
  };

  const foreground = (): RunningStep | undefined =>
    runningSteps
      .get()
      .values()
      .filter((running) => running.step.kind !== "plan")
      .toArray()
      .at(-1);

  const finishStep = (running: RunningStep, end: StepEnd): void => {
    const outcome = end.outcome ?? "completed";
    const ended = {
      ...running.step,
      ...end.fields,
      title: outcome === "completed" ? running.endedTitle : running.step.title,
      ended_at: timestamp(),
      outcome,
      duration_ms: now.get() - Date.parse(running.step.at),
    };
    runningSteps.update((current) => new Map([...current].filter(([id]) => id !== running.step.id)));
    emit("step.ended", { step: ended });
  };

  const endStep = (end: StepEnd = {}): void => {
    const running = end.id ? runningSteps.get().get(end.id) : foreground();
    if (running) finishStep(running, end);
  };

  const endAllSteps = (outcome: Outcome): void => {
    for (const running of runningSteps.get().values()) finishStep(running, { outcome });
  };

  const status = (kind: StatusKind, label: string, detail?: string): void => {
    if (kind === "writing") endStep();
    setStatus(kind, label, detail);
  };

  const step = (kind: StepKind, options: StepOptions): string => {
    if (kind !== "plan") endStep();
    const running = runningTurn();
    const id = newId("s");
    const started = {
      id,
      turn: running.id,
      kind,
      title: options.title,
      at: timestamp(),
      position: nextPosition(),
      ...options.fields,
    } as Step;
    runningSteps.update((current) => new Map([...current, [id, { step: started, endedTitle: options.endedTitle }]]));
    emit("step.started", { step: started });
    setStatus(statusKindFor(kind), options.title, options.detail);
    return id;
  };

  const updateStep = (fields: Fields, update: StepUpdate = {}): void => {
    const current = update.id ? runningSteps.get().get(update.id) : foreground();
    if (!current) throw new Error("no step is running");
    const updated: Step = { ...current.step, ...fields };
    runningSteps.update((steps) => new Map([...steps, [updated.id, { ...current, step: updated }]]));
    emit("step.updated", { step: updated });
    if (update.detail) setStatus(statusKindFor(updated.kind), updated.title, update.detail);
  };

  const read = (message: string): void => {
    const running = runningTurn();
    turn.set({ ...running, read: [...running.read, message] });
    emit("message.read", { message, turn: running.id });
  };

  const queue = (message: string): void => {
    const running = runningTurn();
    next.update((current) => [...current, message]);
    emit("message.queued", { message, turn: running.id });
  };

  const reply = (kind: MessageKind = "reply"): string => {
    if (writing.get()) throw new Error("a message is already being written");
    endStep();
    const running = runningTurn();
    const id = newId("m");
    writing.set(id);
    emit("message.started", {
      message: { id, role: "agent", kind, turn: running.id, text: "", at: timestamp(), position: nextPosition() },
    });
    return id;
  };

  const write = (text: string, options: WriteOptions = {}): void => {
    const id = writing.get();
    if (!id) throw new Error("no message is being written");
    const pieces = splitIntoPieces(text, options.pieces);
    for (const [index, piece] of pieces.entries()) {
      if (index > 0) wait(options.everyMs ?? defaultPieceIntervalMs);
      emit("message.delta", { message: id, offset: messageById(id).text.length, text: piece });
    }
  };

  const endMessage = (outcome: Outcome, options: EndOptions = {}): void => {
    const id = writing.get();
    if (!id) throw new Error("no message is being written");
    const length = options.length ?? messageById(id).text.length;
    emit("message.ended", { message: id, outcome, length, ...(options.error && { error: options.error }) });
    writing.set(undefined);
  };

  const endTurn = (outcome: Outcome, error?: ErrorBody): string => {
    if (writing.get()) throw new Error("the turn ended with a message still open");
    const running = runningTurn();
    endAllSteps(outcome);
    const held = waiting.get();
    if (held !== undefined && approvals.get().has(held)) endAsk(held, "cancelled");
    emit("turn.ended", { turn: running.id, outcome, ...(error && { error }) });
    turn.set(undefined);
    const { byId, asks } = project(log.get());
    const hasAsked = asks.values().some((asked) => asked.turn === running.id);
    const lastReply = byId
      .values()
      .filter((message) => message.turn === running.id && message.kind === "reply" && message.text !== "")
      .toArray()
      .at(-1);
    if (outcome === "completed" && !hasAsked && lastReply) {
      push("active", { kind: "reply", text: toFirstLine(lastReply.text), turn: running.id, message: lastReply.id });
    }
    if (outcome === "failed" && error) {
      push("active", { kind: "failed", text: toFailedText(error.message), turn: running.id });
    }
    return running.id;
  };

  const describeAttachment = (file: string, id: string, name = file): Attachment => {
    const mediaType = mediaTypeOf(name);
    const bytes = readFileSync(path.join(fixtureDirectory, file));
    const dimensions = isImage(mediaType) ? readDimensions(bytes, mediaType) : undefined;
    return {
      id,
      kind: isImage(mediaType) ? "image" : mediaType.startsWith("audio/") ? "audio" : "file",
      name,
      media_type: mediaType,
      size: bytes.length,
      ...(dimensions && { width: dimensions.width, height: dimensions.height }),
    };
  };

  const exchange = (user: string, agent: string, files: readonly string[] = []): Exchange => {
    const userMessageId = newUserId();
    const attached = files.map((file) => describeAttachment(file, newUserId()));
    emit("message.accepted", {
      message: {
        id: userMessageId,
        role: "user",
        text: user,
        at: timestamp(),
        position: nextPosition(),
        ...(attached.length > 0 && { attachments: attached }),
      },
    });
    wait(1);
    const turnId = startTurn([userMessageId]);
    wait(300);
    step("thinking", { title: "Thinking it through", endedTitle: "Thought it through" });
    wait(1500);
    const agentMessageId = reply();
    write(agent, { pieces: 1 });
    wait(600);
    endMessage("completed");
    wait(1);
    endTurn("completed");
    return { user: userMessageId, agent: agentMessageId, turn: turnId };
  };

  const callById = (id: string): Call => {
    const found = project(log.get()).calls.get(id);
    if (!found) throw new Error(`unknown call ${id}`);
    return found;
  };

  const endCallNow = (id: string, reason?: string): Call => {
    const call = callById(id);
    if (call.ended_at) return call;
    const ended: Call = {
      ...call,
      ended_at: timestamp(),
      duration_ms: now.get() - Date.parse(call.started_at),
      ...(reason !== undefined && { end_reason: reason }),
    };
    emit("call.ended", { call: ended });
    return ended;
  };

  const startCall = (): string => {
    const id = newUserId();
    request("PUT", `/v0/calls/${id}`);
    const open = project(log.get())
      .calls.values()
      .find((call) => !call.ended_at);
    if (open) endCallNow(open.id);
    const call: Call = { id, started_at: timestamp(), position: nextPosition() };
    emit("call.started", { call });
    response(201, { call });
    return id;
  };

  const endCall = (id: string): void => {
    request("POST", `/v0/calls/${id}/end`);
    response(200, { call: endCallNow(id) });
  };

  const voiceStatus = (state: VoiceState, reason?: string): void => {
    const fields = reason === undefined ? {} : { reason };
    world(`voice_${state}`, fields);
    emit("voice.status", { state, ...fields });
  };

  const currentModel = (): CallModel => {
    const model = callModel.get();
    if (!model) throw new Error("no call stream is open");
    return model;
  };

  const serverFrame = (frame: Fields): void => {
    if (callModel.get()?.isAttached) addStep({ socket: { from: "server", frame } });
  };

  const moveTo = (state: CallState): void => {
    const model = currentModel();
    if (model.state === state) return;
    callModel.set({ ...model, state });
    serverFrame({ type: "state", state });
  };

  const sayOne = (text: string): string | undefined => {
    const model = callModel.get();
    if (!model?.isAttached) return undefined;
    const id = `s${String(model.sentences + 1)}`;
    callModel.set({ ...model, sentences: model.sentences + 1, unplayed: [...model.unplayed, id] });
    moveTo("speaking");
    serverFrame({ type: "saying", id, text });
    addStep({ socket: { from: "server", audio_ms: cannedAudioMs } });
    return id;
  };

  const speak = (texts: readonly string[]): readonly string[] =>
    texts.map((text) => sayOne(text)).filter((id) => id !== undefined);

  const settleCall = (isWorking: boolean): void => {
    const model = callModel.get();
    if (!model || model.unplayed.length > 0 || model.state === "hearing") return;
    moveTo(isWorking ? "working" : "listening");
  };

  const followCall = (type: string, fields: Fields): void => {
    const model = callModel.get();
    if (!model) return;
    const message = fields.message as string | undefined | { readonly id: string; readonly role?: string };
    if (type === "turn.started" && model.state !== "hearing" && model.unplayed.length === 0) moveTo("working");
    if (type === "turn.ended") settleCall(false);
    else if (type === "ask.started") speak(askAloud(fields.ask as Ask));
    if (type === "message.started" && typeof message === "object" && message.role === "agent") {
      callModel.set({ ...model, feeds: new Map([...model.feeds, [message.id, createSentenceFeed()]]) });
    }
    if (typeof message !== "string" || (type !== "message.delta" && type !== "message.ended")) return;
    const feed = model.feeds.get(message);
    if (feed) speak(feed(messageById(message).text, type === "message.ended"));
  };
  observer.set(followCall);

  const openStream = (call: string): void => {
    request("GET", `/v0/calls/${call}/stream`);
    response(101, undefined);
    const model = callModel.get();
    const state = model?.call === call ? model.state : "listening";
    callModel.set(
      model?.call === call
        ? { ...model, isAttached: true }
        : { call, state, isAttached: true, unplayed: [], sentences: 0, feeds: new Map() },
    );
    serverFrame({ type: "state", state });
  };

  const appFrame = (frame: Fields): void => {
    addStep({ socket: { from: "app", frame } });
  };

  const appAudio = (file: string): void => {
    addStep({ socket: { from: "app", audio: file } });
  };

  const youSay = (file: string, raw: string, options: YouSayOptions = {}): string => {
    const { heard = [], vocabulary = [] } = options;
    const model = currentModel();
    world("you_say", { text: raw, ...(heard.length > 0 && { heard }) });
    appAudio(file);
    if (model.state === "speaking") {
      serverFrame({ type: "stop_playback" });
      callModel.set({ ...currentModel(), unplayed: [] });
    }
    moveTo("hearing");
    for (const text of heard) serverFrame({ type: "heard", text, final: false });
    moveTo("turn_ended");
    const { text, corrections } = correct(raw, vocabulary);
    const audio: Attachment = {
      id: newId("f"),
      kind: "audio",
      name: "turn.wav",
      media_type: "audio/wav",
      size: readFileSync(path.join(fixtureDirectory, file)).length + 44,
    };
    const id = newId("m");
    const asked = waiting.get();
    const answering = asked === undefined || askById(asked).secret ? undefined : asked;
    emit("message.accepted", {
      message: {
        id,
        role: "user",
        text,
        at: timestamp(),
        position: nextPosition(),
        ...(answering && { answers: answering }),
        spoken: { call: model.call, audio, ...(corrections.length > 0 && { corrections }) },
      },
    });
    if (answering) endAsk(answering, "answered", id);
    serverFrame({ type: "heard", text, final: true, message: id });
    return id;
  };

  const played = (id: string, isCut = false): void => {
    appFrame({ type: "played", id, ...(isCut && { cut: true }) });
    if (isCut) return;
    const model = currentModel();
    callModel.set({ ...model, unplayed: model.unplayed.filter((sentence) => sentence !== id) });
    settleCall(turn.get() !== undefined);
  };

  const unplayed = (): readonly string[] => callModel.get()?.unplayed ?? [];

  const endStream = (code: number, reason: string, endReason?: string): void => {
    const model = currentModel();
    endCallNow(model.call, endReason);
    if (model.isAttached) addStep({ socket: { from: "server", closed: code, reason } });
    callModel.set(undefined);
  };

  const hangUp = (): void => {
    appFrame({ type: "end" });
    endStream(1000, "The call ended.");
  };

  const voiceFails = (reason: string): void => {
    voiceStatus("failed", reason);
    serverFrame({ type: "problem", reason });
    endStream(1011, reason, reason);
  };

  const streamTimesOut = (): void => {
    endStream(1000, "The connection dropped.", "The connection dropped.");
  };

  const deleteCallAudio = (id: string): void => {
    request("DELETE", `/v0/calls/${id}/audio`);
    const call = callById(id);
    if (call.audio_deleted) {
      response(200, { call });
      return;
    }
    const deleted: Call = { ...call, audio_deleted: true };
    emit("call.audio_deleted", { call: deleted });
    response(200, { call: deleted });
  };

  const callExchange = (user: string, agent: string, corrections: readonly Correction[], recording: string): string => {
    const call: Call = { id: newUserId(), started_at: timestamp(), position: nextPosition() };
    emit("call.started", { call });
    wait(6000);
    const userMessageId = newUserId();
    emit("message.accepted", {
      message: {
        id: userMessageId,
        role: "user",
        text: user,
        at: timestamp(),
        position: nextPosition(),
        spoken: {
          call: call.id,
          audio: describeAttachment(recording, newUserId()),
          ...(corrections.length > 0 && { corrections }),
        },
      },
    });
    wait(1);
    startTurn([userMessageId]);
    wait(900);
    reply();
    write(agent, { pieces: 1 });
    wait(600);
    endMessage("completed");
    wait(1);
    endTurn("completed");
    wait(5 * 60 * 1000);
    endCallNow(call.id);
    return call.id;
  };

  const send = (text: string, options: SendOptions = {}): string => {
    const id = options.id ?? newUserId();
    const attached = options.attachments ?? [];
    request("POST", "/v0/messages", {
      body: {
        id,
        text,
        ...(options.answers && { answers: options.answers }),
        ...(attached.length > 0 && { attachments: attached }),
      },
    });
    const isKnown = project(log.get()).byId.has(id);
    if (!isKnown && attached.some((attachment) => !attachments.get().has(attachment))) {
      response(400, {
        error: {
          code: "attachment_missing",
          message: "A photo or file in this message isn't on the server.",
          detail:
            "Uploads no message names are deleted after a day. Upload this message's attachments again, then send it again.",
        },
      });
      return id;
    }
    if (!isKnown) {
      const isSecret = options.answers !== undefined && askById(options.answers).secret;
      const answering = waiting.get();
      emit("message.accepted", {
        message: {
          id,
          role: "user",
          text: isSecret ? "" : text,
          at: timestamp(),
          position: nextPosition(),
          ...(answering && { answers: answering }),
          ...(isSecret && { secret: true }),
          ...(attached.length > 0 && {
            attachments: attached.map((attachment) => {
              const found = attachments.get().get(attachment);
              if (!found) throw new Error(`unknown attachment ${attachment}`);
              return found;
            }),
          }),
        },
      });
      if (answering) endAsk(answering, "answered", id);
    }
    response(isKnown ? 200 : 201, { message: messageById(id) }, { isLost: options.isLost });
    return id;
  };

  const ask = (fields: AskFields): string => {
    endStep();
    const running = runningTurn();
    const earlier = waiting.get();
    if (earlier) endAsk(earlier, "cancelled");
    const options = fields.options ?? [];
    const asked: Ask = {
      id: newId("a"),
      turn: running.id,
      kind: fields.kind ?? "question",
      question: fields.question,
      options: [...options],
      allows_text: options.length === 0 || (fields.allowsText ?? true),
      ...(fields.preview && { preview: fields.preview }),
      secret: fields.secret ?? false,
      at: timestamp(),
      position: nextPosition(),
    };
    emit("ask.started", { ask: asked });
    waiting.set(asked.id);
    askedAt.set(now.get());
    isReminded.set(false);
    push("time-sensitive", {
      kind: "ask",
      text: asked.question,
      ask: {
        id: asked.id,
        options: options.map((option) => option.label),
        allows_text: asked.allows_text,
        secret: asked.secret,
      },
    });
    return asked.id;
  };

  const approval = (fields: AskFields): string => {
    const running = runningTurn();
    const options = fields.options ?? [];
    const asked: Ask = {
      id: newId("a"),
      turn: running.id,
      kind: fields.kind ?? "approval",
      question: fields.question,
      options: [...options],
      allows_text: fields.allowsText ?? true,
      ...(fields.preview && { preview: fields.preview }),
      secret: false,
      at: timestamp(),
      position: nextPosition(),
    };
    emit("ask.started", { ask: asked });
    waiting.set(asked.id);
    askedAt.set(now.get());
    isReminded.set(false);
    approvals.update((current) => new Set([...current, asked.id]));
    push("time-sensitive", {
      kind: "ask",
      text: asked.question,
      ask: {
        id: asked.id,
        options: options.map((option) => option.label),
        allows_text: asked.allows_text,
        secret: false,
      },
    });
    setStatus("waiting", "Waiting for your approval");
    return asked.id;
  };

  const cancelAsk = (id: string): void => {
    request("POST", `/v0/asks/${id}/cancel`);
    if (waiting.get() === id) endAsk(id, "cancelled");
    response(200, { ask: askById(id) });
  };

  const registerDevice = (): string => {
    const id = toUuid(`${header.name}:device`);
    const key = Buffer.from("01234567890123456789012345678901");
    request("PUT", `/v0/devices/${id}`, {
      body: {
        apns_token: "0123456789abcdef".repeat(4),
        environment: "production",
        notification_key: key.toString("base64"),
      },
    });
    const keyId = createHash("sha256").update(key).digest("hex").slice(0, 8);
    response(201, { device: { id, environment: "production", key_id: keyId, registered_at: timestamp() } });
    device.set({ id, isLooking: false });
    return id;
  };

  const presence = (isLooking: boolean): void => {
    const current = device.get();
    if (!current) throw new Error("presence before a device is registered");
    request("PUT", `/v0/devices/${current.id}/presence`, { body: { looking: isLooking } });
    response(204, undefined);
    device.set({ ...current, isLooking });
  };

  const upload = (file: string, options: UploadOptions = {}): string => {
    const id = options.id ?? newUserId();
    const name = options.name ?? file;
    request("PUT", `/v0/attachments/${id}?name=${encodeURIComponent(name)}`, {
      headers: { "Content-Type": mediaTypeOf(name) },
      bodyFile: file,
    });
    const attachment = attachments.get().get(id) ?? describeAttachment(file, id, name);
    const isKnown = attachments.get().has(id);
    attachments.update((current) => new Map([...current, [id, attachment]]));
    response(isKnown ? 200 : 201, { attachment }, { isLost: options.isLost });
    return id;
  };

  const uploadTooLarge = (name: string, size: number): void => {
    request("PUT", `/v0/attachments/${newUserId()}?name=${encodeURIComponent(name)}`, {
      headers: { "Content-Type": mediaTypeOf(name) },
      bodySize: size,
    });
    response(413, {
      error: {
        code: "too_large",
        message: "That file is larger than Ito accepts.",
        detail: "Attachments can be up to 20 MB.",
      },
    });
  };

  const forgetUnsentUploads = (): void => {
    const sent = new Set(
      project(log.get())
        .byId.values()
        .flatMap((message) => message.attachments ?? [])
        .map((attachment) => attachment.id),
    );
    attachments.update((current) => new Map([...current].filter(([id]) => sent.has(id))));
  };

  const fetchAttachment = (id: string): void => {
    const found =
      attachments.get().get(id) ??
      project(log.get())
        .byId.values()
        .flatMap((message) => message.attachments ?? [])
        .find((attachment) => attachment.id === id);
    if (!found) throw new Error(`unknown attachment ${id}`);
    request("GET", `/v0/attachments/${id}`);
    response(200, undefined, { headers: { "Content-Type": found.media_type, "Content-Length": String(found.size) } });
  };

  const showPairingCode = (code: string): void => {
    pairingCodes.update((current) => new Set([...current, code]));
    world("pairing_code_shown", { code });
  };

  const pair = (code: string, deviceName: string, token: string): void => {
    request("POST", "/v0/pair", { body: { code, device_name: deviceName } });
    if (pairingCodes.get().has(code)) {
      pairingCodes.update((current) => new Set([...current].filter((known) => known !== code)));
      response(201, { token });
      return;
    }
    response(401, {
      error: {
        code: "pairing_code_rejected",
        message: "That pairing code has expired or was already used.",
        detail: "Run ito pair on the server for a new code.",
      },
    });
  };

  const remind = (): void => {
    const id = waiting.get();
    const at = askedAt.get();
    if (!id || at === undefined || isReminded.get()) throw new Error("no ask is waiting for a reminder");
    now.set(Math.max(now.get(), at + reminderAfterMs));
    isReminded.set(true);
    const asked = askById(id);
    push("active", {
      kind: "reminder",
      text: toReminderText(asked.question),
      ask: {
        id,
        options: asked.options.map((option) => option.label),
        allows_text: asked.allows_text,
        secret: asked.secret,
      },
    });
  };

  const stop = (turnId: string, cut?: Cut): void => {
    request("POST", `/v0/turns/${turnId}/stop`, { body: cut ? { cut } : {} });
    if (turn.get()?.id === turnId) {
      response(202, { turn: turnId, state: "stopping" });
      return;
    }
    const ended = log.get().findLast((event) => event.type === "turn.ended" && event.turn === turnId);
    if (!ended) throw new Error(`stop for unknown turn ${turnId}`);
    response(200, { turn: turnId, state: "ended", outcome: ended.outcome });
  };

  const retry = (failed: string): string => {
    request("POST", `/v0/turns/${failed}/retry`);
    const earlier = retries.get().get(failed);
    if (earlier) {
      response(200, { turn: earlier, retry_of: failed });
      return earlier;
    }
    const started = log.get().find((event) => event.type === "turn.started" && event.turn === failed);
    if (!started) throw new Error(`retry of unknown turn ${failed}`);
    const attempt = startTurn(started.inputs as readonly string[], { retryOf: failed });
    retries.update((current) => new Map([...current, [failed, attempt]]));
    response(202, { turn: attempt, retry_of: failed });
    return attempt;
  };

  const listMessages = (before: string, limit: number): void => {
    request("GET", `/v0/messages?before=${before}&limit=${limit}`);
    const { order, byId, steps, asks, calls } = project(log.get());
    const index = order.indexOf(before);
    if (index === -1) throw new Error(`no message ${before}`);
    const first = Math.max(0, index - limit);
    const messages = order.slice(first, index).flatMap((id) => byId.get(id) ?? []);
    const from = messages[0]?.position;
    const until = byId.get(before)?.position;
    response(200, {
      messages,
      steps: from === undefined ? [] : between(steps, from, until),
      asks: from === undefined ? [] : between(asks, from, until),
      calls: callsFrom(calls, positionBefore(order, byId, first) + 1, until),
      has_more: first > 0,
    });
  };

  const restart = (): void => {
    disconnect("server_restarted");
    const registered = device.get();
    if (registered) device.set({ ...registered, isLooking: false });
    ids.update((current) => ({ ...current, boot: current.boot + 1 }));
    wait(2400);
    if (!turn.get()) return;
    if (writing.get()) endMessage("interrupted");
    endTurn("interrupted");
  };

  const restore = (to: string): void => {
    const index = log.get().findIndex((event) => event.id === to);
    if (index === -1) throw new Error(`restore to unknown event ${to}`);
    disconnect("server_restored", { to });
    const kept = log.update((current) => current.slice(0, index + 1));
    ids.update((current) => ({ ...current, boot: current.boot + 1, counters: toCounters(kept) }));
    turn.set(undefined);
    next.set([]);
    writing.set(undefined);
    runningSteps.set(new Map());
    wait(3000);
  };

  const toJsonl = (): string => {
    if (turn.get() || next.get().length > 0 || writing.get()) {
      throw new Error(`${header.name} ends with work in progress`);
    }
    const started = start.get();
    const headerLine = {
      transcript: header.name,
      start: new Date(started?.at ?? 0).toISOString(),
      scenario: header.scenario,
      title: header.title,
      summary: header.summary,
      guarantees: header.guarantees,
      app: {
        ...(started?.cursor && { cursor: started.cursor }),
        ...(started?.oldestCached && { oldest_cached: started.oldestCached }),
      },
    };
    return [headerLine, ...lines.get()].map((line) => JSON.stringify(line)).join("\n") + "\n";
  };

  return {
    header,
    lines: () => lines.get(),
    time,
    wait,
    begin,
    latestEventId,
    stepAtOffset,
    world,
    callExchange,
    change: () => newId("c"),
    startCall,
    endCall,
    deleteCallAudio,
    voiceStatus,
    approval,
    openStream,
    appFrame,
    appAudio,
    youSay,
    speak,
    played,
    unplayed,
    hangUp,
    voiceFails,
    streamTimesOut,
    request,
    response,
    connect,
    disconnect,
    stall,
    exchange,
    send,
    startTurn,
    status,
    step,
    updateStep,
    endStep,
    read,
    queue,
    reply,
    write,
    endMessage,
    endTurn,
    stop,
    retry,
    ask,
    cancelAsk,
    registerDevice,
    presence,
    remind,
    upload,
    uploadTooLarge,
    forgetUnsentUploads,
    fetchAttachment,
    showPairingCode,
    pair,
    listMessages,
    restart,
    restore,
    toJsonl,
  };
};
