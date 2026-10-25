import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { createCell } from "#cell.ts";
import { fail, ok, type Result } from "#result.ts";

export type RequestId = string | number;

export type RpcFailure = { readonly code: number; readonly message: string };

export type IncomingNotification = { readonly method: string; readonly parameters: unknown };

export type IncomingRequest = { readonly id: RequestId; readonly method: string; readonly parameters: unknown };

export type ConnectionOptions = {
  readonly input: Readable;
  readonly output: Writable;
  readonly onNotification: (notification: IncomingNotification) => void;
  readonly onRequest: (request: IncomingRequest) => Result<unknown, RpcFailure>;
  readonly onMalformed: (line: string) => void;
  readonly closedMessage: string;
};

export type Cancellation = { readonly signal: AbortSignal; readonly method: string };

export type Connection = {
  readonly request: (
    method: string,
    parameters: unknown,
    cancellation?: Cancellation,
  ) => Promise<Result<unknown, RpcFailure>>;
  readonly notify: (method: string, parameters?: unknown) => void;
  readonly closed: Promise<void>;
};

type Message = Readonly<Record<string, unknown>>;

type Settle = (outcome: Result<unknown, RpcFailure>) => void;

const closedCode = -32_099;

const isMessage = (value: unknown): value is Message =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parse = (line: string): Message | undefined => {
  try {
    const value: unknown = JSON.parse(line);
    return isMessage(value) ? value : undefined;
  } catch {
    return undefined;
  }
};

const isRequestId = (value: unknown): value is RequestId => typeof value === "string" || typeof value === "number";

const toFailure = (error: unknown): RpcFailure =>
  isMessage(error) && typeof error.code === "number" && typeof error.message === "string"
    ? { code: error.code, message: error.message }
    : { code: -32_603, message: JSON.stringify(error) };

export const createConnection = ({
  input,
  output,
  onNotification,
  onRequest,
  onMalformed,
  closedMessage,
}: ConnectionOptions): Connection => {
  const nextId = createCell(1);
  const pending = createCell<ReadonlyMap<RequestId, Settle>>(new Map());
  const isClosed = createCell(false);
  const closed = fail({ code: closedCode, message: closedMessage });

  const send = (message: Message): void => {
    if (output.writable) output.write(`${JSON.stringify(message)}\n`);
  };

  const settle = (id: RequestId, outcome: Result<unknown, RpcFailure>): void => {
    const resolve = pending.get().get(id);
    pending.update((current) => new Map([...current].filter(([key]) => key !== id)));
    resolve?.(outcome);
  };

  const answer = (request: IncomingRequest): void => {
    const outcome = onRequest(request);
    send(outcome.ok ? { id: request.id, result: outcome.value } : { id: request.id, error: outcome.failure });
  };

  const receive = (line: string): void => {
    const message = parse(line);
    if (!message) {
      onMalformed(line);
      return;
    }
    const { id, method, params: parameters } = message;
    if (typeof method === "string") {
      if (isRequestId(id)) answer({ id, method, parameters });
      else onNotification({ method, parameters });
      return;
    }
    if (isRequestId(id)) settle(id, "error" in message ? fail(toFailure(message.error)) : ok(message.result));
  };

  const pump = async (): Promise<void> => {
    const lines = createInterface({ input, crlfDelay: Infinity });
    for await (const line of lines) if (line.trim() !== "") receive(line);
    isClosed.set(true);
    for (const id of pending.get().keys()) settle(id, closed);
  };

  return {
    request: (method, parameters, cancellation) =>
      new Promise((resolve) => {
        if (isClosed.get()) {
          resolve(closed);
          return;
        }
        const id = nextId.get();
        nextId.set(id + 1);
        pending.update((current) => new Map([...current, [id, resolve]]));
        send({ id, method, params: parameters });
        cancellation?.signal.addEventListener(
          "abort",
          () => {
            if (pending.get().has(id)) send({ method: cancellation.method, params: { id } });
          },
          { once: true },
        );
      }),
    notify: (method, parameters) => {
      send(parameters === undefined ? { method } : { method, params: parameters });
    },
    closed: pump(),
  };
};
