import { createHash } from "node:crypto";
import { createCell } from "#cell.ts";
import type {
  Error as ErrorBody,
  LiveTurn,
  Message,
  MessageKind,
  Outcome,
  Status,
  StatusKind,
} from "#protocol/types.ts";
import type { Event, Line } from "./spec.ts";

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

type RequestOptions = { readonly body?: unknown; readonly headers?: HttpHeaders };

type ResponseOptions = { readonly headers?: HttpHeaders; readonly isLost?: boolean };

type SendOptions = { readonly id?: string; readonly isLost?: boolean };

type WriteOptions = { readonly pieces?: number; readonly everyMs?: number };

type EndOptions = { readonly length?: number; readonly error?: ErrorBody };

type Cut = { readonly message: string; readonly offset: number };

type Exchange = { readonly user: string; readonly agent: string; readonly turn: string };

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
  readonly exchange: (user: string, agent: string) => Exchange;
  readonly send: (text: string, options?: SendOptions) => string;
  readonly startTurn: (inputs: readonly string[], options?: { readonly retryOf?: string }) => string;
  readonly status: (kind: StatusKind, label: string, detail?: string) => void;
  readonly read: (message: string) => void;
  readonly queue: (message: string) => void;
  readonly reply: (kind?: MessageKind) => string;
  readonly write: (text: string, options?: WriteOptions) => void;
  readonly endMessage: (outcome: Outcome, options?: EndOptions) => void;
  readonly endTurn: (outcome: Outcome, error?: ErrorBody) => string;
  readonly stop: (turn: string, cut?: Cut) => void;
  readonly retry: (failed: string) => string;
  readonly listMessages: (before: string, limit: number) => void;
  readonly restart: () => void;
  readonly restore: (to: string) => void;
  readonly toJsonl: () => string;
};

type IdPrefix = "e" | "m" | "t";

type Counters = Readonly<Record<IdPrefix, number>>;

type Ids = { readonly boot: number; readonly counters: Counters; readonly issued: ReadonlySet<string> };

type Start = { readonly at: number; readonly cursor: string | undefined; readonly oldestCached: string | undefined };

type Projection = { readonly order: readonly string[]; readonly byId: ReadonlyMap<string, Message> };

type SnapshotReason = "no_cursor" | "cursor_unknown" | "too_far_behind";

// Digits only, so no id can read as a word, or as a misspelling to a spell checker.
const idCharacters = "0123456789";
const serialDigits = 4;
const tokenDigits = 5;
const defaultPieceLength = 28;
const defaultPieceIntervalMs = 120;
const messagesPerSnapshot = 50;

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
      return { order: [...order, message.id], byId: new Map(byId).set(message.id, message) };
    }
    case "message.delta": {
      const message = byId.get(event.message as string);
      if (!message) throw new Error(`text for unknown message ${String(event.message)}`);
      if (event.offset !== message.text.length) {
        throw new Error(`text at offset ${String(event.offset)}, but ${message.id} has length ${message.text.length}`);
      }
      return {
        order,
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
      return { order, byId: new Map(byId).set(message.id, ended) };
    }
    default: {
      return projection;
    }
  }
};

const project = (log: readonly Event[]): Projection =>
  log.reduce<Projection>(projectEvent, { order: [], byId: new Map() });

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
  if (typeof value === "string") return /^[emt]_\d{4}_/.test(value) ? [value] : [];
  if (Array.isArray(value)) return value.flatMap(idsIn);
  return value && typeof value === "object" ? Object.values(value).flatMap(idsIn) : [];
};

const toCounters = (log: readonly Event[]): Counters => {
  const ids = log.flatMap(idsIn);
  const highest = (prefix: IdPrefix): number =>
    ids.filter((id) => id.startsWith(`${prefix}_`)).reduce((max, id) => Math.max(max, Number(id.split("_", 2)[1])), 0);
  return { e: highest("e"), m: highest("m"), t: highest("t") };
};

// A small model of the server's event log. Scenarios drive it the way the server and an app would,
// and it records what crosses the API, so offsets, ids and delivery after a disconnect can't drift.
export const createTranscript = (header: Header): Transcript => {
  const lines = createCell<readonly Line[]>([]);
  const log = createCell<readonly Event[]>([]);
  const ids = createCell<Ids>({ boot: 1, counters: { e: 0, m: 0, t: 0 }, issued: new Set() });
  const users = createCell(0);
  const now = createCell(0);
  const start = createCell<Start | undefined>(undefined);
  const isConnected = createCell(false);
  const cursor = createCell<string | undefined>(undefined);
  const stallUntil = createCell<number | undefined>(undefined);
  const turn = createCell<LiveTurn | undefined>(undefined);
  const next = createCell<readonly string[]>([]);
  const writing = createCell<string | undefined>(undefined);
  const retries = createCell<ReadonlyMap<string, string>>(new Map());

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
    if (!isConnected.get()) return;
    const until = stallUntil.get();
    const deliveredAt = until !== undefined && now.get() < until ? until : now.get();
    addStep({ event }, deliveredAt);
    cursor.set(event.id);
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
    const { order, byId } = project(log.get());
    const latest = latestEventId();
    addStep({
      event: {
        ...(latest && { id: latest }),
        type: "snapshot",
        at: timestamp(),
        reason,
        messages: order.slice(-messagesPerSnapshot).map((id) => byId.get(id)),
        has_more: order.length > messagesPerSnapshot,
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

  const startTurn = (inputs: readonly string[], options: { readonly retryOf?: string } = {}): string => {
    if (turn.get()) throw new Error("a turn is already running");
    const id = newId("t");
    const retry = options.retryOf ? { retry_of: options.retryOf } : {};
    turn.set({ id, inputs: [...inputs], read: [], ...retry, status: null });
    next.update((current) => current.filter((message) => !inputs.includes(message)));
    emit("turn.started", { turn: id, inputs, ...retry });
    return id;
  };

  const status = (kind: StatusKind, label: string, detail?: string): void => {
    const running = runningTurn();
    const liveStatus: Status = { kind, label, ...(detail && { detail }) };
    turn.set({ ...running, status: liveStatus });
    emit("turn.status", { turn: running.id, ...liveStatus });
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
    const running = runningTurn();
    const id = newId("m");
    writing.set(id);
    emit("message.started", { message: { id, role: "agent", kind, turn: running.id, text: "", at: timestamp() } });
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
    emit("turn.ended", { turn: running.id, outcome, ...(error && { error }) });
    turn.set(undefined);
    return running.id;
  };

  const exchange = (user: string, agent: string): Exchange => {
    const userMessageId = newUserId();
    emit("message.accepted", { message: { id: userMessageId, role: "user", text: user, at: timestamp() } });
    wait(1);
    const turnId = startTurn([userMessageId]);
    wait(1800);
    const agentMessageId = reply();
    write(agent, { pieces: 1 });
    wait(600);
    endMessage("completed");
    wait(1);
    endTurn("completed");
    return { user: userMessageId, agent: agentMessageId, turn: turnId };
  };

  const send = (text: string, options: SendOptions = {}): string => {
    const id = options.id ?? newUserId();
    request("POST", "/v0/messages", { body: { id, text } });
    const isKnown = project(log.get()).byId.has(id);
    if (!isKnown) emit("message.accepted", { message: { id, role: "user", text, at: timestamp() } });
    response(isKnown ? 200 : 201, { message: messageById(id) }, { isLost: options.isLost });
    return id;
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
    const { order, byId } = project(log.get());
    const index = order.indexOf(before);
    if (index === -1) throw new Error(`no message ${before}`);
    const first = Math.max(0, index - limit);
    response(200, { messages: order.slice(first, index).map((id) => byId.get(id)), has_more: first > 0 });
  };

  const restart = (): void => {
    disconnect("server_restarted");
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
    request,
    response,
    connect,
    disconnect,
    stall,
    exchange,
    send,
    startTurn,
    status,
    read,
    queue,
    reply,
    write,
    endMessage,
    endTurn,
    stop,
    retry,
    listMessages,
    restart,
    restore,
    toJsonl,
  };
};
