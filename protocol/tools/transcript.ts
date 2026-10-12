import { createHash } from "node:crypto";
import type { Event, Line } from "./spec.ts";

export type Outcome = "completed" | "stopped" | "interrupted" | "failed";
export type StatusKind = "thinking" | "working" | "writing" | "adjusting" | "waiting" | "stopping";
export type MessageKind = "reply" | "note";

export interface ErrorObject {
  code: string;
  message: string;
  detail?: string;
}

export interface Message {
  id: string;
  role: "user" | "agent";
  kind?: MessageKind;
  turn?: string;
  text: string;
  at: string;
  ended_at?: string;
  outcome?: Outcome;
  error?: ErrorObject;
}

interface Status {
  kind: StatusKind;
  label: string;
  detail?: string;
}

interface LiveTurn {
  id: string;
  inputs: string[];
  read: string[];
  retry_of?: string;
  status: Status | null;
}

export interface Header {
  name: string;
  scenario: number;
  title: string;
  summary: string;
  guarantees: string[];
}

// Digits only, so no id can read as a word, or as a misspelling to a spell checker.
const ID_CHARACTERS = "0123456789";

function token(seed: string, length: number): string {
  const digest = createHash("sha256").update(seed).digest();
  let out = "";
  for (let i = 0; i < length; i += 1) out += ID_CHARACTERS[(digest[i] ?? 0) % ID_CHARACTERS.length];
  return out;
}

export function uuidFor(seed: string): string {
  const hex = createHash("sha256").update(seed).digest("hex");
  const variant = "89ab"[parseInt(hex.charAt(16), 16) % 4];
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export function project(log: Event[]): { order: string[]; byId: Map<string, Message> } {
  const order: string[] = [];
  const byId = new Map<string, Message>();
  for (const event of log) {
    if (event.type === "message.accepted" || event.type === "message.started") {
      const message = structuredClone(event.message as Message);
      byId.set(message.id, message);
      order.push(message.id);
    } else if (event.type === "message.delta") {
      const message = byId.get(event.message as string);
      if (!message) throw new Error(`text for unknown message ${String(event.message)}`);
      if (event.offset !== message.text.length) {
        throw new Error(`text at offset ${String(event.offset)}, but ${message.id} has length ${message.text.length}`);
      }
      message.text += event.text as string;
    } else if (event.type === "message.ended") {
      const message = byId.get(event.message as string);
      if (!message) throw new Error(`end of unknown message ${String(event.message)}`);
      const length = event.length as number;
      if (length > message.text.length) throw new Error(`${message.id} ended longer than its text`);
      if (event.outcome === "completed" && length !== message.text.length) {
        throw new Error(`${message.id} completed shorter than its text`);
      }
      message.text = message.text.slice(0, length);
      message.outcome = event.outcome as Outcome;
      message.ended_at = event.at;
      if (event.error) message.error = event.error as ErrorObject;
    }
  }
  return { order, byId };
}

export function splitIntoPieces(text: string, pieces?: number): string[] {
  if (pieces === 1) return [text];
  const target = pieces ? Math.ceil(text.length / pieces) : 28;
  const out: string[] = [];
  let rest = text;
  while (rest.length > target) {
    let cut = rest.lastIndexOf(" ", target);
    if (cut <= 0) cut = rest.indexOf(" ", target);
    if (cut <= 0) break;
    out.push(rest.slice(0, cut + 1));
    rest = rest.slice(cut + 1);
  }
  if (rest) out.push(rest);
  return out;
}

function idsIn(value: unknown): string[] {
  if (typeof value === "string") return /^[emt]_\d{4}_/.test(value) ? [value] : [];
  if (Array.isArray(value)) return value.flatMap(idsIn);
  if (value && typeof value === "object") return Object.values(value).flatMap(idsIn);
  return [];
}

// A small model of the server's event log. Scenarios drive it the way the server and an app would,
// and it records what crosses the API, so offsets, ids and delivery after a disconnect can't drift.
export class Transcript {
  readonly header: Header;
  private readonly lines: Line[] = [];
  private log: Event[] = [];
  private readonly issued = new Set<string>();
  private boot = 1;
  private readonly counters = { e: 0, m: 0, t: 0 };
  private users = 0;
  private now = 0;
  private stepsStart: number | undefined;
  private connected = false;
  private cursor: string | undefined;
  private appCursorAtStart: string | undefined;
  private oldestCached: string | undefined;
  private stallUntil: number | undefined;
  private turn: LiveTurn | null = null;
  private next: string[] = [];
  private writing: string | undefined;
  private readonly retries = new Map<string, string>();

  constructor(header: Header) {
    this.header = header;
  }

  get allLines(): Line[] {
    return this.lines;
  }

  time(iso: string): void {
    const at = Date.parse(iso);
    if (at < this.now) throw new Error(`time went backwards to ${iso}`);
    this.now = at;
  }

  wait(ms: number): void {
    this.now += ms;
  }

  begin(iso: string, app: { cursor?: string; oldestCached?: string } = {}): void {
    this.time(iso);
    this.stepsStart = this.now;
    this.appCursorAtStart = app.cursor === "latest" ? this.log.at(-1)?.id : app.cursor;
    this.cursor = this.appCursorAtStart;
    this.oldestCached = app.oldestCached;
  }

  latestEventId(): string | undefined {
    return this.log.at(-1)?.id;
  }

  stepAtOffset(ms: number): number {
    return this.stepAt(this.now + ms);
  }

  userId(): string {
    this.users += 1;
    return uuidFor(`${this.header.name}:user:${this.users}`);
  }

  message(id: string): Message {
    const message = project(this.log).byId.get(id);
    if (!message) throw new Error(`unknown message ${id}`);
    return message;
  }

  private iso(): string {
    return new Date(this.now).toISOString();
  }

  private stepAt(at = this.now): number {
    if (this.stepsStart === undefined) throw new Error("a step before begin()");
    return at - this.stepsStart;
  }

  private line(fields: Line, at = this.now): void {
    this.lines.push({ at: this.stepAt(at), ...fields });
  }

  private newId(prefix: "e" | "m" | "t"): string {
    this.counters[prefix] += 1;
    const serial = String(this.counters[prefix]).padStart(4, "0");
    const id = `${prefix}_${serial}_${token(`${this.header.name}:${prefix}:${this.boot}:${serial}`, 5)}`;
    if (this.issued.has(id)) throw new Error(`id ${id} reused`);
    this.issued.add(id);
    return id;
  }

  private emit(type: string, fields: Record<string, unknown>): Event {
    const event: Event = { id: this.newId("e"), type, at: this.iso(), ...fields };
    this.log.push(event);
    project(this.log);
    if (this.stepsStart === undefined) {
      this.lines.push({ given: event });
    } else if (this.connected) {
      const stalled = this.stallUntil !== undefined && this.now < this.stallUntil;
      this.line({ event }, stalled ? this.stallUntil : this.now);
      this.cursor = event.id;
    }
    return event;
  }

  world(marker: string, fields: Record<string, unknown> = {}): void {
    this.line({ world: marker, ...fields });
  }

  request(method: string, path: string, options: { body?: unknown; headers?: Record<string, string> } = {}): void {
    this.line({
      app: {
        method,
        path,
        ...(options.headers ? { headers: options.headers } : {}),
        ...(options.body !== undefined ? { body: options.body } : {}),
      },
    });
  }

  response(status: number, body: unknown, options: { headers?: Record<string, string>; lost?: boolean } = {}): void {
    this.line({
      server: {
        status,
        ...(options.headers ? { headers: options.headers } : {}),
        ...(body !== undefined ? { body } : {}),
      },
      ...(options.lost ? { lost: true } : {}),
    });
  }

  connect(options: { headers?: Record<string, string> } = {}): void {
    const headers: Record<string, string> = { ...options.headers };
    if (this.cursor) headers["Last-Event-ID"] = this.cursor;
    this.request("GET", "/v0/events", Object.keys(headers).length ? { headers } : {});
    this.wait(30);
    this.response(200, undefined, { headers: { "Content-Type": "text/event-stream" } });
    this.connected = true;
    const known = this.cursor === undefined ? -1 : this.log.findIndex((event) => event.id === this.cursor);
    if (known >= 0) {
      for (const event of this.log.slice(known + 1)) {
        this.line({ event });
        this.cursor = event.id;
      }
      return;
    }
    this.snapshot(this.cursor === undefined ? "no_cursor" : "cursor_unknown");
  }

  private snapshot(reason: "no_cursor" | "cursor_unknown" | "too_far_behind"): void {
    const { order, byId } = project(this.log);
    const latest = this.log.at(-1)?.id;
    this.line({
      event: {
        ...(latest ? { id: latest } : {}),
        type: "snapshot",
        at: this.iso(),
        reason,
        messages: order.slice(-50).map((id) => byId.get(id)),
        has_more: order.length > 50,
        turn: this.turn ? structuredClone(this.turn) : null,
        next: [...this.next],
      },
    });
    this.cursor = latest;
  }

  disconnect(marker: string, fields: Record<string, unknown> = {}): void {
    this.world(marker, fields);
    this.connected = false;
  }

  stall(ms: number): void {
    this.world("network_stall", { until: this.stepAt(this.now + ms) });
    this.stallUntil = this.now + ms;
  }

  exchange(user: string, agent: string): { user: string; agent: string; turn: string } {
    const userId = this.userId();
    this.emit("message.accepted", { message: { id: userId, role: "user", text: user, at: this.iso() } });
    this.wait(1);
    const turn = this.startTurn([userId]);
    this.wait(1800);
    const agentId = this.reply();
    this.write(agent, { pieces: 1 });
    this.wait(600);
    this.endMessage("completed");
    this.wait(1);
    this.endTurn("completed");
    return { user: userId, agent: agentId, turn };
  }

  send(text: string, options: { id?: string; lost?: boolean } = {}): string {
    const id = options.id ?? this.userId();
    this.request("POST", "/v0/messages", { body: { id, text } });
    this.wait(25);
    const existing = project(this.log).byId.get(id);
    if (!existing) this.emit("message.accepted", { message: { id, role: "user", text, at: this.iso() } });
    this.wait(5);
    this.response(existing ? 200 : 201, { message: this.message(id) }, { lost: options.lost });
    this.wait(1);
    return id;
  }

  startTurn(inputs: string[], options: { retryOf?: string } = {}): string {
    if (this.turn) throw new Error("a turn is already running");
    const id = this.newId("t");
    const retry = options.retryOf ? { retry_of: options.retryOf } : {};
    this.turn = { id, inputs: [...inputs], read: [], ...retry, status: null };
    this.next = this.next.filter((message) => !inputs.includes(message));
    this.emit("turn.started", { turn: id, inputs: [...inputs], ...retry });
    return id;
  }

  private running(): LiveTurn {
    if (!this.turn) throw new Error("no turn is running");
    return this.turn;
  }

  status(kind: StatusKind, label: string, detail?: string): void {
    const turn = this.running();
    turn.status = { kind, label, ...(detail ? { detail } : {}) };
    this.emit("turn.status", { turn: turn.id, ...turn.status });
  }

  read(message: string): void {
    const turn = this.running();
    turn.read.push(message);
    this.emit("message.read", { message, turn: turn.id });
  }

  queue(message: string): void {
    const turn = this.running();
    this.next.push(message);
    this.emit("message.queued", { message, turn: turn.id });
  }

  reply(kind: MessageKind = "reply"): string {
    const turn = this.running();
    if (this.writing) throw new Error("a message is already being written");
    const id = this.newId("m");
    this.writing = id;
    this.emit("message.started", { message: { id, role: "agent", kind, turn: turn.id, text: "", at: this.iso() } });
    return id;
  }

  write(text: string, options: { pieces?: number; every?: number } = {}): void {
    const id = this.writing;
    if (!id) throw new Error("no message is being written");
    splitIntoPieces(text, options.pieces).forEach((piece, index) => {
      if (index > 0) this.wait(options.every ?? 120);
      this.emit("message.delta", { message: id, offset: this.message(id).text.length, text: piece });
    });
  }

  endMessage(outcome: Outcome, options: { length?: number; error?: ErrorObject } = {}): void {
    const id = this.writing;
    if (!id) throw new Error("no message is being written");
    const length = options.length ?? this.message(id).text.length;
    this.emit("message.ended", { message: id, outcome, length, ...(options.error ? { error: options.error } : {}) });
    this.writing = undefined;
  }

  endTurn(outcome: Outcome, error?: ErrorObject): string {
    const turn = this.running();
    if (this.writing) throw new Error("the turn ended with a message still open");
    this.emit("turn.ended", { turn: turn.id, outcome, ...(error ? { error } : {}) });
    this.turn = null;
    return turn.id;
  }

  stop(turn: string, cut?: { message: string; offset: number }): void {
    this.request("POST", `/v0/turns/${turn}/stop`, { body: cut ? { cut } : {} });
    this.wait(20);
    if (this.turn?.id === turn) {
      this.response(202, { turn, state: "stopping" });
    } else {
      const ended = this.log.findLast((event) => event.type === "turn.ended" && event.turn === turn);
      if (!ended) throw new Error(`stop for unknown turn ${turn}`);
      this.response(200, { turn, state: "ended", outcome: ended.outcome });
    }
    this.wait(1);
  }

  retry(failed: string): string {
    this.request("POST", `/v0/turns/${failed}/retry`);
    this.wait(25);
    const earlier = this.retries.get(failed);
    if (earlier) {
      this.response(200, { turn: earlier, retry_of: failed });
      this.wait(1);
      return earlier;
    }
    const started = this.log.find((event) => event.type === "turn.started" && event.turn === failed);
    if (!started) throw new Error(`retry of unknown turn ${failed}`);
    const turn = this.startTurn(started.inputs as string[], { retryOf: failed });
    this.retries.set(failed, turn);
    this.response(202, { turn, retry_of: failed });
    this.wait(1);
    return turn;
  }

  listMessages(before: string, limit: number): void {
    this.request("GET", `/v0/messages?before=${before}&limit=${limit}`);
    this.wait(35);
    const { order, byId } = project(this.log);
    const index = order.indexOf(before);
    if (index < 0) throw new Error(`no message ${before}`);
    const start = Math.max(0, index - limit);
    this.response(200, { messages: order.slice(start, index).map((id) => byId.get(id)), has_more: start > 0 });
  }

  restart(): void {
    this.disconnect("server_restarted");
    this.boot += 1;
    this.wait(2400);
    if (!this.turn) return;
    if (this.writing) this.endMessage("interrupted");
    this.endTurn("interrupted");
  }

  restore(to: string): void {
    const index = this.log.findIndex((event) => event.id === to);
    if (index < 0) throw new Error(`restore to unknown event ${to}`);
    this.disconnect("server_restored", { to });
    this.boot += 1;
    this.log = this.log.slice(0, index + 1);
    this.turn = null;
    this.next = [];
    this.writing = undefined;
    for (const prefix of ["e", "m", "t"] as const) {
      const serials = this.log.flatMap(idsIn).filter((id) => id.startsWith(`${prefix}_`));
      this.counters[prefix] = serials.reduce((max, id) => Math.max(max, Number(id.split("_")[1])), 0);
    }
    this.wait(3000);
  }

  toJsonl(): string {
    if (this.turn || this.next.length || this.writing)
      throw new Error(`${this.header.name} ends with work in progress`);
    const app = {
      ...(this.appCursorAtStart ? { cursor: this.appCursorAtStart } : {}),
      ...(this.oldestCached ? { oldest_cached: this.oldestCached } : {}),
    };
    const header = {
      transcript: this.header.name,
      scenario: this.header.scenario,
      title: this.header.title,
      summary: this.header.summary,
      guarantees: this.header.guarantees,
      app,
    };
    return [header, ...this.lines].map((line) => JSON.stringify(line)).join("\n") + "\n";
  }
}
