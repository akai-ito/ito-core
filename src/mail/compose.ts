import { randomUUID } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { isTag } from "domhandler";
import { micromark } from "micromark";
import { toMediaType } from "#attachments/attachments.ts";
import type { Fetch } from "#capabilities/connect.ts";
import { elementsOf, escapeText, parseHtml, plainText, writeHtml } from "#mail/html.ts";
import { fail, ok, type Result } from "#result.ts";

// A draft as it goes into Drafts: Kumo's light Markdown as HTML and as clean plain text, the pictures it shows
// inline, files attached, their own signature at the end, and below it, in a reply, the mail it answers, quoted.

export type Part = { readonly filename: string; readonly contentType: string; readonly content: Buffer };

export type InlinePart = Part & { readonly cid: string };

export type Signature = { readonly text: string; readonly html?: string; readonly images: readonly InlinePart[] };

// The mail a reply answers, as it's quoted below the reply: a line saying who wrote it and when, such as "On 3 Nov
// 2026, Clara Voss wrote:", and its text.
export type Quote = { readonly attribution: string; readonly text: string };

export type Letter = {
  readonly text: string;
  readonly html: string;
  readonly inline: readonly InlinePart[];
  readonly attachments: readonly Part[];
};

export type PartKind = "image" | "file";

// Finds a picture or a file Kumo named: a workspace path, such as uploads/photo.jpg, or a web address.
export type FindPart = (reference: string, kind: PartKind) => Promise<Result<Part, string>>;

export type LetterInput = {
  readonly markdown: string;
  readonly attach: readonly string[];
  readonly signature?: Signature;
  readonly quote?: Quote;
  readonly find: FindPart;
};

// One picture or file at most, and everything in one mail at most, before encoding makes it a third bigger.
export const largestPartBytes = 10 * 1024 * 1024;
export const largestLetterBytes = 15 * 1024 * 1024;

const fetchMs = 30_000;

const megabytes = (bytes: number): string => `${String(Math.round(bytes / (1024 * 1024)))} MB`;

const mediaTypes: Readonly<Record<string, string>> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".heic": "image/heic",
  ".heif": "image/heif",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".csv": "text/csv",
  ".ics": "text/calendar",
  ".vcf": "text/vcard",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".key": "application/vnd.apple.keynote",
  ".pages": "application/vnd.apple.pages",
  ".numbers": "application/vnd.apple.numbers",
  ".zip": "application/zip",
};

const typeOfName = (name: string): string => mediaTypes[path.extname(name).toLowerCase()] ?? "application/octet-stream";

const isPicture = (contentType: string): boolean => contentType.startsWith("image/");

const nameFromUrl = (url: URL, contentType: string): string =>
  decodeURIComponent(path.posix.basename(url.pathname)) || `image.${contentType.split("/", 2)[1] ?? "jpg"}`;

const describeError = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const isInside = (folder: string, file: string): boolean => {
  const relative = path.relative(folder, file);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
};

const download = async (fetcher: Fetch, url: URL, kind: PartKind): Promise<Result<Part, string>> => {
  try {
    const response = await fetcher(url.href, { signal: AbortSignal.timeout(fetchMs) });
    if (!response.ok) {
      await response.body?.cancel();
      return fail(`${url.href} answered ${String(response.status)}.`);
    }
    const contentType = toMediaType(response.headers.get("content-type") ?? undefined);
    const declared = Number(response.headers.get("content-length") ?? "0");
    if (kind === "image" && !isPicture(contentType)) {
      await response.body?.cancel();
      return fail(`${url.href} is ${contentType}, not a picture. Give the picture's own address.`);
    }
    if (declared > largestPartBytes) {
      await response.body?.cancel();
      return fail(`${url.href} is over ${megabytes(largestPartBytes)}: find a smaller version.`);
    }
    const content = Buffer.from(await response.arrayBuffer());
    return content.length > largestPartBytes
      ? fail(`${url.href} is over ${megabytes(largestPartBytes)}: find a smaller version.`)
      : ok({ filename: nameFromUrl(url, contentType), contentType, content });
  } catch (error) {
    return fail(`${url.href} couldn't be fetched: ${describeError(error)}`);
  }
};

const readLocal = async (workspace: string, reference: string, kind: PartKind): Promise<Result<Part, string>> => {
  const decoded = (() => {
    try {
      return decodeURIComponent(reference);
    } catch {
      return reference;
    }
  })();
  try {
    const folder = await realpath(workspace);
    const file = await realpath(path.resolve(folder, decoded));
    if (!isInside(folder, file)) return fail(`${reference} isn't in your workspace, so it can't go in a mail.`);
    const found = await stat(file);
    if (!found.isFile()) return fail(`${reference} isn't a file.`);
    if (found.size > largestPartBytes) {
      return fail(`${reference} is over ${megabytes(largestPartBytes)}, too big to go in a mail.`);
    }
    const contentType = typeOfName(file);
    return kind === "image" && !isPicture(contentType)
      ? fail(`${reference} isn't a picture.`)
      : ok({ filename: path.basename(file), contentType, content: await readFile(file) });
  } catch {
    return fail(`There's no ${reference} in your workspace.`);
  }
};

// Workspace files and web addresses, each size-limited. Nothing outside the workspace is read.
export const createFindPart =
  ({ workspace, fetch: fetcher }: { readonly workspace: string | undefined; readonly fetch: Fetch }): FindPart =>
  (reference, kind) => {
    const given = reference.trim();
    if (given === "") return Promise.resolve(fail("A picture or a file needs a path or an address."));
    if (/^https?:\/\//iu.test(given) && URL.canParse(given)) return download(fetcher, new URL(given), kind);
    if (/^[a-z][a-z\d+.-]*:/iu.test(given) && !/^[a-z]:[\\/]/iu.test(given)) {
      return Promise.resolve(fail(`${given} isn't a workspace path or an https address.`));
    }
    return workspace === undefined
      ? Promise.resolve(fail(`There's no workspace here, so ${given} can't be found: give an https address.`))
      : readLocal(workspace, given, kind);
  };

const toCid = (): string => `${randomUUID()}@ito.local`;

const sourcesOf = (html: string): readonly string[] => [
  ...new Set(
    elementsOf(parseHtml(html))
      .filter((element) => isTag(element) && element.name === "img")
      .map((element) => element.attribs.src ?? "")
      .filter((source) => source !== ""),
  ),
];

const signatureHtml = (signature: Signature): string =>
  signature.html ??
  `<div>${signature.text
    .split("\n")
    .map((line) => escapeText(line))
    .join("<br>")}</div>`;

const quotedLines = ({ text }: Quote): readonly string[] =>
  text
    .replaceAll("\r\n", "\n")
    .trim()
    .split("\n")
    .map((line) => line.trimEnd());

// The quote as mail apps write it in plain text: the attribution, then each line marked with "> ".
const quotedText = (quote: Quote): string =>
  [quote.attribution, ...quotedLines(quote).map((line) => (line === "" ? ">" : `> ${line}`))].join("\n");

// And in HTML: the attribution, then the text in a blockquote, which every mail app draws as a quote.
const quotedHtml = (quote: Quote): string =>
  `<div>${escapeText(quote.attribution)}</div>\n` +
  '<blockquote type="cite" style="margin: 0 0 0 0.8ex; border-left: 1px solid #ccc; padding-left: 1ex">' +
  `${quotedLines(quote)
    .map((line) => escapeText(line))
    .join("<br>\n")}</blockquote>`;

const wrapped = (body: string): string =>
  `<!DOCTYPE html>\n<html><head><meta charset="utf-8"></head><body>\n${body}\n</body></html>\n`;

// What the Markdown says as plain text, as the draft's text part has it before the signature.
export const plainOf = (markdown: string): string => plainText(parseHtml(micromark(markdown)));

export const withSignature = (text: string, signature: Signature | undefined): string =>
  signature === undefined ? text : `${text}\n\n${signature.text}`;

export const composeLetter = async ({
  markdown,
  attach,
  signature,
  quote,
  find,
}: LetterInput): Promise<Result<Letter, string>> => {
  const html = micromark(markdown);
  const sources = sourcesOf(html);
  const pictures = await Promise.all(sources.map((source) => find(source, "image")));
  const [unfound] = pictures.flatMap((picture) => (picture.ok ? [] : picture.failure));
  if (unfound !== undefined) return fail(unfound);
  const inline = pictures.flatMap((picture) => (picture.ok ? { ...picture.value, cid: toCid() } : []));
  const cidOf = new Map(sources.map((source, index) => [source, inline[index]?.cid]));
  const files = await Promise.all(attach.map((reference) => find(reference, "file")));
  const [missing] = files.flatMap((file) => (file.ok ? [] : file.failure));
  if (missing !== undefined) return fail(missing);
  const attachments = files.flatMap((file) => (file.ok ? file.value : []));
  const parts = [...inline, ...attachments, ...(signature?.images ?? [])];
  const total = parts.reduce((sum, part) => sum + part.content.length, 0);
  if (total > largestLetterBytes) {
    return fail(
      `That's ${megabytes(total)} of pictures and files, over the ${megabytes(largestLetterBytes)} a mail can carry. ` +
        "Leave some out or use smaller ones.",
    );
  }
  const nodes = parseHtml(html);
  const body = writeHtml(nodes, (source) => {
    const cid = cidOf.get(source);
    return cid === undefined ? undefined : `cid:${cid}`;
  }).replaceAll("<img ", '<img style="max-width: 100%" ');
  const text = withSignature(plainText(nodes), signature);
  const signed = signature === undefined ? body : `${body}\n<br>\n${signatureHtml(signature)}`;
  return ok({
    text: quote === undefined ? text : `${text}\n\n${quotedText(quote)}`,
    html: wrapped(quote === undefined ? signed : `${signed}\n<br>\n${quotedHtml(quote)}`),
    inline: [...inline, ...(signature?.images ?? [])],
    attachments,
  });
};
