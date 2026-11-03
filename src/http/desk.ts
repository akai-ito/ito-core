import type { FastifyInstance } from "fastify";
import { toCommandError, type CommandFailureCode } from "#conversation/failures.ts";
import type { CardAnswer, DeskKeeper } from "#desk/desk.ts";
import type { RouteSchema } from "#http/validation.ts";
import type { Store } from "#store/store.ts";
import type { Corrections } from "#work/corrections.ts";

export type DeskOptions = {
  readonly store: Pick<Store, "desk" | "listDone" | "findDone">;
  readonly desk: DeskKeeper;
  readonly corrections: Pick<Corrections, "correct">;
  readonly today: () => string;
  readonly schemaFor: (operationId: string) => RouteSchema;
};

const toErrorResult = (code: CommandFailureCode, detail: string, message?: string) => ({
  error: toCommandError(code, detail, message),
});

export const registerDesk = (
  app: FastifyInstance,
  { store, desk, corrections, today, schemaFor }: DeskOptions,
): void => {
  app.get("/v0/desk", { schema: schemaFor("getDesk") }, () => store.desk());

  app.post<{ Params: { readonly card: string }; Body: CardAnswer }>(
    "/v0/desk/cards/:card/answer",
    { schema: schemaFor("answerCard") },
    async (request, reply) => {
      const answered = desk.answer(request.params.card, request.body);
      if (answered.ok) return reply.code(202).send({ card: answered.value });
      return answered.failure === "not_found"
        ? reply
            .code(404)
            .send(toErrorResult("not_found", `No card ${request.params.card}.`, "That card isn't on the Desk."))
        : reply.code(400).send(toErrorResult("invalid_request", answered.failure));
    },
  );

  app.get<{ Querystring: { readonly day?: string } }>("/v0/work", { schema: schemaFor("getWork") }, (request) => {
    const { day = today() } = request.query;
    const entries = day === today() ? desk.today() : desk.doneOn(day);
    return {
      day,
      handled: entries.filter(({ quiet }) => !quiet),
      cleared: entries.filter(({ quiet }) => quiet),
    };
  });

  app.get<{ Querystring: { readonly before?: string; readonly limit: number } }>(
    "/v0/done",
    { schema: schemaFor("listDone") },
    async (request, reply) => {
      const { before, limit } = request.query;
      if (before !== undefined && !store.findDone(before)) {
        return reply.code(404).send(toErrorResult("not_found", `No entry ${before}.`));
      }
      const page = store.listDone(before, limit);
      return { entries: page.entries, has_more: page.hasMore };
    },
  );

  app.post<{ Params: { readonly entry: string }; Body: { readonly text?: string } }>(
    "/v0/done/:entry/wrong",
    { schema: schemaFor("correctDone") },
    async (request, reply) => {
      const corrected = await corrections.correct(request.params.entry, request.body.text);
      return corrected.ok
        ? { entry: corrected.value }
        : reply.code(404).send(toErrorResult("not_found", `No entry ${request.params.entry}.`));
    },
  );

  app.post<{ Params: { readonly entry: string } }>(
    "/v0/done/:entry/undo",
    { schema: schemaFor("undoDone") },
    async (request, reply) => {
      const undone = await desk.undo(request.params.entry);
      if (undone.ok) return { entry: undone.value };
      return undone.failure === "not_found"
        ? reply.code(404).send(toErrorResult("not_found", `No entry ${request.params.entry}.`))
        : reply.code(400).send(toErrorResult("invalid_request", undone.failure));
    },
  );
};
