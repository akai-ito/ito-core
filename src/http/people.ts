import type { FastifyInstance } from "fastify";
import { toCommandError } from "#conversation/failures.ts";
import { toRouteSchemas } from "#http/validation.ts";
import type { CircleChange } from "#people/circles.ts";
import type { PeopleKeeper } from "#people/people.ts";
import type { Schemas } from "#protocol/schemas.ts";

export type PeopleRoutesOptions = {
  readonly people: Pick<PeopleKeeper, "list" | "person" | "photo" | "circles" | "changeCircles">;
  readonly schemas: Schemas;
};

// People: everyone Kumo keeps a page on, grouped by circle in his order, a person's page with their card's facts,
// their Contacts photos, and the order of the circles.
export const registerPeople = (app: FastifyInstance, { people, schemas }: PeopleRoutesOptions): void => {
  const routeSchemas = toRouteSchemas(schemas);
  const schemaFor = (operationId: string) => routeSchemas.get(operationId) ?? {};

  app.get("/v0/people", { schema: schemaFor("listPeople") }, () => people.list());

  app.get("/v0/people/circles", { schema: schemaFor("getCircles") }, () => people.circles());

  app.put<{ Body: { readonly circles: readonly CircleChange[] } }>(
    "/v0/people/circles",
    { schema: schemaFor("changeCircles") },
    async (request, reply) => {
      const changed = await people.changeCircles(request.body.circles);
      return changed.ok
        ? changed.value
        : reply.code(400).send({ error: toCommandError("invalid_request", changed.failure, changed.failure) });
    },
  );

  // A photo's name is made from what's in it, so its bytes never change.
  app.get<{ Params: { readonly photo: string } }>(
    "/v0/people/photos/:photo",
    { schema: schemaFor("getPersonPhoto") },
    async (request, reply) => {
      const found = people.photo(request.params.photo);
      return found
        ? reply
            .header("content-type", found.mediaType)
            .header("content-length", String(found.bytes.length))
            .header("cache-control", "private, max-age=31536000, immutable")
            .send(found.bytes)
        : reply.code(404).send({ error: toCommandError("not_found", `No photo ${request.params.photo} in Contacts.`) });
    },
  );

  app.get<{ Params: { readonly person: string } }>(
    "/v0/people/:person",
    { schema: schemaFor("getPerson") },
    async (request, reply) => {
      const found = await people.person(request.params.person);
      return (
        found ??
        reply
          .code(404)
          .send({ error: toCommandError("not_found", `No one called ${request.params.person} in People.`) })
      );
    },
  );
};
