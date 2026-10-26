import type { FastifyInstance } from "fastify";
import type { Attachments } from "#attachments/attachments.ts";
import { toCommandError } from "#conversation/failures.ts";
import type { RouteSchema } from "#http/validation.ts";
import type { Memory } from "#memory/memory.ts";
import type { Store } from "#store/store.ts";

type CallPath = { readonly call: string };

type CorrectionsBody = { readonly corrections: readonly { readonly heard: string; readonly meant: string }[] };

export type TalkOptions = {
  readonly store: Store;
  readonly attachments: Attachments;
  readonly memory: Memory;
  readonly schemaFor: (operationId: string) => RouteSchema;
};

const noCall = (call: string): { readonly error: ReturnType<typeof toCommandError> } => ({
  error: toCommandError("not_found", `No call ${call}.`),
});

export const registerTalk = (app: FastifyInstance, { store, attachments, memory, schemaFor }: TalkOptions): void => {
  app.put<{ Params: CallPath }>("/v0/calls/:call", { schema: schemaFor("startCall") }, (request, reply) => {
    const { call, isNew } = store.startCall(request.params.call);
    return reply.code(isNew ? 201 : 200).send({ call });
  });

  app.post<{ Params: CallPath }>("/v0/calls/:call/end", { schema: schemaFor("endCall") }, (request, reply) => {
    const call = store.endCall(request.params.call);
    return call ? { call } : reply.code(404).send(noCall(request.params.call));
  });

  app.delete<{ Params: CallPath }>(
    "/v0/calls/:call/audio",
    { schema: schemaFor("deleteCallAudio") },
    (request, reply) => {
      const deleted = store.deleteCallAudio(request.params.call);
      if (!deleted) return reply.code(404).send(noCall(request.params.call));
      for (const id of deleted.audio) attachments.remove(id);
      return { call: deleted.call };
    },
  );

  app.get("/v0/vocabulary", async () => ({ terms: await memory.vocabulary() }));

  app.post<{ Body: CorrectionsBody }>(
    "/v0/vocabulary/corrections",
    { schema: schemaFor("teachVocabulary") },
    async (request) => ({ corrections: await memory.learn(request.body.corrections) }),
  );
};
