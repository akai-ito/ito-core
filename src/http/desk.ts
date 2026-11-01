import type { FastifyInstance } from "fastify";
import { toCommandError, type CommandFailureCode } from "#conversation/failures.ts";
import type { CardAnswer, DeskKeeper, MomentAnswer } from "#desk/desk.ts";
import type { RouteSchema } from "#http/validation.ts";
import type { WorkKind } from "#protocol/types.ts";
import type { Store } from "#store/store.ts";
import type { Trust } from "#work/trust.ts";

export type DeskOptions = {
  readonly store: Pick<Store, "desk" | "listDone" | "findDone">;
  readonly desk: DeskKeeper;
  readonly trust: Pick<Trust, "ladder" | "correct" | "reset">;
  readonly today: () => string;
  readonly schemaFor: (operationId: string) => RouteSchema;
};

const toErrorResult = (code: CommandFailureCode, detail: string, message?: string) => ({
  error: toCommandError(code, detail, message),
});

export const registerDesk = (app: FastifyInstance, { store, desk, trust, today, schemaFor }: DeskOptions): void => {
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

  app.post<{ Params: { readonly moment: string } }>(
    "/v0/desk/moment/:moment/read",
    { schema: schemaFor("readMoment") },
    async (request, reply) =>
      desk.readMoment(request.params.moment)
        ? reply.code(204).send()
        : reply
            .code(404)
            .send(toErrorResult("not_found", `No moment ${request.params.moment}.`, "That line has moved on.")),
  );

  app.post<{ Params: { readonly moment: string }; Body: MomentAnswer }>(
    "/v0/desk/moment/:moment/answer",
    { schema: schemaFor("answerMoment") },
    async (request, reply) => {
      const answered = desk.answerMoment(request.params.moment, request.body);
      if (answered.ok) return reply.code(202).send({ moment: answered.value });
      return answered.failure === "not_found"
        ? reply
            .code(404)
            .send(toErrorResult("not_found", `No moment ${request.params.moment}.`, "That line has moved on."))
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
      trust: trust.ladder(),
    };
  });

  app.post<{ Params: { readonly work: WorkKind } }>(
    "/v0/trust/:work/reset",
    { schema: schemaFor("resetTrust") },
    async (request, reply) => {
      const reset = trust.reset(request.params.work);
      return reset.ok
        ? { trust: reset.value }
        : reply
            .code(404)
            .send(
              toErrorResult("not_found", `No ${request.params.work} work yet.`, "Kumo hasn't done any of that yet."),
            );
    },
  );

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
      const corrected = await trust.correct(request.params.entry, request.body.text);
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
