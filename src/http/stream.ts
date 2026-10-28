import websocket from "@fastify/websocket";
import type { FastifyInstance } from "fastify";
import type { RawData, WebSocket } from "ws";
import { toCommandError } from "#conversation/failures.ts";
import type { Store } from "#store/store.ts";
import type { CallSocket, FromApp } from "#voice/call.ts";
import type { Calls } from "#voice/calls.ts";
import type { VoiceLoop } from "#voice/loop.ts";

type CallPath = { readonly call: string };

export type StreamOptions = {
  readonly store: Store;
  readonly calls: Calls;
  readonly voice: VoiceLoop;
  readonly protocol: string;
};

const toBytes = (data: RawData): Uint8Array =>
  Array.isArray(data) ? Buffer.concat(data) : data instanceof ArrayBuffer ? new Uint8Array(data) : data;

const simpleFrames = ["mute", "unmute", "end"] as const;

const toFrame = (data: RawData): FromApp | undefined => {
  try {
    const frame = JSON.parse(Buffer.from(toBytes(data)).toString("utf8")) as unknown;
    if (typeof frame !== "object" || frame === null) return undefined;
    const { type, id, cut } = frame as { readonly type?: unknown; readonly id?: unknown; readonly cut?: unknown };
    const simple = simpleFrames.find((name) => name === type);
    if (simple) return { type: simple };
    if (type === "played" && typeof id === "string") return { type, id, ...(cut === true && { cut }) };
    return undefined;
  } catch {
    return undefined;
  }
};

const toCallSocket = (socket: WebSocket): CallSocket => ({
  send: (frame) => {
    socket.send(JSON.stringify(frame));
  },
  sendAudio: (pcm) => {
    socket.send(pcm, { binary: true });
  },
  close: (code, reason) => {
    socket.close(code, reason);
  },
});

export const registerStream = (app: FastifyInstance, { store, calls, voice, protocol }: StreamOptions): void => {
  void app.register(async (scoped) => {
    await scoped.register(websocket);
    scoped.websocketServer.on("headers", (headers: string[]) => {
      headers.push(`Ito-Protocol: ${protocol}`);
    });
    scoped.get<{ Params: CallPath }>(
      "/v0/calls/:call/stream",
      {
        websocket: true,
        preValidation: async (request, reply) => {
          const latest = store.latestCall();
          if (latest?.id !== request.params.call || latest.ended_at !== undefined) {
            return reply
              .header("ito-protocol", protocol)
              .code(404)
              .send({ error: toCommandError("not_found", `No call ${request.params.call} is on.`) });
          }
          const { state, reason = "The voice isn't ready." } = voice.readiness();
          if (state !== "ready") {
            return reply
              .header("ito-protocol", protocol)
              .code(503)
              .send({ error: toCommandError("unavailable", reason, "Ari's voice isn't ready.") });
          }
        },
      },
      (socket, request) => {
        const stream = calls.streamFor(request.params.call);
        const callSocket = toCallSocket(socket);
        socket.on("message", (data, isBinary) => {
          if (isBinary) {
            stream.hear(toBytes(data));
            return;
          }
          const frame = toFrame(data);
          if (frame) stream.receive(frame);
        });
        socket.on("close", () => {
          stream.detach(callSocket);
        });
        void stream.attach(callSocket);
      },
    );
  });
};
