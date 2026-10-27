import { createReadStream } from "node:fs";
import Fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyReply,
  type FastifyServerOptions,
} from "fastify";
import { maxAttachmentBytes, toMediaType, type Attachments } from "#attachments/attachments.ts";
import type { Clock } from "#clock.ts";
import { toCommandError, type CommandFailureCode } from "#conversation/failures.ts";
import { accountSetting, effortSetting, modelSetting, readChoice } from "#engine/engine.ts";
import { readApnsCredentials } from "#notifications/apns.ts";
import type { Host } from "#capabilities/host.ts";
import { toAskId, toDeviceId, toMessageId, toTurnId } from "#conversation/ids.ts";
import { createToken, hashToken, type Gate } from "#http/auth.ts";
import { registerCapabilities } from "#http/capabilities.ts";
import { registerMemory } from "#http/memory.ts";
import { registerModel, type ListModels } from "#http/model.ts";
import { registerTalk } from "#http/talk.ts";
import type { Memory } from "#memory/memory.ts";
import type { VoiceLoop } from "#voice/loop.ts";
import { createEventStream } from "#http/events.ts";
import { createValidatorCompiler, toRouteSchemas, type RouteSchema } from "#http/validation.ts";
import { protocolVersion, type Schemas } from "#protocol/schemas.ts";
import type { Presence } from "#notifications/presence.ts";
import type { Error as ErrorBody, Presence as PresenceBody, RegisterDevice, StopTurn } from "#protocol/types.ts";
import type { SpokenInput, Store } from "#store/store.ts";
import { toRetryFailure, type Turns } from "#turns/turns.ts";

export type ServerInfo = { readonly name: string; readonly version: string; readonly agentName: string };

export type AppOptions = {
  readonly store: Store;
  readonly turns: Turns;
  readonly clock: Clock;
  readonly schemas: Schemas;
  readonly info: ServerInfo;
  readonly gate: Gate;
  readonly presence: Presence;
  readonly attachments: Attachments;
  readonly host: Host;
  readonly memory: Memory;
  readonly voice: VoiceLoop;
  readonly models: ListModels;
  readonly heartbeatMs: number;
  readonly logger: FastifyServerOptions["logger"];
};

type ErrorResult = { readonly error: ErrorBody };

type PairBody = { readonly code: string; readonly device_name: string };

const toCode = (code: string): string => code.replaceAll(/[^0-9a-z]/giu, "").toUpperCase();

const tooLargeAttachment = toCommandError(
  "too_large",
  "Attachments can be up to 20 MB.",
  "That file is larger than Ito accepts.",
);

type SendBody = {
  readonly id: string;
  readonly text?: string;
  readonly answers?: string;
  readonly attachments?: readonly string[];
  readonly spoken?: SpokenInput;
};

const maxReplay = 2000;
const bodyLimitBytes = 256 * 1024;

const toErrorResult = (code: CommandFailureCode, detail?: string, message?: string): ErrorResult => ({
  error: toCommandError(code, detail, message),
});

const isTooLong = (error: FastifyError): boolean =>
  error.validation?.some((issue) => issue.keyword === "maxLength" && issue.instancePath === "/text") ?? false;

export const createApp = (options: AppOptions): FastifyInstance => {
  const {
    store,
    turns,
    clock,
    schemas,
    info,
    gate,
    presence,
    attachments,
    host,
    memory,
    voice,
    models,
    heartbeatMs,
    logger,
  } = options;
  const protocol = protocolVersion(schemas.document);
  const routeSchemas = toRouteSchemas(schemas);
  const schemaFor = (operationId: string): RouteSchema => routeSchemas.get(operationId) ?? {};

  const app = Fastify({
    logger,
    forceCloseConnections: true,
    bodyLimit: bodyLimitBytes,
  });
  app.setValidatorCompiler(createValidatorCompiler(schemas));

  const slowDown = (reply: FastifyReply): FastifyReply =>
    reply.code(429).header("retry-after", String(gate.retryAfterSeconds())).send(toErrorResult("slow_down"));

  app.addHook("onRequest", async (request, reply) => {
    const route = request.routeOptions.url;
    if (route === "/v0/pair" || !route?.startsWith("/v0/")) return;
    const verdict = gate.check(request.headers.authorization);
    if (verdict === "accepted") return;
    return verdict === "slow_down"
      ? reply.code(429).header("retry-after", String(gate.retryAfterSeconds())).send(toErrorResult("slow_down"))
      : reply.code(401).send(toErrorResult("token_rejected", "Use the token ito serve printed, or run ito token new."));
  });

  app.addHook("onSend", async (_request, reply, payload) => {
    reply.header("ito-protocol", protocol);
    return payload;
  });

  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (error.statusCode === 413 && request.url.startsWith("/v0/attachments/"))
      return reply.code(413).send({ error: tooLargeAttachment });
    if ((isTooLong(error) && request.url.startsWith("/v0/messages")) || error.statusCode === 413)
      return reply.code(413).send(toErrorResult("too_large", error.message));
    if (error.validation || (error.statusCode !== undefined && error.statusCode < 500)) {
      return reply.code(400).send(toErrorResult("invalid_request", error.message));
    }
    request.log.error(error);
    return reply.code(500).send(toErrorResult("internal", error.message));
  });

  app.setNotFoundHandler((request, reply) =>
    reply.code(404).send(toErrorResult("not_found", `No route for ${request.method} ${request.url}.`)),
  );

  app.get("/.well-known/ito", () => ({ product: "ito", protocol: [protocol] }));

  app.get("/v0/server", () => {
    const choice = readChoice(store.setting);
    const model = choice?.model ?? store.setting(modelSetting);
    const effort = choice?.effort ?? store.setting(effortSetting);
    const account = store.setting(accountSetting);
    return {
      name: info.name,
      version: info.version,
      protocol,
      agent: {
        name: info.agentName,
        ...(model && { model }),
        ...(effort && { effort }),
        ...(account && { account: JSON.parse(account) as unknown }),
      },
      setup: { notifications: readApnsCredentials(store) !== undefined, memory_backup: memory.isBackedUp() },
      capabilities: host.offered().map(({ id, manifest }) => ({ id, version: manifest.version })),
    };
  });

  registerCapabilities(app, host, schemaFor);
  registerMemory(app, memory, schemaFor);
  registerModel(app, { settings: store, models, schemaFor });
  registerTalk(app, { store, attachments, memory, voice, schemaFor });

  app.post<{ Body: PairBody }>("/v0/pair", { schema: schemaFor("pair") }, async (request, reply) => {
    if (gate.isSlowedDown()) return slowDown(reply);
    const { code, device_name: deviceName } = request.body;
    const token = createToken();
    if (!store.pairDevice(hashToken(toCode(code)), deviceName, hashToken(token))) {
      return gate.refuse() === "slow_down"
        ? slowDown(reply)
        : reply.code(401).send(toErrorResult("pairing_code_rejected", "Run ito pair on the server for a new code."));
    }
    return reply.code(201).send({ token });
  });

  app.get(
    "/v0/events",
    createEventStream({ store, clock, protocol, heartbeatMs, maxReplay, openStream: presence.openStream }),
  );

  app.post<{ Body: SendBody }>("/v0/messages", { schema: schemaFor("sendMessage") }, async (request, reply) => {
    const { id, text = "", answers, attachments: attached = [], spoken } = request.body;
    const accepted = store.acceptMessage(
      toMessageId(id),
      text,
      answers === undefined ? undefined : toAskId(answers),
      attached,
      spoken,
    );
    if (!accepted.ok) {
      switch (accepted.failure) {
        case "unknown_ask": {
          return reply.code(400).send(toErrorResult("invalid_request", `No ask ${String(answers)}.`));
        }
        case "unknown_attachment": {
          return reply
            .code(400)
            .send(
              toErrorResult(
                "attachment_missing",
                "Uploads no message names are deleted after a day. Upload this message's attachments again, then send it again.",
              ),
            );
        }
        case "attachment_taken": {
          return reply.code(400).send(toErrorResult("invalid_request", "An attachment belongs to one message."));
        }
        case "secret_attachments": {
          return reply.code(400).send(toErrorResult("invalid_request", "A secret answer can't carry attachments."));
        }
        case "call_not_on": {
          return reply.code(400).send(toErrorResult("invalid_request", `No call ${String(spoken?.call)} is on.`));
        }
        case "id_conflict": {
          return reply
            .code(409)
            .send(
              toErrorResult("id_conflict", `Message ${id} was already accepted with different text or attachments.`),
            );
        }
      }
    }
    if (accepted.value.isNew) turns.route(toMessageId(id), text, accepted.value.message.secret === true);
    return reply.code(accepted.value.isNew ? 201 : 200).send({ message: accepted.value.message });
  });

  app.get<{ Querystring: { readonly before: string; readonly limit: number } }>(
    "/v0/messages",
    { schema: schemaFor("listMessages") },
    async (request, reply) => {
      const { before, limit } = request.query;
      const page = store.listMessages(toMessageId(before), limit);
      return page.ok
        ? {
            messages: page.value.messages,
            steps: page.value.steps,
            asks: page.value.asks,
            calls: page.value.calls,
            has_more: page.value.hasMore,
          }
        : reply
            .code(404)
            .send(toErrorResult("not_found", `No message ${before}.`, "That message isn't on the server."));
    },
  );

  app.post<{ Params: { readonly turn: string }; Body: StopTurn | undefined }>(
    "/v0/turns/:turn/stop",
    { schema: schemaFor("stopTurn") },
    async (request, reply) => {
      const { turn } = request.params;
      const cut = request.body?.cut;
      const state = turns.stop(toTurnId(turn), cut && { message: toMessageId(cut.message), offset: cut.offset });
      if (!state)
        return reply.code(404).send(toErrorResult("not_found", `No turn ${turn}.`, "That turn isn't on the server."));
      return state.state === "stopping"
        ? reply.code(202).send({ turn, state: "stopping" })
        : reply.code(200).send({ turn, state: "ended", outcome: state.outcome });
    },
  );

  app.post<{ Params: { readonly turn: string } }>(
    "/v0/turns/:turn/retry",
    { schema: schemaFor("retryTurn") },
    async (request, reply) => {
      const { turn } = request.params;
      const started = turns.retry(toTurnId(turn));
      if (!started.ok) {
        return reply.code(started.failure === "not_found" ? 404 : 400).send({ error: toRetryFailure(started.failure) });
      }
      return reply.code(started.value.isNew ? 202 : 200).send({ turn: started.value.turn, retry_of: turn });
    },
  );

  void app.register((uploads, _options, registered) => {
    uploads.removeAllContentTypeParsers();
    uploads.addContentTypeParser("*", { parseAs: "buffer", bodyLimit: maxAttachmentBytes }, (_request, body, done) => {
      done(null, body);
    });
    uploads.put<{
      Params: { readonly attachment: string };
      Querystring: { readonly name: string };
      Body: Buffer | undefined;
    }>(
      "/v0/attachments/:attachment",
      { schema: schemaFor("uploadAttachment"), bodyLimit: maxAttachmentBytes },
      async (request, reply) => {
        const mediaType = toMediaType(request.headers["content-type"]);
        const bytes = request.body ?? Buffer.alloc(0);
        const saved = attachments.save(request.params.attachment, request.query.name, mediaType, bytes);
        return saved.ok
          ? reply.code(saved.value.isNew ? 201 : 200).send({ attachment: saved.value.attachment })
          : reply.code(409).send(toErrorResult("id_conflict", "Different bytes were already uploaded with this id."));
      },
    );
    registered();
  });

  app.get<{ Params: { readonly attachment: string } }>(
    "/v0/attachments/:attachment",
    { schema: schemaFor("getAttachment") },
    async (request, reply) => {
      const found = attachments.find(request.params.attachment);
      return found
        ? reply
            .header("content-type", found.media_type)
            .header("content-length", String(found.size))
            .header("cache-control", "private, max-age=31536000, immutable")
            .send(createReadStream(attachments.pathOf(found.id)))
        : reply
            .code(404)
            .send(
              toErrorResult(
                "not_found",
                `No attachment ${request.params.attachment}.`,
                "That file isn't on the server.",
              ),
            );
    },
  );

  app.post<{ Params: { readonly ask: string } }>(
    "/v0/asks/:ask/cancel",
    { schema: schemaFor("cancelAsk") },
    async (request, reply) => {
      const cancelled = turns.cancelAsk(toAskId(request.params.ask));
      return cancelled.ok
        ? { ask: cancelled.value }
        : reply
            .code(404)
            .send(toErrorResult("not_found", `No ask ${request.params.ask}.`, "That question isn't on the server."));
    },
  );

  app.put<{ Params: { readonly device: string }; Body: RegisterDevice }>(
    "/v0/devices/:device",
    { schema: schemaFor("registerDevice") },
    async (request, reply) => {
      const { apns_token: apnsToken, environment, notification_key: notificationKey } = request.body;
      const { device, isNew } = store.registerDevice(toDeviceId(request.params.device), {
        apnsToken,
        environment,
        notificationKey,
      });
      return reply.code(isNew ? 201 : 200).send({
        device: {
          id: device.id,
          environment: device.environment,
          key_id: device.keyId,
          registered_at: device.registeredAt,
        },
      });
    },
  );

  app.delete<{ Params: { readonly device: string } }>(
    "/v0/devices/:device",
    { schema: schemaFor("removeDevice") },
    async (request, reply) => {
      const device = toDeviceId(request.params.device);
      store.removeDevice(device);
      presence.forget(device);
      return reply.code(204).send();
    },
  );

  app.put<{ Params: { readonly device: string }; Body: PresenceBody }>(
    "/v0/devices/:device/presence",
    { schema: schemaFor("setPresence") },
    async (request, reply) => {
      const device = toDeviceId(request.params.device);
      if (store.devices().every((registered) => registered.id !== device)) {
        return reply
          .code(404)
          .send(
            toErrorResult("not_found", `No device ${device}.`, "Register this device before saying you're looking."),
          );
      }
      presence.setLooking(device, request.body.looking);
      return reply.code(204).send();
    },
  );

  return app;
};
