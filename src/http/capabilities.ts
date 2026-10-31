import type { FastifyInstance, FastifyReply } from "fastify";
import type { Capability, Host, HostFailure } from "#capabilities/host.ts";
import type { Field, Values } from "#capabilities/manifest.ts";
import { toTimestamp } from "#clock.ts";
import { toCommandError } from "#conversation/failures.ts";
import type { RouteSchema } from "#http/validation.ts";
import type {
  Capability as CapabilityBody,
  CapabilityField,
  CapabilitySetup,
  SwitchCapability,
} from "#protocol/types.ts";

type CapabilityPath = { readonly capability: string };

const toField = (field: Field, values: Values): CapabilityField => {
  const value = values[field.name];
  const isSet = value !== undefined && value !== "";
  return {
    name: field.name,
    kind: field.kind,
    title: field.title,
    ...(field.description !== undefined && { description: field.description }),
    ...(field.optional === true && { optional: true }),
    ...(field.options && { options: field.options.map(({ value: option, label }) => ({ value: option, label })) }),
    ...(field.kind === "secret" ? { set: isSet } : isSet && { value }),
    ...(field.connect && {
      connect: {
        kind: field.connect.kind,
        title: field.connect.title,
        ...(field.connect.kind === "link" && { url: field.connect.url }),
      },
    }),
  };
};

export const toCapabilityBody = ({ id, manifest, state, detail, values }: Capability): CapabilityBody => ({
  id,
  kind: manifest?.kind ?? "hand",
  title: manifest?.title ?? id,
  summary: manifest?.summary ?? "",
  ...(manifest?.symbol !== undefined && { symbol: manifest.symbol }),
  version: manifest?.version ?? "0.0",
  state,
  ...(detail !== undefined && { detail }),
  fields: (manifest?.setup ?? []).map((field) => toField(field, values)),
  uses: { hosts: [...(manifest?.uses.hosts ?? [])], folders: [...(manifest?.uses.folders ?? [])] },
});

const refuse = (reply: FastifyReply, { code, detail }: HostFailure): FastifyReply => {
  switch (code) {
    case "not_found": {
      return reply.code(404).send({ error: toCommandError("not_found", detail) });
    }
    case "invalid_values": {
      return reply.code(400).send({ error: toCommandError("invalid_request", detail, "Ito can't save that setup.") });
    }
    case "unavailable": {
      return reply.code(503).send({ error: toCommandError("unavailable", detail, "The provider can't be reached.") });
    }
  }
};

export const registerCapabilities = (
  app: FastifyInstance,
  host: Host,
  schemaFor: (operationId: string) => RouteSchema,
): void => {
  app.get("/v0/capabilities", () => ({ capabilities: host.list().map((capability) => toCapabilityBody(capability)) }));

  app.put<{ Params: CapabilityPath; Body: SwitchCapability }>(
    "/v0/capabilities/:capability",
    { schema: schemaFor("switchCapability") },
    async (request, reply) => {
      const switched = await host.switchTo(request.params.capability, request.body.on);
      return switched.ok ? toCapabilityBody(switched.value) : refuse(reply, switched.failure);
    },
  );

  app.put<{ Params: CapabilityPath; Body: CapabilitySetup }>(
    "/v0/capabilities/:capability/setup",
    { schema: schemaFor("setUpCapability") },
    async (request, reply) => {
      const saved = await host.setUp(request.params.capability, request.body.values);
      return saved.ok ? toCapabilityBody(saved.value) : refuse(reply, saved.failure);
    },
  );

  app.post<{ Params: CapabilityPath }>(
    "/v0/capabilities/:capability/connect",
    { schema: schemaFor("connectCapability") },
    async (request, reply) => {
      const connected = await host.connect(request.params.capability);
      if (!connected.ok) return refuse(reply, connected.failure);
      const { code, url, expiresAt } = connected.value;
      return { code, url, expires_at: toTimestamp(expiresAt) };
    },
  );

  app.post<{ Params: CapabilityPath; Body: CapabilitySetup }>(
    "/v0/capabilities/:capability/check",
    { schema: schemaFor("checkCapability") },
    async (request, reply) => {
      const checked = await host.check(request.params.capability, request.body.values);
      return checked.ok ? checked.value : refuse(reply, checked.failure);
    },
  );
};
