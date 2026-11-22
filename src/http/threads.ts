import type { FastifyInstance } from "fastify";
import { toCommandError } from "#conversation/failures.ts";
import { toMessageId, toThreadId, type MessageId, type ThreadId } from "#conversation/ids.ts";
import type { RouteSchema } from "#http/validation.ts";
import type { MoveMessage, ThreadChange } from "#protocol/types.ts";
import type { Store } from "#store/store.ts";

export type ThreadRoutesOptions = {
  readonly store: Store;
  // You moved a message: the conversations it left and joined hear of it.
  readonly moved: (message: MessageId, from: ThreadId | undefined, to: ThreadId | undefined) => void;
  readonly schemaFor: (operationId: string) => RouteSchema;
};

const notFound = (id: string) => ({
  error: toCommandError("not_found", `No thread ${id}.`, "That thread isn't on the server."),
});

export const registerThreads = (app: FastifyInstance, { store, moved, schemaFor }: ThreadRoutesOptions): void => {
  app.get<{ Querystring: { readonly query?: string; readonly before?: string; readonly limit: number } }>(
    "/v0/threads",
    { schema: schemaFor("listThreads") },
    async (request, reply) => {
      const { query = "", before, limit } = request.query;
      if (before !== undefined && !store.findThread(toThreadId(before))) return reply.code(404).send(notFound(before));
      const listed = store.listThreads(query, before === undefined ? undefined : toThreadId(before), limit);
      return { open: listed.open, threads: listed.done, has_more: listed.hasMore };
    },
  );

  app.get<{ Params: { readonly thread: string } }>(
    "/v0/threads/:thread",
    { schema: schemaFor("getThread") },
    async (request, reply) => {
      const page = store.threadPage(toThreadId(request.params.thread));
      if (!page) return reply.code(404).send(notFound(request.params.thread));
      return {
        thread: page.thread,
        ...(page.anchor && { anchor: page.anchor }),
        messages: page.messages,
        steps: page.steps,
        asks: page.asks,
        turn: page.turn,
        next: page.next,
        has_more: page.hasMore,
      };
    },
  );

  app.patch<{ Params: { readonly thread: string }; Body: ThreadChange }>(
    "/v0/threads/:thread",
    { schema: schemaFor("changeThread") },
    async (request, reply) => {
      const { title, state } = request.body;
      const thread = store.changeThread(toThreadId(request.params.thread), {
        by: "you",
        ...(title !== undefined && { title: title.replaceAll(/\s+/gu, " ").trim() }),
        ...(state !== undefined && { state }),
      });
      return thread ? { thread } : reply.code(404).send(notFound(request.params.thread));
    },
  );

  app.post<{ Params: { readonly thread: string } }>(
    "/v0/threads/:thread/seen",
    { schema: schemaFor("seeThread") },
    async (request, reply) => {
      const thread = store.seeThread(toThreadId(request.params.thread));
      return thread ? { thread } : reply.code(404).send(notFound(request.params.thread));
    },
  );

  app.post<{ Params: { readonly message: string }; Body: MoveMessage }>(
    "/v0/messages/:message/move",
    { schema: schemaFor("moveMessage") },
    async (request, reply) => {
      const message = toMessageId(request.params.message);
      const before = store.findMessage(message);
      const to = request.body.thread === undefined ? undefined : toThreadId(request.body.thread);
      const done = store.moveMessage(message, to);
      if (done.ok) {
        const from = before?.thread === undefined ? undefined : toThreadId(before.thread);
        if (from !== to) moved(message, from, to);
        return { message: done.value };
      }
      switch (done.failure) {
        case "not_found": {
          return reply.code(404).send({
            error: toCommandError("not_found", `No message ${message}.`, "That message isn't on the server."),
          });
        }
        case "unknown_thread": {
          return reply.code(404).send(notFound(request.body.thread ?? ""));
        }
        case "anchor": {
          return reply.code(400).send({
            error: toCommandError("invalid_request", "A message a thread hangs from stays in the main chat."),
          });
        }
      }
    },
  );
};
