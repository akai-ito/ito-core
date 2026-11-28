import type { FastifyInstance } from "fastify";
import { toCommandError } from "#conversation/failures.ts";
import { toRouteSchemas } from "#http/validation.ts";
import type { Schemas } from "#protocol/schemas.ts";
import type { QuestionReply } from "#protocol/types.ts";
import type { Result } from "#result.ts";
import type { Questions } from "#work/questions.ts";
import type { Tracks } from "#work/tracks.ts";

export type UnderstandingRoutesOptions = {
  readonly questions: Pick<Questions, "open" | "recent" | "answer" | "notNow">;
  readonly tracks: Pick<Tracks, "list">;
  readonly schemas: Schemas;
};

type QuestionPath = { readonly question: string };

const toFailure = (id: string, failure: string) =>
  failure === "not_found"
    ? { status: 404, body: { error: toCommandError("not_found", `No question ${id}.`, "That question has gone.") } }
    : { status: 400, body: { error: toCommandError("invalid_request", failure, failure) } };

const toAnswer = (id: string, result: Result<unknown, string>, status: number) =>
  result.ok ? { status, body: { question: result.value } } : toFailure(id, result.failure);

// Understanding you: every learning track with the questions waiting quietly on it, and answering them.
export const registerUnderstanding = (
  app: FastifyInstance,
  { questions, tracks, schemas }: UnderstandingRoutesOptions,
): void => {
  const routeSchemas = toRouteSchemas(schemas);
  const schemaFor = (operationId: string) => routeSchemas.get(operationId) ?? {};

  app.get("/v0/understanding", { schema: schemaFor("getUnderstanding") }, () => ({
    tracks: tracks.list(),
    questions: questions.open(),
    recent: questions.recent(),
  }));

  app.post<{ Params: QuestionPath; Body: QuestionReply }>(
    "/v0/understanding/questions/:question/answer",
    { schema: schemaFor("answerQuestion") },
    async (request, reply) => {
      const { question } = request.params;
      const { status, body } = toAnswer(question, questions.answer(question, request.body), 202);
      return reply.code(status).send(body);
    },
  );

  app.post<{ Params: QuestionPath }>(
    "/v0/understanding/questions/:question/not-now",
    { schema: schemaFor("notNowQuestion") },
    async (request, reply) => {
      const { question } = request.params;
      const { status, body } = toAnswer(question, questions.notNow(question), 200);
      return reply.code(status).send(body);
    },
  );
};
