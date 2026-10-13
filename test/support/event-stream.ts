import { setTimeout as delay } from "node:timers/promises";
import { createAsyncQueue } from "#async-queue.ts";
import { createCell } from "#cell.ts";

export type EventStream = {
  readonly status: number;
  readonly headers: Headers;
  readonly next: (timeoutMs: number) => Promise<unknown>;
  readonly close: () => void;
};

const toEvent = (frame: string): unknown => {
  const data = frame
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => line.slice("data: ".length))
    .join("\n");
  return data === "" ? undefined : JSON.parse(data);
};

export const openEventStream = async (url: string, headers: Readonly<Record<string, string>>): Promise<EventStream> => {
  const controller = new AbortController();
  const response = await fetch(url, { headers, signal: controller.signal });
  const queue = createAsyncQueue<unknown>();
  const iterator = queue[Symbol.asyncIterator]();
  const buffer = createCell("");

  const pump = async (): Promise<void> => {
    const decoder = new TextDecoder();
    try {
      if (!response.body) return;
      for await (const chunk of response.body) {
        const frames = (buffer.get() + decoder.decode(chunk, { stream: true })).split("\n\n");
        buffer.set(frames.at(-1) ?? "");
        const complete = frames.slice(0, -1);
        for (const frame of complete) {
          const event = toEvent(frame);
          if (event !== undefined) queue.push(event);
        }
      }
    } catch {
      return;
    } finally {
      queue.end();
    }
  };
  void pump();

  const inFlight = createCell<Promise<IteratorResult<unknown, undefined>> | undefined>(undefined);
  const timedOut = Symbol("timed out");

  return {
    status: response.status,
    headers: response.headers,
    next: async (timeoutMs) => {
      const read = inFlight.get() ?? iterator.next();
      inFlight.set(read);
      const result = await Promise.race([read, delay(timeoutMs, timedOut)]);
      if (result === timedOut) return;
      inFlight.set(undefined);
      return result.done ? undefined : result.value;
    },
    close: () => {
      controller.abort();
    },
  };
};
