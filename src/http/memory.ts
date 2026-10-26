import type { FastifyInstance } from "fastify";
import { toCommandError } from "#conversation/failures.ts";
import type { RouteSchema } from "#http/validation.ts";
import type { Memory } from "#memory/memory.ts";
import type { Shelf } from "#memory/pages.ts";

export const registerMemory = (
  app: FastifyInstance,
  memory: Memory,
  schemaFor: (operationId: string) => RouteSchema,
): void => {
  app.get("/v0/memory/in-mind", () => ({ pages: memory.inMind() }));

  app.get("/v0/memory/shelves", () => ({ shelves: memory.shelves() }));

  app.get<{ Querystring: { readonly shelf: Shelf } }>(
    "/v0/memory/pages",
    { schema: schemaFor("listPages") },
    (request) => ({ pages: memory.pages(request.query.shelf) }),
  );

  app.get("/v0/memory/recent", () => ({ pages: memory.recent() }));

  app.get<{ Querystring: { readonly address: string } }>(
    "/v0/memory/page",
    { schema: schemaFor("getPage") },
    (request, reply) => {
      const page = memory.page(request.query.address);
      if (page.ok) return page.value;
      return page.failure.code === "not_found"
        ? reply.code(404).send({ error: toCommandError("not_found", page.failure.detail) })
        : reply.code(400).send({ error: toCommandError("invalid_request", page.failure.detail) });
    },
  );

  app.get<{ Params: { readonly change: string } }>(
    "/v0/memory/changes/:change",
    { schema: schemaFor("getChange") },
    async (request, reply) => {
      const change = await memory.change(request.params.change);
      return (
        change ?? reply.code(404).send({ error: toCommandError("not_found", `No change ${request.params.change}.`) })
      );
    },
  );
};
