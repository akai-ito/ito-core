import { simpleParser, type AddressObject, type EmailAddress, type HeaderLines, type ParsedMail } from "mailparser";
import MailComposer from "nodemailer/lib/mail-composer";

export type Address = { readonly address: string; readonly name?: string };

export type Unsubscribe = { readonly post?: string; readonly url?: string; readonly mailto?: string };

export type Mail = {
  readonly account: string;
  readonly folder: string;
  readonly uid: number;
  readonly messageId: string;
  readonly inReplyTo?: string;
  readonly references: readonly string[];
  readonly from: Address;
  readonly to: readonly Address[];
  readonly cc: readonly Address[];
  readonly subject: string;
  readonly date: string;
  readonly text: string;
  readonly unsubscribe?: Unsubscribe;
  readonly flags: readonly string[];
};

export type Draft = {
  readonly from: Address;
  readonly to: readonly Address[];
  readonly cc?: readonly Address[];
  readonly subject: string;
  readonly body: string;
  readonly inReplyTo?: string;
  readonly references?: readonly string[];
  readonly replaces?: string;
};

export type MailMeta = {
  readonly account: string;
  readonly folder: string;
  readonly uid: number;
  readonly flags: readonly string[];
  readonly receivedAt?: string;
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

export const toMail = (parsed: ParsedMail, meta: MailMeta): Mail => {
  const [messageId] = toMessageIds(parsed.messageId);
  const [inReplyTo] = toMessageIds(parsed.inReplyTo);
  const [from] = toAddresses(parsed.from);
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
    to: toAddresses(parsed.to),
    cc: toAddresses(parsed.cc),
    subject: parsed.subject ?? "",
    date: validDate(parsed.date) ?? meta.receivedAt ?? new Date(0).toISOString(),
    text: trimQuoted(parsed.text ?? ""),
    ...(unsubscribe !== undefined && { unsubscribe }),
    flags: meta.flags,
  };
};

export const parseMail = async (source: Buffer | string, meta: MailMeta): Promise<Mail> =>
  toMail(
    await simpleParser(source, { skipTextToHtml: true, skipTextLinks: true, skipImageLinks: true, keepCidLinks: true }),
    meta,
  );

const toMimeAddress = ({ address, name = "" }: Address): { readonly address: string; readonly name: string } => ({
  address,
  name,
});

const bracket = (id: string): string => `<${id}>`;

const replyReferences = (draft: Pick<Draft, "inReplyTo" | "references">): readonly string[] => [
  ...new Set([...(draft.references ?? []), ...(draft.inReplyTo === undefined ? [] : [draft.inReplyTo])]),
];

export const toDraftMime = (draft: Draft, messageId: string, date: Date): Promise<Buffer> => {
  const references = replyReferences(draft);
  return new MailComposer({
    from: toMimeAddress(draft.from),
    to: draft.to.map(toMimeAddress),
    ...(draft.cc !== undefined && draft.cc.length > 0 && { cc: draft.cc.map(toMimeAddress) }),
    subject: draft.subject,
    text: draft.body,
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

export const uniqueByMessageId = (mails: readonly Mail[]): readonly Mail[] =>
  mails.filter((mail, index) => mails.findIndex((other) => other.messageId === mail.messageId) === index);

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
