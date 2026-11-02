import type { FastifyInstance } from "fastify";
import type { Status } from "#day/status.ts";
import { toRouteSchemas } from "#http/validation.ts";
import type { Schemas } from "#protocol/schemas.ts";
import type { DeviceStatus } from "#protocol/types.ts";

export type StatusRoutesOptions = { readonly status: Pick<Status, "setFocus" | "held">; readonly schemas: Schemas };

export const registerStatus = (app: FastifyInstance, { status, schemas }: StatusRoutesOptions): void => {
  const routeSchemas = toRouteSchemas(schemas);

  app.get<{ Params: { readonly device: string } }>(
    "/v0/devices/:device/status",
    { schema: routeSchemas.get("getStatus") ?? {} },
    (request) => status.held(request.params.device),
  );

  app.put<{ Params: { readonly device: string }; Body: DeviceStatus }>(
    "/v0/devices/:device/status",
    { schema: routeSchemas.get("setStatus") ?? {} },
    async (request, reply) => {
      status.setFocus(request.params.device, request.body.focus);
      return reply.code(204).send();
    },
  );
};
