import { isTag, isText, type ChildNode, type Element } from "domhandler";
import { parseDocument } from "htmlparser2";

// Mail HTML read into nodes, written back out with only what's safe in a mail, and read as plain text.

export type Nodes = readonly ChildNode[];

export type SourceChange = (source: string) => string | undefined;

const voidElements: ReadonlySet<string> = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "source",
  "track",
  "wbr",
]);

// Elements that never belong in a mail Kumo writes: they run code, pull in other pages or carry a form.
const droppedElements: ReadonlySet<string> = new Set([
  "script",
  "iframe",
  "object",
  "embed",
  "form",
  "input",
  "button",
  "textarea",
  "select",
  "link",
  "meta",
  "base",
  "head",
  "title",
]);

const blockElements: ReadonlySet<string> = new Set([
  "address",
  "blockquote",
  "br",
  "div",
  "dd",
  "dl",
  "dt",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "li",
  "ol",
  "p",
  "pre",
  "section",
  "table",
  "tbody",
  "td",
  "th",
  "thead",
  "tr",
  "ul",
]);

const isSafeLink = (value: string): boolean => !/^\s*(?:javascript|vbscript|data):/iu.test(value);

export const escapeText = (text: string): string =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

const escapeAttribute = (value: string): string => value.replaceAll("&", "&amp;").replaceAll('"', "&quot;");

export const parseHtml = (html: string): Nodes => parseDocument(html).children;

export const childrenOf = (node: ChildNode): Nodes => (isTag(node) ? node.children : []);

const attributesOf = (element: Element, changeSource: SourceChange): string | undefined => {
  const entries = Object.entries(element.attribs).flatMap(([name, value]): readonly (readonly [string, string])[] => {
    const lower = name.toLowerCase();
    const isUnsafeLink = (lower === "href" || lower === "src") && !isSafeLink(value);
    if (isUnsafeLink || lower.startsWith("on")) return [];
    if (lower === "src" && element.name === "img") {
      const changed = changeSource(value);
      return changed === undefined ? [] : [[name, changed]];
    }
    return [[name, value]];
  });
  const hasNoSource = element.name === "img" && entries.every(([name]) => name.toLowerCase() !== "src");
  return hasNoSource ? undefined : entries.map(([name, value]) => ` ${name}="${escapeAttribute(value)}"`).join("");
};

// The nodes as HTML, without scripts, frames, forms or event handlers. Each image's source goes through
// changeSource, which can point it elsewhere, such as at an inline part, or drop the image.
export const writeHtml = (nodes: Nodes, changeSource: SourceChange = (source) => source): string =>
  nodes
    .map((node) => {
      if (isText(node)) return escapeText(node.data);
      if (!isTag(node) || droppedElements.has(node.name) || node.name === "style") return "";
      const attributes = attributesOf(node, changeSource);
      if (attributes === undefined) return "";
      const open = `<${node.name}${attributes}>`;
      return voidElements.has(node.name) ? open : `${open}${writeHtml(node.children, changeSource)}</${node.name}>`;
    })
    .join("");

// Each element in the nodes and below them, in document order, skipping what skip says to leave out.
export const elementsOf = (nodes: Nodes, skip: (element: Element) => boolean = () => false): readonly Element[] =>
  nodes.flatMap((node) =>
    isTag(node) && !skip(node) ? [node, ...elementsOf(node.children, skip)] : ([] as readonly Element[]),
  );

// What the nodes say, with a space wherever a line or a block breaks, so "<div>A</div><div>B</div>" reads "A B".
export const spokenText = (nodes: Nodes): string =>
  nodes
    .map((node) => {
      if (isText(node)) return node.data;
      if (!isTag(node) || droppedElements.has(node.name) || node.name === "style") return "";
      const inner = spokenText(node.children);
      return blockElements.has(node.name) ? ` ${inner} ` : inner;
    })
    .join("");

export const squashed = (text: string): string => text.replaceAll(/\s+/gu, " ").trim();

// Plain text for a mail's text part: paragraphs a blank line apart, lists marked, links written out.

const inlineText = (nodes: Nodes): string =>
  nodes
    .map((node) => {
      if (isText(node)) return node.data;
      if (!isTag(node)) return "";
      switch (node.name) {
        case "br": {
          return "\n";
        }
        case "img": {
          const alt = (node.attribs.alt ?? "").trim();
          return alt === "" ? "[image]" : `[image: ${alt}]`;
        }
        case "a": {
          const words = inlineText(node.children);
          const href = (node.attribs.href ?? "").trim();
          const bare = href.replace(/^mailto:/iu, "");
          return href === "" || bare === words.trim() ? words : `${words} (${href})`;
        }
        default: {
          return inlineText(node.children);
        }
      }
    })
    .join("");

const indented = (text: string, by: number): string =>
  text
    .split("\n")
    .map((line, index) => (index === 0 || line === "" ? line : `${" ".repeat(by)}${line}`))
    .join("\n");

const listText = (list: Element): string =>
  list.children
    .filter((node): node is Element => isTag(node) && node.name === "li")
    .map((item, index) => {
      const start = Number(list.attribs.start ?? "1");
      const marker = list.name === "ol" ? `${String((Number.isFinite(start) ? start : 1) + index)}. ` : "- ";
      return `${marker}${indented(itemText(item), marker.length)}`;
    })
    .join("\n");

// A list item's words, then any list inside it on the lines below.
const itemText = (item: Element): string => blockText(item.children, "\n");

const isBlock = (node: ChildNode): boolean => isTag(node) && blockElements.has(node.name) && node.name !== "br";

const lineContainers: ReadonlySet<string> = new Set(["div", "section", "body", "html", "tr", "td", "th"]);

const blockOf = (node: Element): string => {
  switch (node.name) {
    case "ul":
    case "ol": {
      return listText(node);
    }
    case "blockquote": {
      return blockText(node.children)
        .split("\n")
        .map((line) => (line === "" ? ">" : `> ${line}`))
        .join("\n");
    }
    case "pre": {
      return inlineText(node.children).replace(/\n$/u, "");
    }
    case "hr": {
      return "---";
    }
    case "table":
    case "tbody":
    case "thead": {
      return blockText(node.children, "\n");
    }
    default: {
      // A div is a line, as mail apps write them; a paragraph or a heading stands apart.
      return lineContainers.has(node.name) ? blockText(node.children, "\n") : inlineText(node.children).trim();
    }
  }
};

// Runs of words become a paragraph each; blocks, such as lists, stand on their own, `between` apart.
const blockText = (nodes: Nodes, between = "\n\n"): string => {
  const kept = nodes.filter((node) => !isTag(node) || (!droppedElements.has(node.name) && node.name !== "style"));
  const pieces = kept.reduce<readonly (Element | readonly ChildNode[])[]>((all, node) => {
    if (isBlock(node)) return [...all, node as Element];
    const last = all.at(-1);
    return Array.isArray(last) ? [...all.slice(0, -1), [...(last as readonly ChildNode[]), node]] : [...all, [node]];
  }, []);
  return pieces
    .map((piece) =>
      Array.isArray(piece) ? inlineText(piece as readonly ChildNode[]).trim() : blockOf(piece as Element),
    )
    .filter((text) => text !== "")
    .join(between);
};

export const plainText = (nodes: Nodes): string => blockText(nodes).trim();
