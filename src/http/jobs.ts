import type { FastifyInstance } from "fastify";
import { toRouteSchemas } from "#http/validation.ts";
import type { Jobs } from "#jobs/jobs.ts";
import type { Schemas } from "#protocol/schemas.ts";

export type JobRoutesOptions = { readonly jobs: Pick<Jobs, "list">; readonly schemas: Schemas };

export const registerJobs = (app: FastifyInstance, { jobs, schemas }: JobRoutesOptions): void => {
  app.get("/v0/jobs", { schema: toRouteSchemas(schemas).get("listJobs") ?? {} }, () => ({ jobs: jobs.list() }));
};
