import type { FastifyInstance, FastifyReply } from "fastify";
import type { RouteSchema } from "#http/validation.ts";
import type { Error as ErrorBody, Recording, TranscriptCorrection, Transcription } from "#protocol/types.ts";
import type { Correction, Recordings, TranscriptFailure } from "#recordings/recordings.ts";
import { toText, transcriptLanguages } from "#recordings/transcripts.ts";
import type { Readiness } from "#voice/loop.ts";

export type RecordingRoutesOptions = {
  readonly recordings: Recordings;
  readonly schemaFor: (operationId: string) => RouteSchema;
};

type RecordingPath = { readonly attachment: string };

const consent = "Make sure the other people in a recording are happy for it to be shared.";

// What an app shows before a recording is sent: whether the server can transcribe it now, and in what languages.
export const toTranscription = ({ state, reason }: Readiness): Transcription => ({
  state: state === "failed" ? "unavailable" : state,
  ...(reason !== undefined && state !== "ready" && { reason }),
  languages: [...transcriptLanguages],
  consent,
});

const notFound = (attachment: string): { readonly error: ErrorBody } => ({
  error: { code: "not_found", message: "That recording isn't on the server.", detail: `No recording ${attachment}.` },
});

const sendTranscriptFailure = (reply: FastifyReply, attachment: string, failure: TranscriptFailure): FastifyReply => {
  switch (failure.code) {
    case "not_found": {
      return reply.code(404).send(notFound(attachment));
    }
    case "not_transcribed": {
      const { recording } = failure;
      const error: ErrorBody = {
        code: "not_transcribed",
        message:
          recording.state === "deleted" ? "That recording was deleted." : "That recording isn't transcribed yet.",
        detail: `It's ${recording.state}.`,
      };
      return reply.code(409).send({ error, recording });
    }
    case "unknown_speaker": {
      return reply.code(400).send({
        error: {
          code: "invalid_request",
          message: "That voice isn't in the transcript.",
          detail: `No speaker ${failure.speaker}.`,
        },
      });
    }
  }
};

export const registerRecordings = (app: FastifyInstance, { recordings, schemaFor }: RecordingRoutesOptions): void => {
  app.get("/v0/recordings", { schema: schemaFor("listRecordings") }, () => ({ recordings: [...recordings.list()] }));

  app.get<{ Params: RecordingPath }>(
    "/v0/recordings/:attachment",
    { schema: schemaFor("getRecording") },
    (request, reply) => {
      const found = recordings.find(request.params.attachment);
      return found ? { recording: found.recording } : reply.code(404).send(notFound(request.params.attachment));
    },
  );

  app.delete<{ Params: RecordingPath }>(
    "/v0/recordings/:attachment",
    { schema: schemaFor("deleteRecording") },
    async (request, reply) => {
      const removed = await recordings.remove(request.params.attachment);
      return removed.ok ? { recording: removed.value } : reply.code(404).send(notFound(request.params.attachment));
    },
  );

  app.post<{ Params: RecordingPath }>(
    "/v0/recordings/:attachment/retry",
    { schema: schemaFor("retryRecording") },
    (request, reply) => {
      const retried = recordings.retry(request.params.attachment);
      if (!retried.ok) return reply.code(404).send(notFound(request.params.attachment));
      const { recording, isQueued }: { readonly recording: Recording; readonly isQueued: boolean } = retried.value;
      return reply.code(isQueued ? 202 : 200).send({ recording });
    },
  );

  app.get<{ Params: RecordingPath; Querystring: { readonly format?: "json" | "text" } }>(
    "/v0/recordings/:attachment/transcript",
    { schema: schemaFor("getTranscript") },
    (request, reply) => {
      const { attachment } = request.params;
      const read = recordings.transcript(attachment);
      if (!read.ok) return sendTranscriptFailure(reply, attachment, read.failure);
      return request.query.format === "text"
        ? reply.type("text/plain; charset=utf-8").send(toText(read.value))
        : { transcript: read.value };
    },
  );

  app.post<{
    Params: RecordingPath;
    Body: { readonly replace?: readonly TranscriptCorrection[]; readonly speakers?: Correction["speakers"] };
  }>("/v0/recordings/:attachment/corrections", { schema: schemaFor("correctTranscript") }, (request, reply) => {
    const { attachment } = request.params;
    const corrected = recordings.correct(attachment, request.body);
    return corrected.ok ? { transcript: corrected.value } : sendTranscriptFailure(reply, attachment, corrected.failure);
  });
};
