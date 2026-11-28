import type { FastifyInstance } from "fastify";
import { toCommandError } from "#conversation/failures.ts";
import { toMessageId } from "#conversation/ids.ts";
import type { RouteSchema } from "#http/validation.ts";
import type { Shares } from "#shares/shares.ts";

export type ShareRoutesOptions = {
  readonly shares: Pick<Shares, "accept">;
  readonly schemaFor: (operationId: string) => RouteSchema;
};

type ShareBody = {
  readonly id: string;
  readonly url?: string;
  readonly text?: string;
  readonly note?: string;
  readonly attachments?: readonly string[];
};

export const registerShares = (app: FastifyInstance, { shares, schemaFor }: ShareRoutesOptions): void => {
  app.post<{ Body: ShareBody }>("/v0/shares", { schema: schemaFor("sendShare") }, async (request, reply) => {
    const { id, url, text, note, attachments = [] } = request.body;
    const accepted = shares.accept(toMessageId(id), {
      ...(url !== undefined && { url }),
      ...(text !== undefined && { text }),
      ...(note !== undefined && { note }),
      attachments,
    });
    if (accepted.ok) return reply.code(accepted.value.isNew ? 201 : 200).send({ share: accepted.value.share });
    switch (accepted.failure) {
      case "id_conflict": {
        return reply.code(409).send({
          error: toCommandError("id_conflict", `Share ${id} was already accepted with different content.`),
        });
      }
      case "unknown_attachment": {
        return reply.code(400).send({
          error: toCommandError(
            "attachment_missing",
            "Uploads no message names are deleted after a day. Upload this share's attachments again, then share it again.",
          ),
        });
      }
      case "attachment_taken": {
        return reply.code(400).send({
          error: toCommandError("invalid_request", "An attachment belongs to one message or share."),
        });
      }
    }
  });
};
