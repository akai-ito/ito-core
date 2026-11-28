import { isTag, isText, type ChildNode, type Element } from "domhandler";
import { parseDocument } from "htmlparser2";
import type { Fetch } from "#capabilities/connect.ts";
import type { SharedLink } from "#protocol/types.ts";

// A link they shared, with what its page says of itself, read once on the server so the app can show it as a card
// without going to the site, and Kumo knows what it is before it opens it. A page that can't be read leaves the link
// with its host.

export type Page = Omit<SharedLink, "url">;

const fetchMs = 8000;
const mostBytes = 1024 * 1024;
const mostTitle = 200;
const mostDescription = 400;
const mostSite = 80;
const userAgent = "Mozilla/5.0 (compatible; link preview)";

const elementsIn = (nodes: readonly ChildNode[]): readonly Element[] =>
  nodes.flatMap((node) => (isTag(node) ? [node, ...elementsIn(node.children)] : []));

const textIn = (element: Element): string =>
  element.children.map((child) => (isText(child) ? child.data : isTag(child) ? textIn(child) : "")).join("");

const clean = (text: string | undefined, most: number): string | undefined => {
  const plain = text?.replaceAll(/\s+/gu, " ").trim() ?? "";
  if (plain === "") return undefined;
  return plain.length > most ? `${plain.slice(0, most - 1).trimEnd()}…` : plain;
};

export const hostOf = (url: string): string | undefined =>
  URL.canParse(url) ? new URL(url).hostname.replace(/^www\./u, "") || undefined : undefined;

// What a page says of itself to link previews: Open Graph first, then the usual tags.
export const readPage = (html: string): Page => {
  const elements = elementsIn(parseDocument(html).children);
  const meta = (keys: readonly string[], most: number): string | undefined =>
    keys
      .map((key) =>
        elements.find(
          (element) =>
            element.name === "meta" &&
            (element.attribs.property ?? element.attribs.name ?? "").toLowerCase() === key &&
            clean(element.attribs.content, most) !== undefined,
        ),
      )
      .map((element) => clean(element?.attribs.content, most))
      .find((value) => value !== undefined);
  const titled = elements.find((element) => element.name === "title");
  const title = meta(["og:title", "twitter:title"], mostTitle) ?? clean(titled && textIn(titled), mostTitle);
  const description = meta(["og:description", "twitter:description", "description"], mostDescription);
  const site = meta(["og:site_name", "application-name"], mostSite);
  return {
    ...(title !== undefined && { title }),
    ...(description !== undefined && { description }),
    ...(site !== undefined && { site }),
  };
};

const readUpTo = async (response: Response, most: number): Promise<string> => {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const read = async (chunks: readonly Uint8Array[], size: number): Promise<readonly Uint8Array[]> => {
    if (size >= most) {
      await reader.cancel();
      return chunks;
    }
    const next = await reader.read();
    return next.done ? chunks : read([...chunks, next.value], size + next.value.byteLength);
  };
  const chunks = await read([], 0);
  return new TextDecoder().decode(Buffer.concat(chunks).subarray(0, most));
};

const fetchPage = async (url: string, fetcher: Fetch): Promise<Page> => {
  try {
    const response = await fetcher(url, {
      signal: AbortSignal.timeout(fetchMs),
      headers: { accept: "text/html,application/xhtml+xml", "user-agent": userAgent },
      redirect: "follow",
    });
    const isHtml = /html/iu.test(response.headers.get("content-type") ?? "");
    if (!isHtml || !response.ok) {
      await response.body?.cancel();
      return {};
    }
    return readPage(await readUpTo(response, mostBytes));
  } catch {
    return {};
  }
};

export const previewLink = async (url: string, fetcher: Fetch): Promise<SharedLink> => {
  const page = /^https?:\/\//iu.test(url) ? await fetchPage(url, fetcher) : {};
  const site = page.site ?? hostOf(url);
  return { url, ...page, ...(site !== undefined && { site }) };
};
