import { createHash } from "node:crypto";
import {
  closeSync,
  createReadStream,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statfsSync,
  statSync,
  truncateSync,
  utimesSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import { maxAttachmentBytes, type Attachments } from "#attachments/attachments.ts";
import { looksLike, signatureBytes, uploadKindOf, uploadKinds, type UploadKind } from "#attachments/formats.ts";
import type { Clock } from "#clock.ts";
import { toTimestamp } from "#clock.ts";
import type { Attachment, Upload, UploadLimits } from "#protocol/types.ts";
import { fail, ok, type Result } from "#result.ts";

// Big uploads: a file too big for one request, such as an hour's recording, goes up in chunks that land on disk as
// they come, so a dropped connection costs one chunk. Each upload is two files in its own folder: what the app said
// is coming, and the bytes so far, whose modified time is when a chunk last arrived. Finished, it becomes an
// attachment like any other.

export type Limits = {
  readonly audioBytes: number;
  readonly imageBytes: number;
  readonly fileBytes: number;
  readonly chunkBytes: number;
};

const megabyte = 1024 * 1024;

export const defaultLimits: Limits = {
  audioBytes: 1024 * megabyte,
  imageBytes: 50 * megabyte,
  fileBytes: 100 * megabyte,
  chunkBytes: 16 * megabyte,
};

// An unfinished upload nothing reaches for this long is deleted.
export const uploadLifetimeMs = 2 * 24 * 60 * 60 * 1000;

// Room the disk keeps after a big upload, so a recording never fills it for the conversation.
const spareBytes = 512 * megabyte;

export type NewUpload = {
  readonly id: string;
  readonly name: string;
  readonly mediaType: string;
  readonly size: number;
};

export type StartFailure =
  | { readonly code: "unsupported_type"; readonly mediaType: string }
  | { readonly code: "too_large"; readonly kind: UploadKind; readonly maxBytes: number }
  | { readonly code: "id_conflict" }
  | { readonly code: "server_disk_full"; readonly freeBytes: number };

export type ChunkFailure =
  | { readonly code: "not_found" }
  | { readonly code: "offset_mismatch"; readonly upload: Upload }
  | { readonly code: "past_the_end"; readonly upload: Upload }
  | { readonly code: "server_disk_full"; readonly freeBytes: number };

export type FinishFailure =
  | { readonly code: "not_found" }
  | { readonly code: "upload_incomplete"; readonly upload: Upload }
  | { readonly code: "checksum_mismatch"; readonly upload: Upload }
  | { readonly code: "unsupported_type"; readonly mediaType: string }
  | { readonly code: "id_conflict" };

export type Started = { readonly upload: Upload; readonly isNew: boolean };

export type Finished = { readonly attachment: Attachment; readonly isNew: boolean };

export type Uploads = {
  readonly limits: () => UploadLimits;
  readonly start: (upload: NewUpload) => Result<Started, StartFailure>;
  readonly find: (id: string) => Upload | undefined;
  readonly receive: (id: string, offset: number, bytes: Buffer) => Result<Upload, ChunkFailure>;
  readonly finish: (id: string, sha256?: string) => Promise<Result<Finished, FinishFailure>>;
  readonly cancel: (id: string) => void;
  readonly unfinished: () => readonly Upload[];
  readonly sweep: () => void;
};

export type UploadsOptions = {
  readonly directory: string;
  readonly attachments: Attachments;
  readonly clock: Clock;
  readonly limits?: Partial<Limits>;
  readonly freeBytes?: (directory: string) => number;
};

type Declared = {
  readonly id: string;
  readonly name: string;
  readonly media_type: string;
  readonly kind: UploadKind;
  readonly size: number;
};

const diskFree = (directory: string): number => {
  const { bavail, bsize } = statfsSync(directory);
  return bavail * bsize;
};

const sha256Of = (file: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(file)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", () => {
        resolve(hash.digest("hex"));
      });
  });

const readStart = (file: string): Buffer => {
  const descriptor = openSync(file, "r");
  try {
    const start = Buffer.alloc(signatureBytes);
    return start.subarray(0, readSync(descriptor, start, 0, signatureBytes, 0));
  } finally {
    closeSync(descriptor);
  }
};

const append = (file: string, bytes: Buffer): void => {
  const descriptor = openSync(file, "a");
  try {
    writeSync(descriptor, bytes);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
};

const finishedUpload = (attachment: Attachment): Upload => ({
  id: attachment.id,
  name: attachment.name,
  media_type: attachment.media_type,
  kind: attachment.kind,
  size: attachment.size,
  received: attachment.size,
  state: "finished",
  attachment,
});

// The file's SHA-256, or nothing when it went while being read.
const hashOf = async (file: string): Promise<string | undefined> => {
  try {
    return await sha256Of(file);
  } catch {
    return;
  }
};

const isSame = (declared: Declared, upload: NewUpload): boolean =>
  declared.name === upload.name && declared.media_type === upload.mediaType && declared.size === upload.size;

export const createUploads = ({
  directory,
  attachments,
  clock,
  limits: given = {},
  freeBytes = diskFree,
}: UploadsOptions): Uploads => {
  mkdirSync(directory, { recursive: true });
  const limits: Limits = { ...defaultLimits, ...given };
  const folderOf = (id: string): string => path.join(directory, path.basename(id));
  const declaredFile = (id: string): string => path.join(folderOf(id), "upload.json");
  const bytesFile = (id: string): string => path.join(folderOf(id), "bytes");
  const maxBytesOf = (kind: UploadKind): number =>
    kind === "audio" ? limits.audioBytes : kind === "image" ? limits.imageBytes : limits.fileBytes;

  const declaredOf = (id: string): Declared | undefined => {
    try {
      return JSON.parse(readFileSync(declaredFile(id), "utf8")) as Declared;
    } catch {
      return undefined;
    }
  };

  const toUpload = (declared: Declared): Upload => {
    const found = statSync(bytesFile(declared.id), { throwIfNoEntry: false });
    return {
      ...declared,
      received: found?.size ?? 0,
      state: "receiving",
      expires_at: toTimestamp((found?.mtimeMs ?? clock.now()) + uploadLifetimeMs),
    };
  };

  const find = (id: string): Upload | undefined => {
    const declared = declaredOf(id);
    if (declared) return toUpload(declared);
    const attachment = attachments.find(id);
    return attachment ? finishedUpload(attachment) : undefined;
  };

  const cancel = (id: string): void => {
    rmSync(folderOf(id), { recursive: true, force: true });
  };

  // Marks a chunk's arrival by the server's clock, which is what the lifetime counts from.
  const touch = (id: string): void => {
    const now = new Date(clock.now());
    utimesSync(bytesFile(id), now, now);
  };

  // The finished attachment, when another finish took the upload first.
  const takenBy = (id: string): Result<Finished, FinishFailure> => {
    const attachment = attachments.find(id);
    return attachment ? ok({ attachment, isNew: false }) : fail({ code: "not_found" });
  };

  return {
    limits: () => ({
      simple_bytes: maxAttachmentBytes,
      chunk_bytes: limits.chunkBytes,
      kinds: uploadKinds.map(({ kind, mediaTypes }) => ({
        kind,
        max_bytes: maxBytesOf(kind),
        media_types: [...mediaTypes],
      })),
    }),

    start: (upload) => {
      const kind = uploadKindOf(upload.mediaType);
      if (kind === undefined) return fail({ code: "unsupported_type", mediaType: upload.mediaType });
      const existing = find(upload.id);
      if (existing) {
        const isSameUpload = isSame(existing, upload);
        return isSameUpload ? ok({ upload: existing, isNew: false }) : fail({ code: "id_conflict" });
      }
      if (upload.size > maxBytesOf(kind)) return fail({ code: "too_large", kind, maxBytes: maxBytesOf(kind) });
      const free = freeBytes(directory);
      if (free < upload.size + spareBytes) return fail({ code: "server_disk_full", freeBytes: free });
      const declared: Declared = {
        id: upload.id,
        name: upload.name,
        media_type: upload.mediaType,
        kind,
        size: upload.size,
      };
      mkdirSync(folderOf(upload.id), { recursive: true });
      writeFileSync(bytesFile(upload.id), "");
      touch(upload.id);
      writeFileSync(`${declaredFile(upload.id)}.part`, JSON.stringify(declared), { flush: true });
      renameSync(`${declaredFile(upload.id)}.part`, declaredFile(upload.id));
      return ok({ upload: toUpload(declared), isNew: true });
    },

    find,

    receive: (id, offset, bytes) => {
      const declared = declaredOf(id);
      if (!declared) {
        const finished = find(id);
        return finished ? ok(finished) : fail({ code: "not_found" });
      }
      const before = toUpload(declared);
      if (offset > before.received) return fail({ code: "offset_mismatch", upload: before });
      const fresh = bytes.subarray(Math.min(bytes.length, before.received - offset));
      if (before.received + fresh.length > declared.size) return fail({ code: "past_the_end", upload: before });
      if (fresh.length === 0) return ok(before);
      const free = freeBytes(directory);
      if (free < fresh.length + spareBytes) return fail({ code: "server_disk_full", freeBytes: free });
      append(bytesFile(id), fresh);
      touch(id);
      return ok(toUpload(declared));
    },

    finish: async (id, sha256) => {
      const declared = declaredOf(id);
      if (!declared) return takenBy(id);
      const upload = toUpload(declared);
      if (upload.received < declared.size) return fail({ code: "upload_incomplete", upload });
      const file = bytesFile(id);
      if (!looksLike(declared.kind, declared.media_type, readStart(file))) {
        cancel(id);
        return fail({ code: "unsupported_type", mediaType: declared.media_type });
      }
      const arrived = await hashOf(file);
      // Another finish may have taken it while this one read it.
      if (arrived === undefined || !existsSync(file)) return takenBy(id);
      if (sha256 !== undefined && sha256 !== arrived) {
        truncateSync(file, 0);
        touch(id);
        return fail({ code: "checksum_mismatch", upload: toUpload(declared) });
      }
      const adopted = attachments.adopt(id, declared.name, declared.media_type, file, arrived);
      cancel(id);
      return adopted.ok ? ok(adopted.value) : fail({ code: "id_conflict" });
    },

    cancel,

    unfinished: () =>
      readdirSync(directory)
        .flatMap((id) => {
          const declared = declaredOf(id);
          return declared ? [toUpload(declared)] : [];
        })
        .toSorted((left, right) => (left.expires_at ?? "").localeCompare(right.expires_at ?? "")),

    sweep: () => {
      const cutoff = toTimestamp(clock.now());
      for (const id of readdirSync(directory)) {
        const declared = declaredOf(id);
        if (!declared || (toUpload(declared).expires_at ?? "") < cutoff) cancel(id);
      }
    },
  };
};

const limitVariables = [
  { variable: "ITO_MAX_RECORDING_MB", field: "audioBytes" },
  { variable: "ITO_MAX_FILE_MB", field: "fileBytes" },
] as const;

// The limits a box sets for itself, in whole megabytes, such as ITO_MAX_RECORDING_MB=2048 for two-gigabyte
// recordings. A value that isn't a positive whole number is a mistake to say, not to ignore.
export const limitsFrom = (environment: NodeJS.ProcessEnv): Result<Partial<Limits>, string> => {
  const read = limitVariables.map(({ variable, field }) => {
    const text = environment[variable]?.trim();
    if (text === undefined || text === "") return ok(undefined);
    const value = Number(text);
    return Number.isSafeInteger(value) && value > 0
      ? ok([field, value * megabyte] as const)
      : fail(`${variable} is ${text}: give a whole number of megabytes, such as 1024.`);
  });
  const problem = read.find((each) => !each.ok);
  return problem?.ok === false
    ? fail(problem.failure)
    : ok(Object.fromEntries(read.flatMap((each) => (each.ok && each.value ? [each.value] : []))));
};
