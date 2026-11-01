import type { FastifyInstance } from "fastify";
import { toCommandError } from "#conversation/failures.ts";
import type { BlockAnswer } from "#day/blocks.ts";
import type { DayPicture } from "#day/picture.ts";
import { toRouteSchemas } from "#http/validation.ts";
import type { Schemas } from "#protocol/schemas.ts";
import type { GuessAnswer } from "#protocol/types.ts";

export type DayRoutesOptions = { readonly picture: Pick<DayPicture, "answer">; readonly schemas: Schemas };

const toAnswer = (body: GuessAnswer): BlockAnswer => {
  if (body.right === true) return { right: true };
  if (body.activity !== undefined) return { activity: body.activity };
  return { text: (body.text ?? "").trim() };
};

export const registerDay = (app: FastifyInstance, { picture, schemas }: DayRoutesOptions): void => {
  app.post<{ Params: { readonly item: string }; Body: GuessAnswer }>(
    "/v0/desk/guesses/:item/answer",
    { schema: toRouteSchemas(schemas).get("answerGuess") ?? {} },
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
