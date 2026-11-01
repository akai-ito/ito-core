import { isTag, isText, type ChildNode, type Element } from "domhandler";
import type { Signature } from "#mail/compose.ts";
import { childrenOf, elementsOf, parseHtml, spokenText, squashed, writeHtml, type Nodes } from "#mail/html.ts";
import { trimQuoted, type SentBody } from "#mail/message.ts";

// Their signature, learned from mail they sent: the block that ends most of their recent mail, exactly as they send
// it, in HTML when they send HTML. Nothing is made up: with no such block, there's no signature.

// How many recent sent mails the signature is learned from.
export const signatureSample = 15;

const longestSignature = 12;
const longestSignOffLine = 40;
const largestImageBytes = 256 * 1024;

// A line a phone or an app adds, which isn't theirs: true only of the device it was sent from.
const deviceLine = /^(?:sent from (?:my|outlook|mail|yahoo)|get outlook for|sent via|sent with)\b/iu;

const signOff =
  /^(?:cheers|thanks|thank you|many thanks|thx|best|best wishes|all the best|regards|kind regards|warm regards|best regards|warmly|love|lots of love|talk soon|speak soon|see you|sincerely|yours|ta|x+)\b/iu;

const isDelimiter = (line: string): boolean => line.trim() === "--";

const isBlank = (line: string): boolean => line.trim() === "";

const linesOf = (text: string): readonly string[] => {
  const lines = trimQuoted(text)
    .replaceAll("\r\n", "\n")
    .split("\n")
    .map((line) => line.trimEnd());
  const last = lines.findLastIndex((line) => !isBlank(line));
  return lines.slice(0, last + 1);
};

const keyOf = (lines: readonly string[]): string => lines.map((line) => squashed(line)).join("\n");

// The longest run of last lines that at least `need` of the mails end with, and the mails that do.
const commonEnding = (
  mails: readonly (readonly string[])[],
  need: number,
): { readonly lines: readonly string[]; readonly holders: readonly (readonly string[])[] } | undefined => {
  const lengths = Array.from({ length: longestSignature }, (_, index) => longestSignature - index);
  return lengths
    .map((length) => {
      const longer = mails.filter((lines) => lines.length > length);
      const counts = Map.groupBy(longer, (lines) => keyOf(lines.slice(-length)));
      const [key, holders] = [...counts].toSorted(([, left], [, right]) => right.length - left.length).at(0) ?? [];
      return key === undefined || holders === undefined || holders.length < need
        ? undefined
        : { lines: (holders[0] ?? []).slice(-length), holders };
    })
    .find((found) => found !== undefined);
};

const paragraphsOf = (lines: readonly string[]): readonly (readonly string[])[] =>
  lines
    .reduce<readonly (readonly string[])[]>(
      (all, line) => (isBlank(line) ? [...all, []] : [...all.slice(0, -1), [...(all.at(-1) ?? []), line]]),
      [[]],
    )
    .filter((paragraph) => paragraph.length > 0);

const isNameOnly = (line: string): boolean => {
  const words = line.trim().split(/\s+/u);
  return words.length <= 3 && words.every((word) => /^[\p{L}'’.-]+,?$/u.test(word));
};

const isSignOff = (paragraph: readonly string[]): boolean =>
  paragraph.length <= 3 &&
  paragraph.every((line) => line.trim().length <= longestSignOffLine) &&
  (signOff.test(paragraph[0]?.trim() ?? "") || (paragraph.length === 1 && isNameOnly(paragraph[0] ?? "")));

const dropSignOffs = (paragraphs: readonly (readonly string[])[]): readonly (readonly string[])[] => {
  const first = paragraphs.findIndex((paragraph) => !isSignOff(paragraph));
  return first === -1 ? [] : paragraphs.slice(first);
};

const withoutDeviceLines = (lines: readonly string[]): readonly string[] =>
  lines.filter((line) => !deviceLine.test(line.trim()));

// The signature they put after a "-- " line, when most of the mails have the same one.
const delimitedSignature = (mails: readonly (readonly string[])[], need: number): readonly string[] | undefined => {
  const after = mails
    .filter((lines) => lines.some((line) => isDelimiter(line)))
    .map((lines) => withoutDeviceLines(lines.slice(lines.findLastIndex((line) => isDelimiter(line)) + 1)))
    .filter((lines) => lines.some((line) => !isBlank(line)));
  const [, holders = []] =
    [...Map.groupBy(after, (lines) => keyOf(lines))]
      .toSorted(([, left], [, right]) => right.length - left.length)
      .at(0) ?? [];
  const [lines] = holders;
  return lines !== undefined && holders.length >= need ? ["-- ", ...lines] : undefined;
};

// The signature's lines in plain text: after a "-- " line if they use one, otherwise a block that starts after a
// blank line, without the sign-off, which Kumo writes itself.
const textSignature = (mails: readonly (readonly string[])[]): readonly string[] | undefined => {
  const need = Math.max(2, Math.ceil(mails.length / 2));
  const delimited = delimitedSignature(mails, need);
  if (delimited) return delimited;
  const ending = commonEnding(mails, need);
  if (!ending) return undefined;
  const startsClean = ending.holders.every((lines) => {
    const before = lines.at(-ending.lines.length - 1) ?? "";
    return isBlank(before) || isDelimiter(before);
  });
  const blank = ending.lines.findIndex((line) => isBlank(line));
  const block = startsClean ? ending.lines : blank === -1 ? [] : ending.lines.slice(blank + 1);
  const kept = withoutDeviceLines(
    dropSignOffs(paragraphsOf(block))
      .flatMap((paragraph) => ["", ...paragraph])
      .slice(1),
  );
  const [only] = kept;
  if (only === undefined) return undefined;
  return kept.length === 1 && isNameOnly(only) ? undefined : kept;
};

const quoteIds = /^(?:x_)?(?:appendonsend|divrplyfwdmsg|mail-editor-reference-message-container)$/iu;

const quoteClasses = /\b(?:gmail_quote|gmail_attr|moz-cite-prefix|yahoo_quoted)\b/iu;

const isQuote = (element: Element): boolean =>
  element.name === "blockquote" ||
  quoteIds.test(element.attribs.id ?? "") ||
  quoteClasses.test(element.attribs.class ?? "");

const signatureIds = /^(?:x_)?(?:signature|ms-outlook-mobile-signature|applemailsignature)/iu;

const signatureClasses = /\b(?:gmail_signature|moz-signature|signature)\b/iu;

const isMarkedSignature = (element: Element): boolean =>
  signatureIds.test(element.attribs.id ?? "") || signatureClasses.test(element.attribs.class ?? "");

// What nodes say, without a leading "-- ", so a signature reads the same with or without its delimiter.
const said = (nodes: Nodes): string => squashed(spokenText(nodes)).replace(/^--\s*/u, "");

const hasWords = (node: ChildNode): boolean => said([node]) !== "";

// Siblings that together say exactly the signature, such as one div a line.
const siblingRuns = (siblings: Nodes, wanted: string): readonly Nodes[] => {
  const children = siblings.filter((node) => isTag(node) || (isText(node) && node.data.trim() !== ""));
  return children.flatMap((first, start) => {
    if (!hasWords(first)) return [];
    const ends = children.slice(start).map((_, index) => start + index + 1);
    const end = ends.find((stop) => said(children.slice(start, stop)) === wanted);
    return end === undefined ? [] : [children.slice(start, end)];
  });
};

// The HTML that says the signature: a block the mail app marks as one, or the last element, or run of
// siblings, outside any quoted mail that says exactly the signature's words.
const htmlSignature = (html: string, text: readonly string[]): Nodes | undefined => {
  const nodes = parseHtml(html);
  const wanted = squashed(text.filter((line) => !isDelimiter(line)).join(" "));
  const elements = elementsOf(nodes, isQuote);
  const marked = elements.findLast((element) => isMarkedSignature(element) && said([element]) === wanted);
  if (marked) return [marked];
  const exact = elements.filter((element) => said([element]) === wanted);
  const outermost = exact.filter((element) => exact.every((other) => other === element || !contains(other, element)));
  const last = outermost.at(-1);
  return last
    ? [last]
    : [nodes, ...elements.map((element) => element.children)]
        .flatMap((siblings) => siblingRuns(siblings, wanted))
        .at(-1);
};

const contains = (outer: Element, inner: Element): boolean =>
  childrenOf(outer).some((child) => child === inner || (isTag(child) && contains(child, inner)));

const imagesOf = (nodes: Nodes): readonly string[] =>
  elementsOf(nodes)
    .filter((element) => element.name === "img")
    .map((element) => element.attribs.src ?? "");

const cidOf = (source: string): string | undefined => /^cid:(?<cid>.+)$/iu.exec(source.trim())?.groups?.cid;

// The signature from their most recent sent mails, newest first, or none when no block ends most of them.
export const learnSignature = (sent: readonly SentBody[]): Signature | undefined => {
  const mails = sent.map((mail) => linesOf(mail.text)).filter((lines) => lines.length > 0);
  if (mails.length < 2) return undefined;
  const lines = textSignature(mails);
  if (!lines) return undefined;
  const text = lines.join("\n");
  const wanted = keyOf(lines.slice(-1));
  const source = sent.find((mail) => mail.html !== undefined && keyOf(linesOf(mail.text).slice(-1)) === wanted);
  const found = source?.html === undefined ? undefined : htmlSignature(source.html, lines);
  if (!source || !found) return { text, images: [] };
  const images = imagesOf(found).flatMap((source_) => {
    const cid = cidOf(source_);
    const image = cid === undefined ? undefined : source.images.find((part) => part.cid === cid);
    return image && image.content.length <= largestImageBytes ? [image] : [];
  });
  const html = writeHtml(found, (source_) => {
    const cid = cidOf(source_);
    if (cid === undefined) return /^https:\/\//iu.test(source_) ? source_ : undefined;
    return images.some((image) => image.cid === cid) ? source_ : undefined;
  });
  const delimiter =
    isDelimiter(lines[0] ?? "") && !squashed(spokenText(found)).startsWith("--") ? "<div>-- </div>" : "";
  return { text, html: `${delimiter}${html}`, images };
};
