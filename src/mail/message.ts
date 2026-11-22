import { simpleParser, type AddressObject, type EmailAddress, type HeaderLines, type ParsedMail } from "mailparser";
import MailComposer from "nodemailer/lib/mail-composer";
import type { InlinePart, Part } from "#mail/compose.ts";
import { parseHtml, plainText } from "#mail/html.ts";

export type Address = { readonly address: string; readonly name?: string };

export type Unsubscribe = { readonly post?: string; readonly url?: string; readonly mailto?: string };

// A file a mail carries, as listed when it's read whole: its id, the MIME part number such as `2` or `1.3`, which
// stays the same each time the mail is read; its name, when it has one; its type and size; and whether it's shown in
// the mail's words, such as a logo, rather than attached. A calendar invitation says what it asks, such as REQUEST.
export type MailAttachment = {
  readonly id: string;
  readonly filename?: string;
  readonly contentType: string;
  readonly size: number;
  readonly inline: boolean;
  readonly method?: string;
};

// Where a mail's words came from, when it was read whole: its plain text, its HTML when it has no plain text, or
// nowhere, as it has none; and why they couldn't be read, when that's so.
export type Body = { readonly from: "text" | "html" | "none"; readonly problem?: string };

export type Mail = {
  readonly account: string;
  readonly folder: string;
  readonly uid: number;
  readonly messageId: string;
  readonly inReplyTo?: string;
  readonly references: readonly string[];
  readonly from: Address;
  // Where answers go when it isn't the sender, such as a recruiter behind a hiring system's no-reply address.
  readonly replyTo?: readonly Address[];
  readonly to: readonly Address[];
  readonly cc: readonly Address[];
  readonly subject: string;
  readonly date: string;
  // Its own words, without the history it quotes.
  readonly text: string;
  // The whole text, history and all, when the history was cut from text: what a reply quotes.
  readonly fullText?: string;
  readonly unsubscribe?: Unsubscribe;
  readonly flags: readonly string[];
  // Read whole only: where its words came from, and the files it carries.
  readonly body?: Body;
  readonly attachments?: readonly MailAttachment[];
};

export type Draft = {
  readonly from: Address;
  readonly to: readonly Address[];
  readonly cc?: readonly Address[];
  readonly subject: string;
  // The plain text part.
  readonly body: string;
  // The HTML part, with any pictures it shows inline as parts by Content-ID, and files attached.
  readonly html?: string;
  readonly inline?: readonly InlinePart[];
  readonly attachments?: readonly Part[];
  readonly inReplyTo?: string;
  readonly references?: readonly string[];
  readonly replaces?: string;
};

// A mail they sent, whole, for learning their signature: its own words, its HTML, and the pictures it carried
// inline by Content-ID, such as a logo.
export type SentBody = {
  readonly text: string;
  readonly html?: string;
  readonly images: readonly InlinePart[];
};

export type MailMeta = {
  readonly account: string;
  readonly folder: string;
  readonly uid: number;
  readonly flags: readonly string[];
  readonly receivedAt?: string;
  // Only its headers were fetched, as for a search, so it has no words or files to tell of.
  readonly isHeaders?: boolean;
};

export type RawHeaders = Readonly<Record<string, string | undefined>>;

const angleIds = /<([^<>\s]+)>/g;

const oneClick = /^\s*List-Unsubscribe\s*=\s*One-Click\s*$/i;

export const toMessageIds = (value: string | readonly string[] | undefined): readonly string[] => {
  const text = typeof value === "string" ? value : (value ?? []).join(" ");
  const bracketed = text
    .matchAll(angleIds)
    .map(([, id = ""]) => id)
    .toArray();
  const ids = bracketed.length > 0 ? bracketed : text.split(/[\s,]+/);
  return [...new Set(ids.map((id) => id.trim()).filter((id) => id !== ""))];
};

const syntheticMessageId = (meta: Pick<MailMeta, "account" | "folder" | "uid">): string =>
  `${String(meta.uid)}.${encodeURIComponent(meta.folder)}@${meta.account}.invalid`;

export const fromSyntheticMessageId = (
  messageId: string,
): { readonly folder: string; readonly uid: number } | undefined => {
  const match = /^(\d+)\.([^@]+)@[a-z]+\.invalid$/.exec(messageId);
  return match?.[1] && match[2] ? { uid: Number(match[1]), folder: decodeURIComponent(match[2]) } : undefined;
};

// An address as compared, from "Name <address>" or the address alone, whatever its case.
export const addressKey = (text: string): string =>
  (/<(?<address>[^<>]+)>/u.exec(text)?.groups?.address ?? text).trim().toLowerCase();

export const isSameAddress = (left: string, right: string): boolean => addressKey(left) === addressKey(right);

// The addresses in these From lines, each once, the most used first, with the name most often written beside it.
export const rankSenders = (written: readonly Address[]): readonly Address[] =>
  [...Map.groupBy(written, ({ address }) => addressKey(address))]
    .filter(([address]) => address.includes("@"))
    .toSorted(([, left], [, right]) => right.length - left.length)
    .map(([address, uses]) => {
      const names = [
        ...Map.groupBy(
          uses.flatMap(({ name }) => (name?.trim() ? name.trim() : [])),
          (name) => name,
        ),
      ];
      const [name] = names.toSorted(([, left], [, right]) => right.length - left.length).map(([written]) => written);
      return name === undefined ? { address } : { address, name };
    });

const toAddress = ({ address = "", name }: EmailAddress): Address => ({
  address,
  ...(name !== "" && { name }),
});

const flattenAddresses = (entries: readonly EmailAddress[]): readonly EmailAddress[] =>
  entries.flatMap((entry) => (entry.group ? flattenAddresses(entry.group) : [entry]));

const toAddresses = (header: AddressObject | readonly AddressObject[] | undefined): readonly Address[] =>
  (Array.isArray(header) ? header : header === undefined ? [] : [header])
    .flatMap(({ value }: AddressObject) => flattenAddresses(value))
    .filter(({ address }) => address !== undefined && address !== "")
    .map(toAddress);

const unfoldHeader = (lines: HeaderLines, name: string): string | undefined => {
  const line = lines.find(({ key }) => key === name)?.line;
  return line
    ?.slice(line.indexOf(":") + 1)
    .replaceAll(/\r?\n[\t ]+/g, " ")
    .trim();
};

export const toUnsubscribe = (headers: RawHeaders): Unsubscribe | undefined => {
  const list = headers["list-unsubscribe"];
  if (list === undefined || list.trim() === "") return undefined;
  const bracketed = list
    .matchAll(/<([^<>]*)>/g)
    .map(([, uri = ""]) => uri.replaceAll(/\s+/g, ""))
    .toArray();
  const uris = bracketed.length > 0 ? bracketed : list.split(",").map((uri) => uri.trim());
  const https = uris.find((uri) => /^https:\/\//i.test(uri));
  const url = https ?? uris.find((uri) => /^http:\/\//i.test(uri));
  const mailto = uris.find((uri) => /^mailto:/i.test(uri));
  const post = https !== undefined && oneClick.test(headers["list-unsubscribe-post"] ?? "") ? https : undefined;
  return url === undefined && mailto === undefined
    ? undefined
    : {
        ...(post !== undefined && { post }),
        ...(url !== undefined && { url }),
        ...(mailto !== undefined && { mailto }),
      };
};

const attributionPatterns: readonly RegExp[] = [
  /^On\b.+\bwrote:$/i,
  /^Le\b.+\ba écrit\s?:$/i,
  /^Am\b.+\bschrieb\b.*:$/i,
  /^El\b.+\bescribió:$/i,
  /^-{2,}\s*Original Message\s*-{2,}$/i,
];

const forwardedPattern = /forwarded message|begin forwarded message/i;

const isAttribution = (lines: readonly string[], index: number): boolean => {
  const line = (lines[index] ?? "").trim();
  const joined = `${line} ${(lines[index + 1] ?? "").trim()}`;
  return (
    attributionPatterns.some((pattern) => pattern.test(line)) || (/^On\b/i.test(line) && /\bwrote:$/i.test(joined))
  );
};

const isOutlookHeader = (lines: readonly string[], index: number): boolean => {
  if (!/^From:\s/.test((lines[index] ?? "").trim())) return false;
  const following = lines.slice(index + 1, index + 5).map((line) => line.trim());
  const preceding = lines.slice(Math.max(0, index - 2), index).join(" ");
  return (
    following.some((line) => line.startsWith("Sent: ")) &&
    following.some((line) => line.startsWith("Subject: ")) &&
    !forwardedPattern.test(preceding)
  );
};

const isSeparator = (line = ""): boolean => /^_{10,}$/.test(line.trim());

const isQuotedOrBlank = (line: string): boolean => line.trim() === "" || line.trimStart().startsWith(">");

const dropTrailing = (lines: readonly string[]): readonly string[] => {
  const last = lines.findLastIndex((line) => !isQuotedOrBlank(line));
  return lines.slice(0, last + 1);
};

export const trimQuoted = (text: string): string => {
  const lines = text.replaceAll("\r\n", "\n").split("\n");
  const cut = lines.findIndex((_, index) => isAttribution(lines, index) || isOutlookHeader(lines, index));
  const start = cut > 0 && isSeparator(lines[cut - 1]) ? cut - 1 : cut;
  const kept = dropTrailing(start === -1 ? lines : lines.slice(0, start))
    .join("\n")
    .trim();
  return kept === "" ? text.trim() : kept;
};

const validDate = (date: Date | undefined): string | undefined =>
  date === undefined || Number.isNaN(date.getTime()) ? undefined : date.toISOString();

// A mail's words: its plain text, or when that's missing or blank, as in rich mail sent as HTML alone inside
// multipart/related, or with an empty plain-text part beside the HTML, the HTML's own words.
const wordsOf = (parsed: ParsedMail): { readonly words: string; readonly body: Body } => {
  const text = parsed.text ?? "";
  if (text.trim() !== "") return { words: text, body: { from: "text" } };
  const html = typeof parsed.html === "string" ? parsed.html : "";
  const fromHtml = html.trim() === "" ? "" : plainText(parseHtml(html));
  if (fromHtml !== "") return { words: fromHtml, body: { from: "html" } };
  const failure = parsed.textConversionError;
  return failure === undefined
    ? { words: "", body: { from: "none" } }
    : { words: "", body: { from: "none", problem: `Its HTML couldn't be read as words: ${failure.message}` } };
};

const toAttachment = (attachment: ParsedMail["attachments"][number], index: number): MailAttachment => {
  const header = attachment.headers.get("content-type") as
    { readonly params?: Readonly<Record<string, string>> } | undefined;
  const calendarMethod = header?.params?.method;
  return {
    id: attachment.partId ?? String(index + 1),
    ...(attachment.filename !== undefined && attachment.filename !== "" && { filename: attachment.filename }),
    contentType: attachment.contentType.toLowerCase(),
    size: attachment.size,
    inline: attachment.related === true || attachment.contentDisposition === "inline",
    ...(calendarMethod !== undefined && { method: calendarMethod.toUpperCase() }),
  };
};

export const toMail = (parsed: ParsedMail, meta: MailMeta): Mail => {
  const [messageId] = toMessageIds(parsed.messageId);
  const [inReplyTo] = toMessageIds(parsed.inReplyTo);
  const [from] = toAddresses(parsed.from);
  const replyTo = toAddresses(parsed.replyTo);
  const { words, body } = wordsOf(parsed);
  const fullText = words.replaceAll("\r\n", "\n").trim();
  const text = trimQuoted(words);
  const attachments = parsed.attachments.map((attachment, index) => toAttachment(attachment, index));
  const unsubscribe = toUnsubscribe({
    "list-unsubscribe": unfoldHeader(parsed.headerLines, "list-unsubscribe"),
    "list-unsubscribe-post": unfoldHeader(parsed.headerLines, "list-unsubscribe-post"),
  });
  return {
    account: meta.account,
    folder: meta.folder,
    uid: meta.uid,
    messageId: messageId ?? syntheticMessageId(meta),
    ...(inReplyTo !== undefined && { inReplyTo }),
    references: toMessageIds(parsed.references),
    from: from ?? { address: "" },
    ...(replyTo.length > 0 && { replyTo }),
    to: toAddresses(parsed.to),
    cc: toAddresses(parsed.cc),
    subject: parsed.subject ?? "",
    date: validDate(parsed.date) ?? meta.receivedAt ?? new Date(0).toISOString(),
    text,
    ...(fullText !== text && { fullText }),
    ...(unsubscribe !== undefined && { unsubscribe }),
    flags: meta.flags,
    ...(meta.isHeaders !== true && { body }),
    ...(meta.isHeaders !== true && attachments.length > 0 && { attachments }),
  };
};

const parserOptions = { skipTextToHtml: true, skipTextLinks: true, skipImageLinks: true, keepCidLinks: true };

const describeError = (error: unknown): string => (error instanceof Error ? error.message : String(error));

// The headers alone: everything before the first blank line.
const headersOnly = (source: Buffer | string): string => {
  const text = source.toString("utf8");
  const end = /\r?\n\r?\n/u.exec(text);
  return `${end ? text.slice(0, end.index) : text}\r\n\r\n`;
};

// A mail whose contents can't be parsed is still read by its headers, and says its words couldn't be read, so a
// parsing failure never passes for an empty mail.
export const parseMail = async (source: Buffer | string, meta: MailMeta): Promise<Mail> => {
  try {
    return toMail(await simpleParser(source, parserOptions), meta);
  } catch (error) {
    const mail = toMail(await simpleParser(headersOnly(source), parserOptions), meta);
    const problem = `Its contents couldn't be parsed: ${describeError(error)}`;
    return meta.isHeaders === true ? mail : { ...mail, body: { from: "none", problem } };
  }
};

// One file a mail carries, by the id its listing gave, with its bytes.
export type AttachmentContent = MailAttachment & { readonly content: Buffer };

export const attachmentIn = async (source: Buffer | string, id: string): Promise<AttachmentContent | undefined> => {
  const parsed = await simpleParser(source, parserOptions);
  const index = parsed.attachments.findIndex((attachment, at) => (attachment.partId ?? String(at + 1)) === id);
  const found = parsed.attachments[index];
  return found === undefined ? undefined : { ...toAttachment(found, index), content: found.content };
};

export const parseSentBody = async (source: Buffer | string): Promise<SentBody> => {
  const parsed = await simpleParser(source, { skipImageLinks: true, keepCidLinks: true });
  const html = typeof parsed.html === "string" && parsed.html.trim() !== "" ? parsed.html : undefined;
  // A mail in HTML alone, inside multipart/related, comes with no text, so its text is read from the HTML.
  const text = parsed.text ?? (html === undefined ? "" : plainText(parseHtml(html)));
  return {
    text,
    ...(html !== undefined && { html }),
    images: parsed.attachments.flatMap(({ cid, filename = "image", contentType, content }) =>
      cid === undefined || cid === "" ? [] : { cid, filename, contentType, content },
    ),
  };
};

const toMimeAddress = ({ address, name = "" }: Address): { readonly address: string; readonly name: string } => ({
  address,
  name,
});

const bracket = (id: string): string => `<${id}>`;

const replyReferences = (draft: Pick<Draft, "inReplyTo" | "references">): readonly string[] => [
  ...new Set([...(draft.references ?? []), ...(draft.inReplyTo === undefined ? [] : [draft.inReplyTo])]),
];

const isPlainAscii = (text: string): boolean => /^[\u{20}-\u{7E}]*$/u.test(text);

// A file name fit for a quoted parameter: no quotes, backslashes or control characters. It's the name the file
// reads back with.
export const attachedName = (name: string): string =>
  name
    .split(/(?=[\s\S])/u)
    .filter((character) => character >= " " && character !== "\u{7F}" && character !== '"' && character !== "\\")
    .join("")
    .trim() || "attachment";

// A name as RFC 2231 writes it beyond ASCII: UTF-8, percent-encoded, with the characters it reserves encoded too.
const percentName = (name: string): string =>
  encodeURIComponent(name).replaceAll(
    /['()*]/gu,
    (character) => `%${(character.codePointAt(0) ?? 0).toString(16).toUpperCase()}`,
  );

// A file attached to a draft, written out whole, the way mail apps write theirs, so every app loads it: its name
// quoted in both Content-Type and Content-Disposition, a name beyond ASCII as an encoded word in the one and RFC
// 2231's single `filename*` in the other (never split into numbered pieces), its size, and its bytes in base64 lines
// of 76.
export const attachedPart = ({ filename, contentType, content }: Part): string => {
  const name = attachedName(filename);
  const [given = ""] = contentType.split(";", 1);
  const type = given.trim() === "" ? "application/octet-stream" : given.trim();
  const isAscii = isPlainAscii(name);
  const encodedName = isAscii ? name : `=?UTF-8?B?${Buffer.from(name).toString("base64")}?=`;
  const disposition = isAscii ? `filename="${name}"` : `filename*=UTF-8''${percentName(name)}`;
  const lines = content.toString("base64").match(/.{1,76}/gu) ?? [];
  return [
    `Content-Type: ${type};\r\n name="${encodedName}"`,
    `Content-Disposition: attachment;\r\n ${disposition};\r\n size=${String(content.length)}`,
    "Content-Transfer-Encoding: base64",
    "",
    ...lines,
    "",
  ].join("\r\n");
};

// Plain text alone, or multipart/alternative with the HTML; pictures shown inline sit with the HTML in
// multipart/related, by Content-ID, and attached files make it multipart/mixed.
export const toDraftMime = (draft: Draft, messageId: string, date: Date): Promise<Buffer> => {
  const references = replyReferences(draft);
  const html = draft.html ?? "";
  const inline = html === "" ? [] : (draft.inline ?? []);
  const attachments = [
    ...inline.map(({ filename, contentType, content, cid }) => ({
      filename,
      contentType,
      content,
      cid,
      contentDisposition: "inline" as const,
    })),
    ...(draft.attachments ?? []).map((part) => ({ raw: attachedPart(part) })),
  ];
  return new MailComposer({
    from: toMimeAddress(draft.from),
    to: draft.to.map(toMimeAddress),
    ...(draft.cc !== undefined && draft.cc.length > 0 && { cc: draft.cc.map(toMimeAddress) }),
    subject: draft.subject,
    text: draft.body,
    ...(html !== "" && { html }),
    ...(attachments.length > 0 && { attachments }),
    messageId: bracket(messageId),
    date,
    ...(draft.inReplyTo !== undefined && { inReplyTo: bracket(draft.inReplyTo) }),
    ...(references.length > 0 && { references: references.map(bracket) }),
    newline: "win",
    disableFileAccess: true,
    disableUrlAccess: true,
  })
    .compile()
    .build();
};

export const threadIds = (mail: Pick<Mail, "messageId" | "inReplyTo" | "references">): ReadonlySet<string> =>
  new Set([mail.messageId, ...mail.references, ...(mail.inReplyTo === undefined ? [] : [mail.inReplyTo])]);

export const threadKey = (mail: Pick<Mail, "messageId" | "inReplyTo" | "references">): string =>
  mail.references[0] ?? mail.inReplyTo ?? mail.messageId;

type Group = { readonly ids: ReadonlySet<string>; readonly mails: readonly Mail[] };

const shares = (left: ReadonlySet<string>, right: ReadonlySet<string>): boolean =>
  left.values().some((id) => right.has(id));

const byDate = (left: Mail, right: Mail): number => left.date.localeCompare(right.date);

// The first of each Message-ID.
export const uniqueByMessageId = (mails: readonly Mail[]): readonly Mail[] => {
  const firsts = new Map(mails.toReversed().map((mail) => [mail.messageId, mail]));
  return mails.filter((mail) => firsts.get(mail.messageId) === mail);
};

export const groupThreads = (mails: readonly Mail[]): readonly (readonly Mail[])[] =>
  uniqueByMessageId(mails)
    .reduce<readonly Group[]>((groups, mail) => {
      const ids = threadIds(mail);
      const joined = groups.filter((group) => shares(group.ids, ids));
      const merged: Group = {
        ids: new Set([...ids, ...joined.flatMap((group) => [...group.ids])]),
        mails: [...joined.flatMap((group) => group.mails), mail],
      };
      return [...groups.filter((group) => !joined.includes(group)), merged];
    }, [])
    .map((group) => group.mails.toSorted(byDate))
    .toSorted((left, right) => (left[0]?.date ?? "").localeCompare(right[0]?.date ?? ""));

export const threadOf = (messageId: string, mails: readonly Mail[]): readonly Mail[] =>
  groupThreads(mails).find((group) => group.some((mail) => mail.messageId === messageId)) ?? [];
