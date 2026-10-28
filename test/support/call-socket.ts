import { setTimeout as delay } from "node:timers/promises";
import { WebSocket } from "ws";
import { createAsyncQueue } from "#async-queue.ts";
import { createCell } from "#cell.ts";

export type Arrived =
  { readonly frame: unknown } | { readonly audio_ms: number } | { readonly closed: number; readonly reason: string };

export type CallSocket = {
  readonly status: number;
  readonly headers: Headers;
  readonly body: unknown;
  readonly next: (timeoutMs: number) => Promise<Arrived | undefined>;
  readonly sendFrame: (frame: unknown) => void;
  readonly sendAudio: (bytes: Uint8Array) => void;
  readonly close: () => Promise<void>;
};

const bytesPerMs = 48;

const readBody = async (stream: AsyncIterable<Buffer>): Promise<unknown> => {
  const collect = async (iterator: AsyncIterator<Buffer>, chunks: readonly Buffer[]): Promise<readonly Buffer[]> => {
    const next = await iterator.next();
    return next.done ? chunks : collect(iterator, [...chunks, next.value]);
  };
  const text = Buffer.concat(await collect(stream[Symbol.asyncIterator](), [])).toString("utf8");
  return text === "" ? undefined : JSON.parse(text);
};

export const openCallSocket = async (url: string, headers: Readonly<Record<string, string>>): Promise<CallSocket> => {
  const socket = new WebSocket(url, { headers });
  const queue = createAsyncQueue<Arrived>();
  const iterator = queue[Symbol.asyncIterator]();
  const inFlight = createCell<Promise<IteratorResult<Arrived, undefined>> | undefined>(undefined);
  const timedOut = Symbol("timed out");

  socket.on("message", (data, isBinary) => {
    const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as Buffer);
    queue.push(
      isBinary ? { audio_ms: Math.round(bytes.length / bytesPerMs) } : { frame: JSON.parse(bytes.toString("utf8")) },
    );
  });
  socket.on("close", (code, reason) => {
    queue.push({ closed: code, reason: reason.toString("utf8") });
    queue.end();
  });

  const toHeaders = (raw: Readonly<Record<string, string | readonly string[] | undefined>>): Headers =>
    new Headers(
      Object.entries(raw).flatMap(([name, value]) =>
        value === undefined ? [] : [[name, typeof value === "string" ? value : value.join(", ")] as [string, string]],
      ),
    );
  const upgraded = createCell(new Headers());
  socket.once("upgrade", (response) => {
    upgraded.set(toHeaders(response.headers));
  });
  const opened = await new Promise<{ readonly status: number; readonly headers: Headers; readonly body: unknown }>(
    (resolve) => {
      socket.once("open", () => {
        resolve({ status: 101, headers: upgraded.get(), body: undefined });
      });
      socket.once("unexpected-response", (_request, response) => {
        void readBody(response).then((body) => {
          resolve({ status: response.statusCode ?? 0, headers: toHeaders(response.headers), body });
        });
      });
      socket.once("error", () => {
        resolve({ status: 0, headers: new Headers(), body: undefined });
      });
    },
  );

  return {
    ...opened,
    next: async (timeoutMs) => {
      const read = inFlight.get() ?? iterator.next();
      inFlight.set(read);
      const result = await Promise.race([read, delay(timeoutMs, timedOut)]);
      if (result === timedOut) return;
      inFlight.set(undefined);
      return result.done ? undefined : result.value;
    },
    sendFrame: (frame) => {
      socket.send(JSON.stringify(frame));
    },
    sendAudio: (bytes) => {
      socket.send(bytes, { binary: true });
    },
    close: async () => {
      if (socket.readyState === WebSocket.CLOSED) return;
      const closed = new Promise<void>((resolve) => {
        socket.once("close", () => {
          resolve();
        });
      });
      socket.close();
      await closed;
    },
  };
};
