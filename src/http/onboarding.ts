import type { FastifyInstance } from "fastify";
import { toCommandError } from "#conversation/failures.ts";
import type { RouteSchema } from "#http/validation.ts";
import type { BeliefAnswer, GettingStarted } from "#onboarding/onboarding.ts";

export type OnboardingOptions = {
  readonly gettingStarted: GettingStarted;
  readonly schemaFor: (operationId: string) => RouteSchema;
};

export const registerOnboarding = (app: FastifyInstance, { gettingStarted, schemaFor }: OnboardingOptions): void => {
  app.get("/v0/onboarding", { schema: schemaFor("getOnboarding") }, () => gettingStarted.state());

  app.post<{ Params: { readonly belief: string }; Body: BeliefAnswer }>(
    "/v0/onboarding/beliefs/:belief",
    { schema: schemaFor("answerBelief") },
    async (request, reply) => {
      const answered = gettingStarted.answer(request.params.belief, request.body);
      return answered.ok
        ? reply.code(202).send()
        : reply.code(404).send({
            error: toCommandError("not_found", `No belief ${request.params.belief}.`, "That belief isn't there."),
          });
    },
  );

  app.post("/v0/onboarding/done", { schema: schemaFor("finishOnboarding") }, () => gettingStarted.finish());
};
