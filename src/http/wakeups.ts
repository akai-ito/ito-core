import type { FastifyInstance } from "fastify";
import { toCommandError } from "#conversation/failures.ts";
import { toRouteSchemas } from "#http/validation.ts";
import type { Schemas } from "#protocol/schemas.ts";
import type { WakeUpChange } from "#protocol/types.ts";
import type { WakeUps } from "#wakeups/wakeups.ts";

export type WakeUpRoutesOptions = {
  readonly wakeUps: Pick<WakeUps, "list" | "change" | "cancel">;
  readonly schemas: Schemas;
};

const notFound = (id: string) => ({
  error: toCommandError("not_found", `No wake-up ${id}.`, "That plan has already gone."),
});

export const registerWakeUps = (app: FastifyInstance, { wakeUps, schemas }: WakeUpRoutesOptions): void => {
  const routeSchemas = toRouteSchemas(schemas);
  const schemaFor = (operationId: string) => routeSchemas.get(operationId) ?? {};

  app.get("/v0/wakeups", { schema: schemaFor("listWakeUps") }, () => ({ wake_ups: wakeUps.list() }));

  app.patch<{ Params: { readonly wake_up: string }; Body: WakeUpChange }>(
    "/v0/wakeups/:wake_up",
    { schema: schemaFor("changeWakeUp") },
    async (request, reply) => {
      const changed = wakeUps.change(request.params.wake_up, request.body);
      if (changed.ok) return { wake_up: changed.value };
      return changed.failure === "not_found"
        ? reply.code(404).send(notFound(request.params.wake_up))
        : reply.code(400).send({ error: toCommandError("invalid_request", changed.failure) });
    },
  );

  app.delete<{ Params: { readonly wake_up: string } }>(
    "/v0/wakeups/:wake_up",
    { schema: schemaFor("cancelWakeUp") },
    async (request, reply) =>
      wakeUps.cancel(request.params.wake_up)
        ? reply.code(204).send()
        : reply.code(404).send(notFound(request.params.wake_up)),
  );
};
