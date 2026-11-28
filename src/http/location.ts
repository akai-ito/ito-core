import type { FastifyInstance } from "fastify";
import { toCommandError } from "#conversation/failures.ts";
import { toRouteSchemas } from "#http/validation.ts";
import type { Location } from "#location/location.ts";
import type { Schemas } from "#protocol/schemas.ts";
import type { ForgetLocation, LocationBatch, PhotoSeeds, PlaceChange } from "#protocol/types.ts";
import type { Result } from "#result.ts";

export type LocationRoutesOptions = {
  readonly location: Location;
  readonly schemas: Schemas;
};

type Range = { readonly from?: string; readonly to?: string };

const invalid = (detail: string) => ({ error: toCommandError("invalid_request", detail, detail) });

const answer = <Value>(result: Result<Value, string>) =>
  result.ok ? { status: 200, body: result.value as unknown } : { status: 400, body: invalid(result.failure) };

const isDay = (text: string): boolean => {
  const at = Date.parse(`${text}T00:00:00.000Z`);
  return !Number.isNaN(at) && new Date(at).toISOString().startsWith(text);
};

// Places: the phone's uploads and seeds, forgetting, and reading places, trips, heat and a day's thread and trail.
export const registerLocation = (app: FastifyInstance, { location, schemas }: LocationRoutesOptions): void => {
  const routeSchemas = toRouteSchemas(schemas);
  const schemaFor = (operationId: string) => routeSchemas.get(operationId) ?? {};

  const badRange = ({ from, to }: Range): string | undefined => {
    if ((from !== undefined && !isDay(from)) || (to !== undefined && !isDay(to))) return "Give days as YYYY-MM-DD.";
    return from !== undefined && to !== undefined && from > to ? "The range ends before it begins." : undefined;
  };

  app.post<{ Body: LocationBatch }>(
    "/v0/location/batches",
    { schema: schemaFor("uploadLocation") },
    async (request, reply) => {
      const { status, body } = answer(location.upload(request.body));
      return reply.code(status).send(body);
    },
  );

  app.post<{ Body: PhotoSeeds }>(
    "/v0/location/photos",
    { schema: schemaFor("seedLocationFromPhotos") },
    async (request, reply) => {
      const { status, body } = answer(location.seed(request.body));
      return reply.code(status).send(body);
    },
  );

  app.get("/v0/location", { schema: schemaFor("getLocation") }, () => location.held());

  app.post<{ Body: ForgetLocation }>(
    "/v0/location/forget",
    { schema: schemaFor("forgetLocation") },
    async (request, reply) => {
      const { status, body } = answer(location.forget(request.body));
      return reply.code(status).send(body);
    },
  );

  app.get<{
    Querystring: { readonly from: string; readonly to: string; readonly precision: number; readonly full?: number };
  }>("/v0/location/heat", { schema: schemaFor("getHeat") }, async (request, reply) => {
    const { from, to, precision, full } = request.query;
    const problem = badRange({ from, to });
    if (problem !== undefined) return reply.code(400).send(invalid(problem));
    location.freshen();
    return location.days.heat(from, to, precision, full);
  });

  app.get<{ Params: { readonly day: string } }>(
    "/v0/location/days/:day",
    { schema: schemaFor("getDayThread") },
    async (request, reply) => {
      const { day } = request.params;
      return isDay(day) ? location.days.thread(day) : reply.code(400).send(invalid("Give the day as YYYY-MM-DD."));
    },
  );

  app.get<{ Params: { readonly day: string } }>(
    "/v0/location/days/:day/trail",
    { schema: schemaFor("getDayTrail") },
    async (request, reply) => {
      const { day } = request.params;
      return isDay(day) ? location.days.trail(day) : reply.code(400).send(invalid("Give the day as YYYY-MM-DD."));
    },
  );

  app.get<{ Querystring: Range }>("/v0/location/trips", { schema: schemaFor("listTrips") }, async (request, reply) => {
    const problem = badRange(request.query);
    return problem === undefined
      ? { trips: location.days.trips(request.query.from, request.query.to) }
      : reply.code(400).send(invalid(problem));
  });

  app.get<{ Querystring: Range }>("/v0/places", { schema: schemaFor("listPlaces") }, async (request, reply) => {
    const problem = badRange(request.query);
    if (problem !== undefined) return reply.code(400).send(invalid(problem));
    location.freshen();
    return { places: location.places(request.query.from, request.query.to) };
  });

  app.get<{ Params: { readonly place: string } }>(
    "/v0/places/:place",
    { schema: schemaFor("getPlace") },
    async (request, reply) => {
      const page = location.place(request.params.place);
      return (
        page ??
        reply
          .code(404)
          .send({ error: toCommandError("not_found", `No place ${request.params.place}.`, "That place has gone.") })
      );
    },
  );

  app.patch<{ Params: { readonly place: string }; Body: PlaceChange }>(
    "/v0/places/:place",
    { schema: schemaFor("changePlace") },
    async (request, reply) => {
      const { place } = request.params;
      const changed = location.change(place, request.body);
      if (changed.ok) return { place: changed.value };
      return changed.failure === "not_found"
        ? reply.code(404).send({ error: toCommandError("not_found", `No place ${place}.`, "That place has gone.") })
        : reply.code(400).send(invalid(changed.failure));
    },
  );
};
