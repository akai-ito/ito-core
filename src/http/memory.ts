import { createReadStream } from "node:fs";
import type { FastifyInstance } from "fastify";
import { toCommandError } from "#conversation/failures.ts";
import type { RouteSchema } from "#http/validation.ts";
import type { Backup } from "#memory/backup.ts";
import type { Memory } from "#memory/memory.ts";
import type { Shelf } from "#memory/pages.ts";

export const registerMemory = (
  app: FastifyInstance,
  memory: Memory,
  backup: Backup,
  schemaFor: (operationId: string) => RouteSchema,
): void => {
  app.get("/v0/memory/backup", () => backup.status());

  app.post("/v0/memory/backup", async (_request, reply) => {
    const started = await backup.connect();
    if (started.ok) return started.value;
    return started.failure.code === "invalid"
      ? reply
          .code(400)
          .send({ error: toCommandError("invalid_request", started.failure.detail, started.failure.detail) })
      : reply
          .code(503)
          .send({ error: toCommandError("unavailable", started.failure.detail, "GitHub can't be reached.") });
  });

  app.delete("/v0/memory/backup", () => backup.disconnect());

  app.get("/v0/memory/in-mind", async () => {
    await memory.sync();
    return { pages: memory.inMind() };
  });

  app.get("/v0/memory/shelves", async () => {
    await memory.sync();
    return { shelves: memory.shelves() };
  });

  app.get<{ Querystring: { readonly shelf: Shelf } }>(
    "/v0/memory/pages",
    { schema: schemaFor("listPages") },
    async (request) => {
      await memory.sync();
      return { pages: memory.pages(request.query.shelf) };
    },
  );

  app.get("/v0/memory/recent", async () => {
    await memory.sync();
    return { changes: memory.recent() };
  });

  app.get<{ Querystring: { readonly address: string } }>(
    "/v0/memory/page",
    { schema: schemaFor("getPage") },
    async (request, reply) => {
      await memory.sync();
      const page = memory.page(request.query.address);
      if (page.ok) return page.value;
      return page.failure.code === "not_found"
        ? reply.code(404).send({ error: toCommandError("not_found", page.failure.detail) })
        : reply.code(400).send({ error: toCommandError("invalid_request", page.failure.detail) });
    },
  );

  // A photo's name is made from what's in it, so its bytes never change.
  app.get<{ Params: { readonly media: string } }>(
    "/v0/memory/media/:media",
    { schema: schemaFor("getMemoryMedia") },
    async (request, reply) => {
      await memory.ready;
      const found = memory.media(request.params.media);
      return found
        ? reply
            .header("content-type", found.mediaType)
            .header("content-length", String(found.size))
            .header("cache-control", "private, max-age=31536000, immutable")
            .send(createReadStream(found.file))
        : reply.code(404).send({ error: toCommandError("not_found", `No photo ${request.params.media} in memory.`) });
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
