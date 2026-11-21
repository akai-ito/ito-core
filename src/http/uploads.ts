import type { FastifyInstance, FastifyReply } from "fastify";
import { toMediaType } from "#attachments/attachments.ts";
import { describeAudioFormats, type UploadKind } from "#attachments/formats.ts";
import type { ChunkFailure, FinishFailure, StartFailure, Uploads } from "#attachments/uploads.ts";
import type { RouteSchema } from "#http/validation.ts";
import { fieldOf } from "#tools/input.ts";
import type { Error as ErrorBody, Upload } from "#protocol/types.ts";

export type UploadRoutesOptions = {
  readonly uploads: Uploads;
  readonly schemaFor: (operationId: string) => RouteSchema;
};

type UploadPath = { readonly upload: string };

type CreateBody = {
  readonly id: string;
  readonly name: string;
  readonly media_type: string;
  readonly size: number;
};

const mebibyte = 1024 * 1024;

export const megabytes = (bytes: number): string => {
  if (bytes >= 1024 * mebibyte && bytes % (1024 * mebibyte) === 0) return `${String(bytes / (1024 * mebibyte))} GB`;
  return bytes < mebibyte ? `${String(Math.round(bytes / 1024))} KB` : `${String(Math.round(bytes / mebibyte))} MB`;
};

const kindName: Readonly<Record<UploadKind, string>> = { audio: "A recording", image: "A photo", file: "A file" };

const error = (code: string, message: string, detail?: string): { readonly error: ErrorBody } => ({
  error: { code, message, ...(detail !== undefined && { detail }) },
});

const unsupported = (mediaType: string, isContent: boolean): { readonly error: ErrorBody } =>
  error(
    "unsupported_type",
    mediaType.startsWith("audio/")
      ? `Ito takes recordings as ${describeAudioFormats}.`
      : "Ito doesn't take this kind of file as a big upload. Recordings, photos and documents such as PDFs go.",
    isContent
      ? `The file's first bytes aren't ${mediaType}.`
      : `${mediaType} isn't a media type big uploads take: GET /v0/uploads lists them.`,
  );

const diskFull = (freeBytes: number): { readonly error: ErrorBody } =>
  error(
    "server_disk_full",
    "Your server's disk hasn't room for this file.",
    `${megabytes(freeBytes)} free, and Ito keeps 512 MB spare.`,
  );

const notFound = (id: string): { readonly error: ErrorBody } =>
  error("not_found", "That upload isn't on the server. Start it again.", `No upload ${id}.`);

// A refusal that says where the upload stands, so the app carries on from there.
const standing = (
  upload: Upload,
  code: string,
  message: string,
  detail: string,
): { readonly error: ErrorBody; readonly upload: Upload } => ({ error: { code, message, detail }, upload });

const sendStartFailure = (reply: FastifyReply, failure: StartFailure): FastifyReply => {
  switch (failure.code) {
    case "unsupported_type": {
      return reply.code(415).send(unsupported(failure.mediaType, false));
    }
    case "too_large": {
      return reply
        .code(413)
        .send(
          error(
            "too_large",
            `${kindName[failure.kind]} can be up to ${megabytes(failure.maxBytes)}.`,
            `The most for ${failure.kind} is ${String(failure.maxBytes)} bytes.`,
          ),
        );
    }
    case "id_conflict": {
      return reply
        .code(409)
        .send(error("id_conflict", "A different file was already uploaded with this id.", "Use a new id."));
    }
    case "server_disk_full": {
      return reply.code(507).send(diskFull(failure.freeBytes));
    }
  }
};

const sendChunkFailure = (reply: FastifyReply, id: string, failure: ChunkFailure): FastifyReply => {
  switch (failure.code) {
    case "not_found": {
      return reply.code(404).send(notFound(id));
    }
    case "offset_mismatch": {
      const { upload } = failure;
      const detail = `The server has ${String(upload.received)} bytes; send from there.`;
      const message = "Part of the upload went missing; it carries on from where the server is.";
      return reply.code(409).send(standing(upload, "offset_mismatch", message, detail));
    }
    case "past_the_end": {
      const { upload } = failure;
      const detail = `The upload is ${String(upload.size)} bytes.`;
      return reply.code(400).send(standing(upload, "invalid_request", "That's more than the file's size.", detail));
    }
    case "server_disk_full": {
      return reply.code(507).send(diskFull(failure.freeBytes));
    }
  }
};

const sendFinishFailure = (reply: FastifyReply, id: string, failure: FinishFailure): FastifyReply => {
  switch (failure.code) {
    case "not_found": {
      return reply.code(404).send(notFound(id));
    }
    case "upload_incomplete": {
      const { upload } = failure;
      const detail = `The server has ${String(upload.received)} of ${String(upload.size)} bytes.`;
      return reply.code(409).send(standing(upload, "upload_incomplete", "The upload isn't finished yet.", detail));
    }
    case "checksum_mismatch": {
      const message = "The file got damaged on the way, so it's uploading again.";
      const detail = "The SHA-256 of what arrived doesn't match; the upload starts over from offset 0.";
      return reply.code(422).send(standing(failure.upload, "checksum_mismatch", message, detail));
    }
    case "unsupported_type": {
      return reply.code(415).send(unsupported(failure.mediaType, true));
    }
    case "id_conflict": {
      return reply
        .code(409)
        .send(error("id_conflict", "A different file was already uploaded with this id.", "Use a new id."));
    }
  }
};

export const registerUploads = (app: FastifyInstance, { uploads, schemaFor }: UploadRoutesOptions): void => {
  app.get("/v0/uploads", { schema: schemaFor("listUploads") }, () => ({
    limits: uploads.limits(),
    uploads: [...uploads.unfinished()],
  }));

  app.post<{ Body: CreateBody }>("/v0/uploads", { schema: schemaFor("createUpload") }, (request, reply) => {
    const { id, name, media_type: mediaType, size } = request.body;
    const started = uploads.start({ id, name, mediaType: toMediaType(mediaType), size });
    return started.ok
      ? reply.code(started.value.isNew ? 201 : 200).send({ upload: started.value.upload })
      : sendStartFailure(reply, started.failure);
  });

  app.get<{ Params: UploadPath }>("/v0/uploads/:upload", { schema: schemaFor("getUpload") }, (request, reply) => {
    const found = uploads.find(request.params.upload);
    return found ? { upload: found } : reply.code(404).send(notFound(request.params.upload));
  });

  app.delete<{ Params: UploadPath }>("/v0/uploads/:upload", { schema: schemaFor("cancelUpload") }, (request, reply) => {
    uploads.cancel(request.params.upload);
    return reply.code(204).send();
  });

  // The body is optional, so it's checked here rather than by a schema that would refuse none.
  const { params: finishParameters } = schemaFor("finishUpload");
  app.post<{ Params: UploadPath; Body: unknown }>(
    "/v0/uploads/:upload/finish",
    { schema: { ...(finishParameters && { params: finishParameters }) } },
    async (request, reply) => {
      const { upload } = request.params;
      const sha256 = fieldOf(request.body, "sha256");
      if (sha256 !== undefined && (typeof sha256 !== "string" || !/^[0-9a-f]{64}$/u.test(sha256))) {
        return reply
          .code(400)
          .send(error("invalid_request", "The request isn't valid.", "sha256 is the file's SHA-256 in lowercase hex."));
      }
      const finished = await uploads.finish(upload, sha256);
      return finished.ok
        ? reply.code(finished.value.isNew ? 201 : 200).send({ attachment: finished.value.attachment })
        : sendFinishFailure(reply, upload, finished.failure);
    },
  );

  const chunkBytes = uploads.limits().chunk_bytes;
  void app.register((chunks, _options, registered) => {
    chunks.removeAllContentTypeParsers();
    chunks.addContentTypeParser("*", { parseAs: "buffer", bodyLimit: chunkBytes }, (_request, body, done) => {
      done(null, body);
    });
    chunks.put<{ Params: UploadPath; Querystring: { readonly offset: number }; Body: Buffer | undefined }>(
      "/v0/uploads/:upload",
      { schema: schemaFor("sendUploadChunk"), bodyLimit: chunkBytes },
      (request, reply) => {
        const { upload } = request.params;
        const received = uploads.receive(upload, request.query.offset, request.body ?? Buffer.alloc(0));
        return received.ok ? { upload: received.value } : sendChunkFailure(reply, upload, received.failure);
      },
    );
    registered();
  });
};

export const tooLargeChunk = (chunkBytes: number): { readonly error: ErrorBody } =>
  error(
    "too_large",
    "That piece of the upload is too big.",
    `A chunk can be up to ${megabytes(chunkBytes)} (${String(chunkBytes)} bytes).`,
  );
