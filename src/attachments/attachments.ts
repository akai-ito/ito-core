import { createHash } from "node:crypto";
import {
  closeSync,
  copyFileSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { isImage, readDimensions } from "#attachments/media.ts";
import type { Attachment } from "#protocol/types.ts";
import { fail, type Result } from "#result.ts";
import type { SavedAttachment, Store } from "#store/store.ts";

export type Attachments = {
  readonly save: (id: string, name: string, mediaType: string, bytes: Buffer) => Result<SavedAttachment, "id_conflict">;
  // Takes a whole file that's already on disk, such as a finished big upload, by moving it into place.
  readonly adopt: (
    id: string,
    name: string,
    mediaType: string,
    file: string,
    sha256: string,
  ) => Result<SavedAttachment, "id_conflict">;
  readonly find: (id: string) => Attachment | undefined;
  readonly pathOf: (id: string) => string;
  readonly sweep: (before: string) => void;
  readonly remove: (id: string) => void;
};

export const maxAttachmentBytes = 20 * 1024 * 1024;

const unknownType = "application/octet-stream";

// Enough of an image's start to find its size, past a large EXIF block.
const headerBytes = 256 * 1024;

const kindOf = (mediaType: string): Attachment["kind"] =>
  isImage(mediaType) ? "image" : mediaType.startsWith("audio/") ? "audio" : "file";

const readStart = (file: string, length: number): Buffer => {
  const descriptor = openSync(file, "r");
  try {
    const start = Buffer.alloc(length);
    const read = readSync(descriptor, start, 0, length, 0);
    return start.subarray(0, read);
  } finally {
    closeSync(descriptor);
  }
};

const describe = (id: string, name: string, mediaType: string, size: number, start: Buffer): Attachment => {
  const kind = kindOf(mediaType);
  const dimensions = kind === "image" ? readDimensions(start, mediaType) : undefined;
  return {
    id,
    kind,
    name,
    media_type: mediaType,
    size,
    ...(dimensions && { width: dimensions.width, height: dimensions.height }),
  };
};

const moveFile = (from: string, to: string): void => {
  try {
    renameSync(from, to);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    copyFileSync(from, to);
    rmSync(from, { force: true });
  }
};

export const toMediaType = (contentType = unknownType): string => {
  const [mediaType = ""] = contentType.split(";", 1);
  return mediaType.trim().toLowerCase() === "" ? unknownType : mediaType.trim().toLowerCase();
};

export const createAttachments = (store: Store, directory: string): Attachments => {
  mkdirSync(directory, { recursive: true });
  const pathOf = (id: string): string => path.join(directory, path.basename(id));
  const syncFolder = (): void => {
    const folder = openSync(directory, "r");
    fsyncSync(folder);
    closeSync(folder);
  };

  return {
    save: (id, name, mediaType, bytes) => {
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const existing = store.findAttachment(id);
      if (existing) {
        return existing.sha256 === sha256
          ? { ok: true, value: { attachment: existing.attachment, isNew: false } }
          : fail("id_conflict");
      }
      const attachment = describe(id, name, mediaType, bytes.length, bytes);
      const partial = `${pathOf(id)}.part`;
      writeFileSync(partial, bytes, { flush: true });
      renameSync(partial, pathOf(id));
      syncFolder();
      return store.saveAttachment(attachment, sha256);
    },
    adopt: (id, name, mediaType, file, sha256) => {
      const existing = store.findAttachment(id);
      if (existing) {
        if (existing.sha256 !== sha256) return fail("id_conflict");
        rmSync(file, { force: true });
        return { ok: true, value: { attachment: existing.attachment, isNew: false } };
      }
      const attachment = describe(id, name, mediaType, statSync(file).size, readStart(file, headerBytes));
      moveFile(file, pathOf(id));
      syncFolder();
      return store.saveAttachment(attachment, sha256);
    },
    find: (id) => store.findAttachment(id)?.attachment,
    pathOf,
    sweep: (before) => {
      for (const id of store.unattachedBefore(before)) {
        rmSync(pathOf(id), { force: true });
        store.deleteAttachment(id);
      }
    },
    remove: (id) => {
      rmSync(pathOf(id), { force: true });
      store.deleteAttachment(id);
    },
  };
};
