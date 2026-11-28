import type { FastifyInstance } from "fastify";
import { toCommandError } from "#conversation/failures.ts";
import type { Dreams } from "#dream/dream.ts";
import { toRouteSchemas } from "#http/validation.ts";
import type { Schemas } from "#protocol/schemas.ts";
import type { DreamTime } from "#protocol/types.ts";

export type DreamRoutesOptions = {
  readonly dreams: Pick<Dreams, "state" | "dreamNow" | "setTime" | "see">;
  readonly schemas: Schemas;
};

export const registerDream = (app: FastifyInstance, { dreams, schemas }: DreamRoutesOptions): void => {
  const routeSchemas = toRouteSchemas(schemas);
  const schemaFor = (operationId: string) => routeSchemas.get(operationId) ?? {};

  app.get("/v0/dream", { schema: schemaFor("getDream") }, () => dreams.state());

  app.post("/v0/dream", { schema: schemaFor("dreamNow") }, async (_request, reply) =>
    reply.code(202).send(dreams.dreamNow()),
  );

  app.put<{ Body: DreamTime }>("/v0/dream/time", { schema: schemaFor("setDreamTime") }, async (request, reply) => {
    const set = dreams.setTime(request.body.time);
    return set.ok ? set.value : reply.code(400).send({ error: toCommandError("invalid_request", set.failure) });
  });

  app.post<{ Params: { readonly dream: string } }>(
    "/v0/dreams/:dream/seen",
    { schema: schemaFor("seeDream") },
    async (request, reply) => {
      const seen = dreams.see(request.params.dream);
      return seen
        ? { dream: seen }
        : reply
            .code(404)
            .send({ error: toCommandError("not_found", `No dream ${request.params.dream}.`, "That dream has gone.") });
    },
  );
};
