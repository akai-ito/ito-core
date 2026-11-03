import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { maxAttachmentBytes } from "#attachments/attachments.ts";
import { fail, ok, type Result } from "#result.ts";

// The photos a page shows live in the Thread's media folder, beside the shelves, so they go wherever the pages go:
// into their history and the backup. Kumo puts a photo where it belongs in the story by naming a file in its
// workspace, such as ![Leo at the finish](uploads/photo.jpg); the page keeps a copy, scaled down, named by what's
// in it, and points at it from where the page is, so the backup on GitHub shows it too.

export const mediaFolder = "media";

// Enough to fill a phone's screen, small enough that years of photos don't swell the Thread.
export const longestEdge = 2000;

const jpegQuality = 82;

// A name made from the upload's bytes: the same photo kept twice is one file.
const nameLength = 16;

const mediaName = /^[\w-][\w.-]*\.(?:jpe?g|png|gif|webp)$/iu;

const mediaTypes: Readonly<Record<string, string>> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

// ![what it shows](source), ![what it shows](<source with spaces>), each with an optional "title".
const imagePattern = /!\[(?<alt>[^\]\n]*)\]\((?<target><[^>\n]*>|[^\s()<>]+)(?<title>\s+"[^"\n]*")?\)/gu;

export type ImageReference = {
  readonly start: number;
  readonly end: number;
  readonly alt: string;
  readonly source: string;
  readonly title: string;
};

export type MediaFile = { readonly file: string; readonly text: Uint8Array };

export type KeptPhotos = {
  readonly markdown: string;
  readonly files: readonly MediaFile[];
  // How many photos came from the workspace this time.
  readonly count: number;
};

export type KeepPhotos = {
  readonly markdown: string;
  // The page's file in the Thread, such as journal/2026-11-03.md, which photos are pointed at from.
  readonly page: string;
  readonly workspace: string | undefined;
  readonly isInThread: (file: string) => boolean;
};

const decoded = (text: string): string => {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
};

export const imagesIn = (markdown: string): readonly ImageReference[] =>
  markdown
    .matchAll(imagePattern)
    .map((match) => {
      const target = match.groups?.target ?? "";
      return {
        start: match.index,
        end: match.index + match[0].length,
        alt: match.groups?.alt ?? "",
        source: target.startsWith("<") ? target.slice(1, -1) : target,
        title: match.groups?.title ?? "",
      };
    })
    .toArray();

// What a passage says without its pictures' sources: each picture as the words that describe it.
export const withoutSources = (markdown: string): string => markdown.replaceAll(imagePattern, "$<alt>");

const isAddress = (source: string): boolean => /^[a-z][a-z\d+.-]*:/iu.test(source) && !/^[a-z]:[\\/]/iu.test(source);

// A photo's name in the media folder, when a page's source leads there.
export const mediaNameOf = (page: string, source: string): string | undefined => {
  if (isAddress(source) || source.startsWith("/")) return undefined;
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(page), decoded(source)));
  const [folder, name, ...rest] = resolved.split("/");
  return folder === mediaFolder && name !== undefined && rest.length === 0 && mediaName.test(name) ? name : undefined;
};

export const isMediaName = (name: string): boolean => mediaName.test(name) && path.basename(name) === name;

export const mediaTypeOf = (name: string): string => mediaTypes[path.extname(name).toLowerCase()] ?? "image/jpeg";

// Where a page points at a photo in the media folder: from journal/2026-11-03.md, ../media/….jpg.
export const toMediaSource = (page: string, name: string): string =>
  path.posix.relative(path.posix.dirname(page), `${mediaFolder}/${name}`);

const isInside = (folder: string, file: string): boolean => {
  const relative = path.relative(folder, file);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
};

const megabytes = (bytes: number): string => `${String(Math.round(bytes / (1024 * 1024)))} MB`;

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const readUpload = async (workspace: string, source: string): Promise<Result<Buffer, string>> => {
  try {
    const folder = await realpath(workspace);
    const file = await realpath(path.resolve(folder, decoded(source)));
    if (!isInside(folder, file)) return fail(`${source} isn't in your workspace, so it can't go on a page.`);
    const found = await stat(file);
    if (!found.isFile()) return fail(`${source} isn't a file.`);
    if (found.size > maxAttachmentBytes) {
      return fail(`${source} is over ${megabytes(maxAttachmentBytes)}, too big to keep on a page.`);
    }
    return ok(await readFile(file));
  } catch {
    return fail(`There's no ${source} in your workspace.`);
  }
};

// Loaded when a photo is first kept, so a server whose platform sharp doesn't support still runs, without photos.
const loadSharp = async (): Promise<Result<typeof import("sharp").default, string>> => {
  try {
    const { default: sharp } = await import("sharp");
    return ok(sharp);
  } catch (error) {
    return fail(`Photos can't be kept on this server: ${describe(error)}`);
  }
};

// Upright, at most longestEdge on its long side, as a JPEG with nothing else in it: no location, no camera details.
const toJpeg = async (bytes: Buffer, source: string): Promise<Result<Buffer, string>> => {
  const loaded = await loadSharp();
  if (!loaded.ok) return loaded;
  try {
    const sharp = loaded.value;
    return ok(
      await sharp(bytes, { failOn: "error" })
        .rotate()
        .resize({ width: longestEdge, height: longestEdge, fit: "inside", withoutEnlargement: true })
        .flatten({ background: "#ffffff" })
        .jpeg({ quality: jpegQuality })
        .toBuffer(),
    );
  } catch (error) {
    return fail(`${source} couldn't be read as a photo, so nothing was saved: ${describe(error)}`);
  }
};

type Replacement = { readonly start: number; readonly end: number; readonly text: string };

type Kept = { readonly files: readonly MediaFile[]; readonly replacements: readonly Replacement[] };

const keepOne = async (
  { page, workspace, isInThread }: KeepPhotos,
  kept: Kept,
  reference: ImageReference,
): Promise<Result<Kept, string>> => {
  const { source } = reference;
  if (isAddress(source)) return ok(kept);
  const inMemory = mediaNameOf(page, source);
  if (inMemory !== undefined) {
    return isInThread(`${mediaFolder}/${inMemory}`) ? ok(kept) : fail(`There's no photo ${source} in memory.`);
  }
  if (workspace === undefined) return fail(`There's no workspace here, so ${source} can't be found.`);
  const upload = await readUpload(workspace, source);
  if (!upload.ok) return upload;
  const name = `${createHash("sha256").update(upload.value).digest("hex").slice(0, nameLength)}.jpg`;
  const file = `${mediaFolder}/${name}`;
  const isKept = isInThread(file) || kept.files.some((media) => media.file === file);
  const scaled = isKept ? ok(undefined) : await toJpeg(upload.value, source);
  if (!scaled.ok) return scaled;
  return ok({
    files: scaled.value === undefined ? kept.files : [...kept.files, { file, text: scaled.value }],
    replacements: [
      ...kept.replacements,
      {
        start: reference.start,
        end: reference.end,
        text: `![${reference.alt}](${toMediaSource(page, name)}${reference.title})`,
      },
    ],
  });
};

// Copies each photo the Markdown names from the workspace into the media folder, and points the Markdown at the
// copy. A web address is left as it is; a photo already in memory stays where it is.
export const keepPhotos = async (input: KeepPhotos): Promise<Result<KeptPhotos, string>> => {
  const kept = await imagesIn(input.markdown).reduce<Promise<Result<Kept, string>>>(
    async (previous, reference) => {
      const sofar = await previous;
      return sofar.ok ? keepOne(input, sofar.value, reference) : sofar;
    },
    Promise.resolve(ok({ files: [], replacements: [] })),
  );
  if (!kept.ok) return kept;
  const markdown = kept.value.replacements.reduceRight(
    (text, { start, end, text: replacement }) => text.slice(0, start) + replacement + text.slice(end),
    input.markdown,
  );
  return ok({ markdown, files: kept.value.files, count: kept.value.replacements.length });
};
