import type { FastifyInstance } from "fastify";
import { toCommandError } from "#conversation/failures.ts";
import { toMessageId } from "#conversation/ids.ts";
import type { RouteSchema } from "#http/validation.ts";
import type { TickItem } from "#protocol/types.ts";
import { blocksIn, toPlan } from "#replies/blocks.ts";
import type { Store } from "#store/store.ts";

type TickPath = { readonly message: string; readonly part: number; readonly item: string };

export const registerReplies = (
  app: FastifyInstance,
  store: Store,
  schemaFor: (operationId: string) => RouteSchema,
): void => {
  app.put<{ Params: TickPath; Body: TickItem }>(
    "/v0/messages/:message/parts/:part/items/:item",
    { schema: schemaFor("tickItem") },
    (request, reply) => {
      const { part, item } = request.params;
      const id = toMessageId(request.params.message);
      const message = store.findMessage(id);
      if (!message) return reply.code(404).send({ error: toCommandError("not_found", `No message ${id}.`) });
      if (message.role !== "agent" || message.kind !== "reply" || message.outcome !== "completed") {
        return reply
          .code(400)
          .send({ error: toCommandError("invalid_request", "Only a finished reply has plans to tick.") });
      }
      const planned = toPlan(blocksIn(message.text)[part])?.items.find((candidate) => candidate.id === item);
      if (!planned) {
        return reply
          .code(404)
          .send({ error: toCommandError("not_found", `Part ${String(part)} of that reply has no item ${item}.`) });
      }
      const ticked = message.ticks?.find((tick) => tick.part === part && tick.item === item)?.done ?? planned.done;
      const { done } = request.body;
      return { ticks: ticked === done ? (message.ticks ?? []) : store.tickItem(id, { part, item, done }) };
    },
  );
};
