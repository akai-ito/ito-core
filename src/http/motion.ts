import type { FastifyInstance } from "fastify";
import { toCommandError } from "#conversation/failures.ts";
import type { RouteSchema } from "#http/validation.ts";
import type { MotionFailure, Motions } from "#motion/motion.ts";

type MotionPath = { readonly motion: string };

const statusOf = (failure: MotionFailure): 400 | 404 => (failure.code === "not_found" ? 404 : 400);

const errorOf = (failure: MotionFailure): ReturnType<typeof toCommandError> =>
  toCommandError(failure.code === "not_found" ? "not_found" : "invalid_request", failure.detail);

export const registerMotion = (
  app: FastifyInstance,
  motions: Motions,
  schemaFor: (operationId: string) => RouteSchema,
): void => {
  app.addContentTypeParser("application/merge-patch+json", { parseAs: "string" }, (_request, body, done) => {
    try {
      done(null, JSON.parse(String(body)));
    } catch (error) {
      done(error instanceof Error ? error : new Error(String(error)), undefined);
    }
  });

  app.get("/v0/motion", async () => {
    await motions.ready;
    return { motions: motions.list() };
  });

  app.get<{ Params: MotionPath; Querystring: { readonly version?: number } }>(
    "/v0/motion/:motion",
    { schema: schemaFor("getMotion") },
    async (request, reply) => {
      await motions.ready;
      const detail = await motions.detail(request.params.motion, request.query.version);
      return detail.ok ? detail.value : reply.code(statusOf(detail.failure)).send({ error: errorOf(detail.failure) });
    },
  );

  app.patch<{ Params: MotionPath; Body: unknown }>(
    "/v0/motion/:motion/state",
    { schema: schemaFor("patchMotionState") },
    async (request, reply) => {
      await motions.ready;
      const patched = motions.patchState(request.params.motion, request.body);
      return patched.ok
        ? { state: patched.value }
        : reply.code(statusOf(patched.failure)).send({ error: errorOf(patched.failure) });
    },
  );
};
