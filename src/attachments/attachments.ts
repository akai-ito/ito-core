import { createHash } from "node:crypto";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { isImage, readDimensions } from "#attachments/media.ts";
import type { Attachment } from "#protocol/types.ts";
import { fail, type Result } from "#result.ts";
import type { SavedAttachment, Store } from "#store/store.ts";

export type Attachments = {
  readonly save: (id: string, name: string, mediaType: string, bytes: Buffer) => Result<SavedAttachment, "id_conflict">;
  readonly find: (id: string) => Attachment | undefined;
  readonly pathOf: (id: string) => string;
  readonly sweep: (before: string) => void;
};

export const maxAttachmentBytes = 20 * 1024 * 1024;

const unknownType = "application/octet-stream";

export const toMediaType = (contentType = unknownType): string => {
  const [mediaType = ""] = contentType.split(";", 1);
  return mediaType.trim().toLowerCase() === "" ? unknownType : mediaType.trim().toLowerCase();
};

export const createAttachments = (store: Store, directory: string): Attachments => {
  mkdirSync(directory, { recursive: true });
  const pathOf = (id: string): string => path.join(directory, path.basename(id));

  return {
    save: (id, name, mediaType, bytes) => {
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const existing = store.findAttachment(id);
      if (existing) {
        return existing.sha256 === sha256
          ? { ok: true, value: { attachment: existing.attachment, isNew: false } }
          : fail("id_conflict");
      }
      const kind = isImage(mediaType) ? "image" : "file";
      const dimensions = kind === "image" ? readDimensions(bytes, mediaType) : undefined;
      const attachment: Attachment = {
        id,
        kind,
        name,
        media_type: mediaType,
        size: bytes.length,
        ...(dimensions && { width: dimensions.width, height: dimensions.height }),
      };
      const partial = `${pathOf(id)}.part`;
      writeFileSync(partial, bytes);
      renameSync(partial, pathOf(id));
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
  };
};
