import type { FastifyInstance } from "fastify";
import type { Attachments } from "#attachments/attachments.ts";
import { toCommandError } from "#conversation/failures.ts";
import type { RouteSchema } from "#http/validation.ts";
import type { Memory } from "#memory/memory.ts";
import type { Store } from "#store/store.ts";
import type { VoiceLoop } from "#voice/loop.ts";
import { chosenVoice, isKnownVoice, unknownVoice, voices, voiceSetting } from "#voice/voices.ts";

type CallPath = { readonly call: string };

type SpeechBody = { readonly text: string; readonly voice?: string };

type VoiceBody = { readonly voice: string };

type CorrectionsBody = { readonly corrections: readonly { readonly heard: string; readonly meant: string }[] };

export type TalkOptions = {
  readonly store: Store;
  readonly attachments: Attachments;
  readonly memory: Memory;
  readonly voice: VoiceLoop;
  readonly schemaFor: (operationId: string) => RouteSchema;
};

const noCall = (call: string): { readonly error: ReturnType<typeof toCommandError> } => ({
  error: toCommandError("not_found", `No call ${call}.`),
});

export const registerTalk = (
  app: FastifyInstance,
  { store, attachments, memory, voice, schemaFor }: TalkOptions,
): void => {
  app.put<{ Params: CallPath }>("/v0/calls/:call", { schema: schemaFor("startCall") }, (request, reply) => {
    void voice.refreshVocabulary();
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

  app.get("/v0/voices", () => ({ voices, chosen: chosenVoice(store), ...voice.readiness() }));

  app.put<{ Body: VoiceBody }>("/v0/voice", { schema: schemaFor("chooseVoice") }, (request, reply) => {
    const chosen = request.body.voice;
    if (!isKnownVoice(chosen))
      return reply.code(400).send({ error: toCommandError("invalid_request", unknownVoice(chosen)) });
    store.setSetting(voiceSetting, chosen);
    return { voice: chosen };
  });

  app.post<{ Body: SpeechBody }>("/v0/speech", { schema: schemaFor("speak") }, async (request, reply) => {
    const chosen = request.body.voice ?? chosenVoice(store);
    if (!isKnownVoice(chosen))
      return reply.code(400).send({ error: toCommandError("invalid_request", unknownVoice(chosen)) });
    const spoken = await voice.speak(request.body.text, chosen);
    if (spoken.ok) return reply.type("audio/wav").send(Buffer.from(spoken.value));
    const { code, detail } = spoken.failure;
    if (code === "failed") return reply.code(500).send({ error: toCommandError("internal", detail) });
    const unavailable = { error: toCommandError("unavailable", detail, "Ari's voice isn't ready.") };
    return voice.readiness().state === "loading"
      ? reply.code(503).header("retry-after", "10").send(unavailable)
      : reply.code(503).send(unavailable);
  });

  app.post<{ Body: CorrectionsBody }>(
    "/v0/vocabulary/corrections",
    { schema: schemaFor("teachVocabulary") },
    async (request) => {
      const corrections = await memory.learn(request.body.corrections);
      void voice.refreshVocabulary();
      return { corrections };
    },
  );
};
