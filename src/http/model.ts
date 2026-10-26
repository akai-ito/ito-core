import type { FastifyInstance } from "fastify";
import { toCommandError } from "#conversation/failures.ts";
import { choiceSetting, readChoice } from "#engine/engine.ts";
import type { RouteSchema } from "#http/validation.ts";
import type { Error as ErrorBody, ModelChoice, ModelOption } from "#protocol/types.ts";
import { fail, ok, type Result } from "#result.ts";
import type { Settings } from "#store/store.ts";

export type ListModels = () => Promise<Result<readonly ModelOption[], string>>;

const listed = (words: readonly string[]): string =>
  words.length <= 1 ? (words[0] ?? "") : `${words.slice(0, -1).join(", ")} or ${words.at(-1) ?? ""}`;

export const toChoice = (
  models: readonly ModelOption[],
  { model, effort }: ModelChoice,
): Result<ModelChoice, string> => {
  const found = models.find((option) => option.id === model);
  if (!found) return fail(`There's no model called ${model} here: choose ${listed(models.map(({ id }) => id))}.`);
  const efforts = found.efforts.map(({ id }) => id);
  return efforts.includes(effort)
    ? ok({ model, effort })
    : fail(`${found.title} can't think at ${effort}: choose ${listed(efforts)}.`);
};

const defaultChoice = (models: readonly ModelOption[]): ModelChoice | undefined => {
  const found = models.find((option) => option.is_default) ?? models[0];
  return found && { model: found.id, effort: found.default_effort };
};

const unavailable = (detail: string): { readonly error: ErrorBody } => ({
  error: toCommandError("unavailable", detail, "The agent's engine can't list its models right now."),
});

export const registerModel = (
  app: FastifyInstance,
  {
    settings,
    models,
    schemaFor,
  }: {
    readonly settings: Settings;
    readonly models: ListModels;
    readonly schemaFor: (operationId: string) => RouteSchema;
  },
): void => {
  app.get("/v0/models", async (_request, reply) => {
    const listedModels = await models();
    if (!listedModels.ok) return reply.code(503).header("retry-after", "30").send(unavailable(listedModels.failure));
    const chosen = readChoice(settings.setting) ?? defaultChoice(listedModels.value);
    return { models: listedModels.value, ...(chosen && { chosen }) };
  });

  app.put<{ Body: ModelChoice }>("/v0/agent", { schema: schemaFor("chooseModel") }, async (request, reply) => {
    const listedModels = await models();
    if (!listedModels.ok) return reply.code(503).header("retry-after", "30").send(unavailable(listedModels.failure));
    const choice = toChoice(listedModels.value, request.body);
    if (!choice.ok)
      return reply
        .code(400)
        .send({ error: toCommandError("invalid_request", choice.failure, "Ito can't run on that.") });
    settings.setSetting(choiceSetting, JSON.stringify(choice.value));
    return choice.value;
  });
};
