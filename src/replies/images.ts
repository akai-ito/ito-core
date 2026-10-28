import path from "node:path";
import { maxAttachmentBytes, toMediaType, type Attachments } from "#attachments/attachments.ts";
import { isImage } from "#attachments/media.ts";
import { fail, ok, type Result } from "#result.ts";
import type { Tool, ToolResult } from "#tools/mcp.ts";

export const imageToolName = "keep_image";

export type FetchImage = (url: string, signal: AbortSignal) => Promise<Response>;

export type ImageToolOptions = {
  readonly attachments: Attachments;
  readonly keep: (id: string) => void;
  readonly newId: () => string;
  readonly fetchImage: FetchImage;
};

const fetchMs = 30_000;

const failed = (text: string): ToolResult => ({ text, isError: true });

const toUrl = (input: unknown): URL | undefined => {
  const given: unknown = input && typeof input === "object" ? Reflect.get(input, "url") : undefined;
  if (typeof given !== "string" || !URL.canParse(given.trim())) return undefined;
  const url = new URL(given.trim());
  return url.protocol === "https:" || url.protocol === "http:" ? url : undefined;
};

const nameOf = (url: URL, mediaType: string): string =>
  path.posix.basename(url.pathname) || `picture.${mediaType.split("/", 2)[1] ?? "jpg"}`;

const download = async (url: URL, fetchImage: FetchImage): Promise<Result<Response, string>> => {
  try {
    const response = await fetchImage(url.href, AbortSignal.timeout(fetchMs));
    return response.ok ? ok(response) : fail(`It answered ${String(response.status)}.`);
  } catch (error) {
    return fail(`It couldn't be fetched: ${error instanceof Error ? error.message : String(error)}`);
  }
};

export const createImageTool = ({ attachments, keep, newId, fetchImage }: ImageToolOptions): Tool => ({
  name: imageToolName,
  title: "Keep a picture from the web",
  description:
    "Keep a picture you found on the web, so the person's phone can show it in an ari:images block without " +
    "going to the site. Give the image's own address, not the page it's on. Pictures are found and credited, " +
    "never generated.",
  inputSchema: {
    type: "object",
    properties: { url: { type: "string", description: "The image's own address, starting https://." } },
    required: ["url"],
    additionalProperties: false,
  },
  call: async (input) => {
    const url = toUrl(input);
    if (!url) return failed("Give the image's own address, starting https://.");
    const downloaded = await download(url, fetchImage);
    if (!downloaded.ok) return failed(downloaded.failure);
    const mediaType = toMediaType(downloaded.value.headers.get("content-type") ?? undefined);
    if (!isImage(mediaType)) return failed(`That's ${mediaType}, not a JPEG, PNG, GIF or WebP picture.`);
    const bytes = Buffer.from(await downloaded.value.arrayBuffer());
    if (bytes.length > maxAttachmentBytes) return failed("It's over 20 MB: find a smaller version of it.");
    const id = newId();
    const saved = attachments.save(id, nameOf(url, mediaType), mediaType, bytes);
    if (!saved.ok) return failed("It couldn't be kept.");
    keep(id);
    return {
      text:
        `Kept it as ${id}. Show it with "attachment": "${id}" in an ari:images block, with its alt text, ` +
        "the page it came from as source_url, and its credit.",
      structured: { attachment: id },
    };
  },
});
