import { toDraftMime, type Draft } from "#mail/message.ts";

// A MIME message's tree of parts, by content type, enough to check how a draft is put together.

export type MimePart = {
  readonly type: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly parts: readonly MimePart[];
};

const unfold = (text: string): string => text.replaceAll(/\r?\n[\t ]+/gu, " ");

const headersOf = (text: string): Readonly<Record<string, string>> =>
  Object.fromEntries(
    unfold(text)
      .split(/\r?\n/u)
      .filter((line) => line.includes(":"))
      .map((line) => [line.slice(0, line.indexOf(":")).trim().toLowerCase(), line.slice(line.indexOf(":") + 1).trim()]),
  );

const boundaryOf = (contentType: string): string | undefined =>
  /boundary="?(?<boundary>[^";]+)"?/iu.exec(contentType)?.groups?.boundary;

export const mimeTree = (raw: Buffer | string): MimePart => {
  const text = raw.toString();
  const split = /\r?\n\r?\n/u.exec(text);
  const head = split ? text.slice(0, split.index) : text;
  const body = split ? text.slice(split.index + split[0].length) : "";
  const headers = headersOf(head);
  const contentType = headers["content-type"] ?? "text/plain";
  const type = (contentType.split(";", 1)[0] ?? "").trim().toLowerCase();
  const boundary = boundaryOf(contentType);
  const parts =
    boundary === undefined
      ? []
      : body
          .split(`--${boundary}`)
          .slice(1)
          .filter((piece) => !piece.startsWith("--"))
          .map((piece) => mimeTree(piece.replace(/^\r?\n/u, "")));
  return { type, headers, body, parts };
};

// The tree as nested content types, such as ["multipart/alternative", ["text/plain", "text/html"]].
export type Shape = string | readonly [string, readonly Shape[]];

export const shapeOf = (part: MimePart): Shape =>
  part.parts.length === 0 ? part.type : [part.type, part.parts.map((child) => shapeOf(child))];

// How a draft's MIME is put together, as it goes into Drafts.
export const draftShape = async (draft: Draft): Promise<Shape> => {
  const mime = await toDraftMime(draft, "draft-shape@icloud.com", new Date());
  return shapeOf(mimeTree(mime));
};
