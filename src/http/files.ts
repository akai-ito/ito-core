import type { FastifyInstance } from "fastify";
import type { ShownFiles } from "#files/files.ts";
import type { RouteSchema } from "#http/validation.ts";

export type FileRoutesOptions = {
  readonly files: ShownFiles;
  readonly schemaFor: (operationId: string) => RouteSchema;
};

type FilePath = { readonly file: string };

export const registerFiles = (app: FastifyInstance, { files, schemaFor }: FileRoutesOptions): void => {
  app.get("/v0/files", { schema: schemaFor("listFiles") }, () => ({ files: [...files.list()] }));

  app.get<{ Params: FilePath }>("/v0/files/:file", { schema: schemaFor("getFile") }, (request, reply) => {
    const found = files.find(request.params.file);
    return found
      ? { file: found }
      : reply.code(404).send({
          error: {
            code: "not_found",
            message: "That file isn't on the server any more.",
            detail: `No file ${request.params.file}.`,
          },
        });
  });

  app.delete<{ Params: FilePath }>("/v0/files/:file", { schema: schemaFor("deleteFile") }, (request, reply) => {
    files.remove(request.params.file);
    return reply.code(204).send();
  });
};
