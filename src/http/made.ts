import type { FastifyInstance } from "fastify";
import { toCommandError } from "#conversation/failures.ts";
import type { RouteSchema } from "#http/validation.ts";
import type { MadeFailure, MadePages } from "#made/made.ts";

type MadePath = { readonly made: string };

const statusOf = (failure: MadeFailure): 400 | 404 => (failure.code === "not_found" ? 404 : 400);

const errorOf = (failure: MadeFailure): ReturnType<typeof toCommandError> =>
  toCommandError(failure.code === "not_found" ? "not_found" : "invalid_request", failure.detail);

// The Made shelf, one page with its content and ticks, and ticking. The merge-patch content type is registered with
// the motion routes, which share it.
export const registerMade = (
  app: FastifyInstance,
  made: MadePages,
  schemaFor: (operationId: string) => RouteSchema,
): void => {
  app.get("/v0/made", () => ({ made: made.list() }));

  app.get<{ Params: MadePath }>("/v0/made/:made", { schema: schemaFor("getMade") }, (request, reply) => {
    const detail = made.detail(request.params.made);
    return detail.ok ? detail.value : reply.code(statusOf(detail.failure)).send({ error: errorOf(detail.failure) });
  });

  app.patch<{ Params: MadePath; Body: unknown }>(
    "/v0/made/:made/state",
    { schema: schemaFor("patchMadeState") },
    (request, reply) => {
      const patched = made.patchState(request.params.made, request.body);
      return patched.ok
        ? { state: patched.value }
        : reply.code(statusOf(patched.failure)).send({ error: errorOf(patched.failure) });
    },
  );
};
