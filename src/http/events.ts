import type { FastifyReply, FastifyRequest } from "fastify";
import { createCell } from "#cell.ts";
import type { Cancel, Clock } from "#clock.ts";
import { toEventId } from "#conversation/ids.ts";
import type { LogEntry, SnapshotEntry, Store } from "#store/store.ts";

export type StreamOptions = {
  readonly store: Store;
  readonly clock: Clock;
  readonly protocol: string;
  readonly heartbeatMs: number;
  readonly maxReplay: number;
};

const maxLagBytes = 1024 * 1024;

const toFrame = (id: string | undefined, data: unknown): string =>
  `${id ? `id: ${id}\n` : ""}data: ${JSON.stringify(data)}\n\n`;

const cursorOf = (request: FastifyRequest): string | undefined => {
  const header = request.headers["last-event-id"];
  return typeof header === "string" && header !== "" ? header : undefined;
};

const catchUp = (
  store: Store,
  cursor: string | undefined,
  maxReplay: number,
): readonly (LogEntry | SnapshotEntry)[] => {
  if (cursor === undefined) return [store.snapshot("no_cursor")];
  const replay = store.eventsAfter(toEventId(cursor));
  if (replay.ok && replay.value.length <= maxReplay) return replay.value;
  return [store.snapshot(replay.ok ? "too_far_behind" : replay.failure)];
};

export const createEventStream =
  ({ store, clock, protocol, heartbeatMs, maxReplay }: StreamOptions) =>
  (request: FastifyRequest, reply: FastifyReply): void => {
    reply.hijack();
    const response = reply.raw;
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-accel-buffering": "no",
      "ito-protocol": protocol,
    });
    response.flushHeaders();

    const entries = catchUp(store, cursorOf(request), maxReplay);
    const burst = entries.map(({ event }) => toFrame(event.id, event)).join("");
    const allowedBytes = Buffer.byteLength(burst) + maxLagBytes;
    const lastSeq = createCell(entries.at(-1)?.seq ?? 0);
    if (burst !== "") response.write(burst);

    const write = (frame: string): void => {
      response.write(frame);
      if (response.writableLength > allowedBytes) response.destroy();
    };
    const unsubscribe = store.subscribe((entry) => {
      if (entry.seq <= lastSeq.get()) return;
      lastSeq.set(entry.seq);
      write(toFrame(entry.event.id, entry.event));
    });

    const heartbeat = createCell<Cancel | undefined>(undefined);
    const beat = (): void => {
      heartbeat.set(
        clock.after(heartbeatMs, () => {
          write(": ping\n\n");
          beat();
        }),
      );
    };
    beat();
    response.on("close", () => {
      unsubscribe();
      heartbeat.get()?.();
    });
  };
