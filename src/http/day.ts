import type { FastifyInstance } from "fastify";
import { toCommandError } from "#conversation/failures.ts";
import type { BlockAnswer } from "#day/blocks.ts";
import type { ChangeFailure, DayPicture } from "#day/picture.ts";
import { toRouteSchemas } from "#http/validation.ts";
import type { Schemas } from "#protocol/schemas.ts";
import type { Error as ErrorBody, EventMove, GuessAnswer } from "#protocol/types.ts";

export type DayRoutesOptions = {
  readonly picture: Pick<DayPicture, "answer" | "move" | "remove">;
  readonly schemas: Schemas;
};

const statusOf: Readonly<Record<ChangeFailure["code"], 400 | 404 | 503>> = {
  not_found: 404,
  not_kumos: 400,
  invalid: 400,
  unavailable: 503,
};

const errorOf = ({ code, detail }: ChangeFailure): { readonly error: ErrorBody } => {
  switch (code) {
    case "not_found": {
      return { error: toCommandError("not_found", detail, "That's no longer on the calendar.") };
    }
    case "unavailable": {
      return { error: toCommandError("unavailable", detail, "Kumo's calendar isn't reachable.") };
    }
    case "not_kumos":
    case "invalid": {
      return { error: toCommandError("invalid_request", undefined, detail) };
    }
  }
};

const toAnswer = (body: GuessAnswer): BlockAnswer => {
  if (body.right === true) return { right: true };
  if (body.activity !== undefined) return { activity: body.activity };
  return { text: (body.text ?? "").trim() };
};

export const registerDay = (app: FastifyInstance, { picture, schemas }: DayRoutesOptions): void => {
  const routeSchemas = toRouteSchemas(schemas);

  app.patch<{ Params: { readonly item: string }; Body: EventMove }>(
    "/v0/calendar/events/:item",
    { schema: routeSchemas.get("moveEvent") ?? {} },
    async (request, reply) => {
      const moved = await picture.move(request.params.item, request.body.start, request.body.end);
      return moved.ok ? { event: moved.value } : reply.code(statusOf[moved.failure.code]).send(errorOf(moved.failure));
    },
  );

  app.delete<{ Params: { readonly item: string } }>(
    "/v0/calendar/events/:item",
    { schema: routeSchemas.get("removeEvent") ?? {} },
    async (request, reply) => {
      const removed = await picture.remove(request.params.item);
      return removed.ok
        ? reply.code(204).send()
        : reply.code(statusOf[removed.failure.code]).send(errorOf(removed.failure));
    },
  );

  app.post<{ Params: { readonly item: string }; Body: GuessAnswer }>(
    "/v0/desk/guesses/:item/answer",
    { schema: routeSchemas.get("answerGuess") ?? {} },
    async (request, reply) => {
      const answered = await picture.answer(request.params.item, toAnswer(request.body));
      if (answered.ok) return { event: answered.value };
      const { code, detail } = answered.failure;
      return code === "not_found"
        ? reply.code(404).send({ error: toCommandError("not_found", detail, "That guess has moved on.") })
        : reply.code(503).send({ error: toCommandError("unavailable", detail, "Kumo's calendar isn't reachable.") });
    },
  );
};
