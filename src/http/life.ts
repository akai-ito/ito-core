import type { FastifyInstance } from "fastify";
import { toCommandError } from "#conversation/failures.ts";
import { toRouteSchemas } from "#http/validation.ts";
import type { Life } from "#life/life.ts";
import type { Schemas } from "#protocol/schemas.ts";

export type LifeRoutesOptions = {
  readonly life: Life;
  readonly schemas: Schemas;
};

// Life: the search on top, the days of a range for the Week, Month and Year sheets, Going on, and what Kumo knows
// about you.
export const registerLife = (app: FastifyInstance, { life, schemas }: LifeRoutesOptions): void => {
  const routeSchemas = toRouteSchemas(schemas);
  const schemaFor = (operationId: string) => routeSchemas.get(operationId) ?? {};

  app.get<{ Querystring: { readonly query: string } }>(
    "/v0/life/search",
    { schema: schemaFor("searchLife") },
    async (request, reply) => {
      const found = await life.search(request.query.query);
      return found.ok
        ? found.value
        : reply.code(400).send({ error: toCommandError("invalid_request", found.failure, found.failure) });
    },
  );

  app.get<{ Querystring: { readonly from: string; readonly to: string } }>(
    "/v0/life/days",
    { schema: schemaFor("getLifeDays") },
    async (request, reply) => {
      const days = await life.days(request.query.from, request.query.to);
      return days.ok
        ? days.value
        : reply.code(400).send({ error: toCommandError("invalid_request", days.failure, days.failure) });
    },
  );

  app.get("/v0/life/going-on", { schema: schemaFor("getGoingOn") }, async () => ({ threads: await life.goingOn() }));

  app.get("/v0/life/about-you", { schema: schemaFor("getAboutYou") }, () => life.aboutYou());
};
