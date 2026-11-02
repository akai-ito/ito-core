import { createCell } from "#cell.ts";
import { toTimestamp, type Cancel, type Clock } from "#clock.ts";
import type { Fetch } from "#capabilities/connect.ts";
import { valuesSetting, type CheckResult, type Host } from "#capabilities/host.ts";
import type { Values } from "#capabilities/manifest.ts";
import type { AddressUse, Contacts, Recipient } from "#contacts/contacts.ts";
import type { CardAnswer, DeskKeeper, NewCard } from "#desk/desk.ts";
import type { Complete, JsonSchema } from "#engine/engine.ts";
import type { QuickChoice, Stakes, StakesChoice } from "#engine/quick-model.ts";
import {
  createMailSource,
  fromUidSet,
  toUidSet,
  type Address,
  type Auth,
  type Filing,
  type FolderUse,
  type Mail,
  type MailPage,
  type MailQuery,
  type MailSource,
  type SavedWatermark,
  type SourceOptions,
  type UidGroup,
} from "#mail/imap.ts";
import {
  composeLetter,
  createFindPart,
  largestPartBytes,
  plainOf,
  withSignature,
  type InlinePart,
  type Letter,
  type Signature,
} from "#mail/compose.ts";
import { createMailFolders, sameName, type FileInto } from "#mail/folders.ts";
import { createOutlookToken } from "#mail/outlook.ts";
import type { Account } from "#mail/providers.ts";
import { learnSignature, signatureSample } from "#mail/signature.ts";
import type { Health } from "#problems/problems.ts";
import type { CalendarItem, Card, DoneEntry, ModelChoice, Step } from "#protocol/types.ts";
import { fail, ok, type Result } from "#result.ts";
import { outlookClientId, outlookScope, outlookTokenUrl } from "#sources/sources.ts";
import type { Store } from "#store/store.ts";
import { fieldOf, textOf } from "#tools/input.ts";
import type { Tool, ToolResult, ToolStep } from "#tools/mcp.ts";
import type { Info } from "#turns/turns.ts";

export type CreateMailSource = (options: SourceOptions) => MailSource;

export type Progress = (read: number, total: number) => void;

export type Mailbox = {
  readonly tools: readonly Tool[];
  readonly check: (account: Account, values: Values) => Promise<CheckResult>;
  readonly catchUp: (onProgress: Progress, only?: readonly string[]) => Promise<Result<undefined, string>>;
  readonly accounts: () => readonly Account[];
  readonly close: () => Promise<void>;
};

export type MailOptions = {
  readonly host: Pick<Host, "find" | "subscribe">;
  readonly store: Pick<Store, "setting" | "setSetting">;
  readonly desk: DeskKeeper;
  readonly clock: Clock;
  readonly fetch: Fetch;
  readonly complete: Complete;
  readonly quickChoice: QuickChoice;
  readonly work: (prompt: string, choice?: ModelChoice) => Promise<Result<string, string>>;
  readonly stakesChoice?: StakesChoice;
  // What's in motion for them, such as a job search, so the attention pass knows what's live.
  readonly matters?: () => readonly string[];
  // How they like their mail sorted, in their words from How to help you, kept from their corrections.
  readonly preferences?: () => string;
  readonly info: Info;
  readonly comingUp?: () => readonly CalendarItem[];
  readonly onHealth?: (account: Account, health: Health) => void;
  // When Kumo reads a new mail, and undefined once no account is connected.
  readonly onReading?: (at: string | undefined) => void;
  readonly createSource?: CreateMailSource;
  readonly sentPollMs?: number;
  // Kumo's workspace, where pictures and files for a draft come from, such as uploads from the chat.
  readonly workspace?: string;
  // Their contacts: who a sender is, and the address to write to someone named.
  readonly contacts?: Pick<Contacts, "known" | "recipient">;
};

const decisions = ["promotion", "notice", "newsletter", "record", "work", "urgent"] as const;

type Decision = (typeof decisions)[number];

const stakes: readonly Stakes[] = ["low", "high"];

type Judgement = {
  readonly decision: Decision;
  readonly stakes: Stakes;
  readonly folder: string;
  readonly reason: string;
  readonly confidence: number;
};

type Config = { readonly account: Account; readonly user: string; readonly auth: Auth; readonly key: string };

type Connection = Config & { readonly source: MailSource; readonly stop: () => void };

type FiledUndo = { readonly kind: "mail_filed"; readonly account: string; readonly id: string; readonly back: Filing };

type BlockedUndo = { readonly kind: "mail_blocked"; readonly sender: string };

// A quiet card asking whether to unsubscribe from a sender they've written to, and the mail it's about.
type UnsubscribeAsk = {
  readonly card: string;
  readonly account: string;
  readonly message_id: string;
  readonly sender: string;
};

type SentMark = { readonly read_at: string; readonly seen: readonly string[] };

type SentMail = { readonly account: string; readonly mail: Mail };

export const blockedSetting = "mail_blocked";

export const watermarkSetting = "mail_watermark";

export const unsubscribedSetting = "mail_unsubscribed";

export const keptListsSetting = "mail_kept_lists";

export const asksSetting = "mail_unsubscribe_asks";

export const sentSetting = "mail_sent";

export const signatureSetting = "mail_signature";

export const draftPartsSetting = "mail_draft_parts";

const accounts: readonly Account[] = ["icloud", "outlook", "gmail"];

const dayMs = 24 * 60 * 60 * 1000;
const catchUpDays = 90;
const chunkSize = 100;
const textLimit = 6000;
const sentTextLimit = 2000;
const draftSlackMs = 10 * 60 * 1000;
const sentSample = 30;
const evidenceDays = 30;
const evidenceLimit = 300;
// How sure the attention pass must be to bin or file a mail itself; below it, Kumo looks.
const sureEnough = 0.7;

const attentionSchema: JsonSchema = {
  type: "object",
  properties: {
    decision: { enum: decisions },
    stakes: { enum: stakes },
    folder: { type: "string" },
    reason: { type: "string" },
    confidence: { type: "number" },
  },
  required: ["decision", "stakes", "folder", "reason", "confidence"],
  additionalProperties: false,
};

// What a draft carried besides its words, so redrafting it keeps them: files attached, and whether it's signed.
type DraftParts = { readonly attach: readonly string[]; readonly signature: boolean };

type StoredImage = {
  readonly cid: string;
  readonly filename: string;
  readonly content_type: string;
  readonly content: string;
};

type StoredSignature = {
  readonly learned_at: string;
  readonly text?: string;
  readonly html?: string;
  readonly images?: readonly StoredImage[];
};

type DraftAttachment = NonNullable<NonNullable<Card["draft"]>["attachments"]>[number];

const toStoredImage = ({ cid, filename, contentType, content }: InlinePart): StoredImage => ({
  cid,
  filename,
  content_type: contentType,
  content: content.toString("base64"),
});

const toStoredSignature = (at: string, signature: Signature | undefined): StoredSignature => ({
  learned_at: at,
  ...(signature && {
    text: signature.text,
    ...(signature.html !== undefined && { html: signature.html }),
    images: signature.images.map((image) => toStoredImage(image)),
  }),
});

const fromStoredSignature = (stored: StoredSignature): Signature | undefined =>
  stored.text === undefined
    ? undefined
    : {
        text: stored.text,
        ...(stored.html !== undefined && { html: stored.html }),
        images: (stored.images ?? []).map(({ cid, filename, content_type: contentType, content }) => ({
          cid,
          filename,
          contentType,
          content: Buffer.from(content, "base64"),
        })),
      };

const toStored = (text: string | undefined): StoredSignature | undefined => {
  if (text === undefined) return undefined;
  try {
    const parsed = JSON.parse(text) as Partial<StoredSignature>;
    return typeof parsed.learned_at === "string" ? (parsed as StoredSignature) : undefined;
  } catch {
    return undefined;
  }
};

const attachmentsOf = (letter: Letter, signature: Signature | undefined): readonly DraftAttachment[] => {
  const signed = new Set(signature?.images.map(({ cid }) => cid));
  return [
    ...letter.inline
      .filter(({ cid }) => !signed.has(cid))
      .map(({ filename }) => ({ name: filename, kind: "image" as const, inline: true })),
    ...letter.attachments.map(({ filename, contentType }) => ({
      name: filename,
      kind: contentType.startsWith("image/") ? ("image" as const) : ("file" as const),
      inline: false,
    })),
  ];
};

// The words alone, so a sent mail matches its draft whatever its app did to the formatting.
const wordsOf = (text: string): string => (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).join(" ");

const rewriteSchema: JsonSchema = {
  type: "object",
  properties: { body: { type: "string" } },
  required: ["body"],
  additionalProperties: false,
};

const failed = (text: string): ToolResult => ({ text, isError: true });

const ignore = (): void => undefined;

const textValue = (values: Values, name: string): string => {
  const value = values[name];
  return typeof value === "string" ? value.trim() : "";
};

const senderOf = (mail: Mail): string => mail.from.name ?? mail.from.address;

const toAddress = (address: string): { readonly address: string } => ({ address });

const listOf = (value: unknown): readonly string[] =>
  (Array.isArray(value) ? (value as readonly unknown[]) : [])
    .flatMap((item) => (typeof item === "string" && item.trim() !== "" ? item.trim() : []))
    .map((item) => item);

const reSubject = (subject: string): string => (/^re:/iu.test(subject) ? subject : `Re: ${subject}`);

const subjectKey = (subject: string): string =>
  subject
    .replace(/^(?:\s*(?:re|fwd?|aw|sv)\s*:)+/iu, "")
    .replaceAll(/\s+/gu, " ")
    .trim()
    .toLowerCase();

const addressKey = (text: string): string =>
  (/<(?<address>[^<>]+)>/u.exec(text)?.groups?.address ?? text).trim().toLowerCase();

const firstName = (address: string): string => {
  const local = address.split("@", 1)[0] ?? address;
  const [first = local] = local.split(/[._-]/u, 1);
  return first.charAt(0).toUpperCase() + first.slice(1);
};

const domainName = (address: string): string => {
  const [label = ""] = (address.split("@", 2)[1] ?? "").split(".", 1);
  return label.charAt(0).toUpperCase() + label.slice(1);
};

const draftTitle = (to: string, name: string | undefined): string =>
  name === undefined
    ? `Draft to ${firstName(to)}${domainName(to) === "" ? "" : ` at ${domainName(to)}`}`
    : `Draft to ${name}`;

const isSameAddress = (left: string, right: string): boolean => addressKey(left) === addressKey(right);

// Whom a reply goes to, as a mail app's Reply has it: where the mail asks answers to go, or else its sender. A reply
// to a mail of their own goes to the people it went to.
const replyRecipients = (mail: Mail, user: string): readonly Address[] => {
  if (!isSameAddress(mail.from.address, user)) return mail.replyTo ?? [mail.from];
  const others = mail.to.filter(({ address }) => !isSameAddress(address, user));
  return others.length > 0 ? others : [mail.from];
};

// Where the mail asks answers to go, when that isn't its sender.
const replyToLines = ({ from, replyTo = [] }: Mail): readonly string[] =>
  replyTo.every(({ address }) => isSameAddress(address, from.address))
    ? []
    : [`Reply-To: ${replyTo.map(({ address }) => address).join(", ")}`];

// A mail as the agent reads it, with who the sender is in their Contacts when that's known.
const describe = (account: string, mail: Mail, limit = textLimit, sender?: string): string =>
  [
    `From: ${mail.from.name === undefined ? mail.from.address : `${mail.from.name} <${mail.from.address}>`}`,
    ...(sender === undefined ? [] : [sender]),
    ...replyToLines(mail),
    `To: ${mail.to.map(({ address }) => address).join(", ")}`,
    `Subject: ${mail.subject}`,
    `Date: ${mail.date}`,
    `Account: ${account}, Message-ID: ${mail.messageId}`,
    ...(mail.inReplyTo === undefined ? [] : [`In reply to: ${mail.inReplyTo}`]),
    "",
    mail.text.slice(0, limit),
  ].join("\n");

const toJudgement = (answer: unknown): Judgement | undefined => {
  const decision = fieldOf(answer, "decision");
  const confidence = fieldOf(answer, "confidence");
  return decisions.includes(decision as Decision)
    ? {
        decision: decision as Decision,
        // Unclear stakes count as real ones, so nothing that matters gets the light touch.
        stakes: fieldOf(answer, "stakes") === "low" ? "low" : "high",
        folder: textOf(answer, "folder").trim(),
        reason: textOf(answer, "reason").trim(),
        confidence: typeof confidence === "number" ? confidence : 0,
      }
    : undefined;
};

const mattersLines = (matters: readonly string[]): readonly string[] =>
  matters.length === 0 ? [] : [`What's in motion for them now: ${matters.join("; ")}.`];

const preferenceLines = (preferences: string): readonly string[] =>
  preferences === ""
    ? []
    : ["How they like their mail sorted, from their corrections, which comes first:", preferences];

const attentionPrompt = (
  account: string,
  mail: Mail,
  folders: string,
  matters: readonly string[],
  preferences: string,
): string =>
  [
    "You read every mail for the person and decide what it needs, so their inbox holds only what needs them. Judge",
    "by consequences, not tone: who sent it, a real deadline, the cost of waiting a day, and whether it touches",
    "something they care about.",
    "- promotion: selling or marketing something, even from a shop or a service they use. It goes to the bin.",
    "- notice: an automated notice with nothing worth keeping once read, such as a delivery update or a social",
    "  notification. It goes to the bin.",
    "- newsletter: writing they signed up to read, such as an editorial newsletter. It goes to their newsletters.",
    "- record: worth keeping but needing nothing from them, such as a receipt, a statement or a confirmation with",
    "  nothing to add. It's filed into a folder.",
    "- work: something to act on, put on the calendar, keep track of or answer, such as a new booking, a bill, a",
    "  form, a sign-in code they're waiting for, or a person writing to them.",
    "- urgent: work that can't wait a few hours, such as a same-day change, a security alert or a closing deadline.",
    `For a record or a newsletter, give the folder it belongs in. ${folders} Name one of theirs exactly as written,`,
    "or, with none yet, a short name for its kind, such as Receipts. Otherwise leave the folder empty.",
    "Stakes are high when a real person wrote it, or it touches money, a deadline, an interview, an opportunity",
    "such as a role or a company reaching out, or something in motion for them; low for routine and automated mail.",
    ...mattersLines(matters),
    ...preferenceLines(preferences),
    "Give the reason in a line and how confident you are, from 0 to 1.",
    "",
    describe(account, mail),
  ].join("\n");

const workPrompt = (
  account: string,
  mail: Mail,
  judged: Judgement,
  folders: string,
  sender: string | undefined,
): string =>
  [
    `A mail arrived in their ${account} inbox, and you judged it ${judged.decision}: ${judged.reason}`,
    "",
    describe(account, mail, textLimit, sender),
    "",
    "Do what it needs. Put confirmed bookings on their calendar with add_event, saying in the notes which mail it",
    "came from. Draft any reply with draft, in their voice; it's never sent. Keep things in motion current, and",
    "record what you did with done.",
    "If it's an opportunity, such as a role, an investor, or a company asking them to join or work with it, be",
    "prompt. Keep it in the right thing in motion, such as their job search, and when the company is new to them,",
    "put a two-line brief of what it actually does in that option's note, from the mail and a web search. A",
    "meeting time that's confirmed goes on their calendar with add_event; a time that's only proposed goes on",
    "Kumo's calendar as a hold, until it's settled. A new opportunity is worth one line to them now, with the brief.",
    "If it shows a new detail about someone in their life, such as a phone or an address in a signature, a new job",
    "or an address on a booking, update their Contacts with ito contacts, only when you're sure it's that person's.",
    "Then leave the inbox holding only what needs them. Once the mail needs nothing more from them, such as a",
    "booking you've put on the calendar, file it with file_mail into one of their folders, and bin promotions",
    "and noise. Leave it in the inbox while it still needs them, such as a reply you drafted or a bill to pay.",
    folders,
    judged.decision === "urgent"
      ? "It's urgent: post one line with urgent set, so they hear now."
      : "Post one line only if they should know now.",
  ].join("\n");

const catchUpPrompt = (lines: readonly string[], part: number, parts: number): string =>
  [
    `You're catching up on the person's last ${String(catchUpDays)} days of mail, part ${String(part)} of ${String(parts)}.`,
    "Here is each mail's date, sender and subject, with its account and Message-ID for mail_read:",
    ...lines,
    "",
    "Find what still matters and act on it. Put future bookings (travel, stays, tickets, appointments) on their",
    "calendar with add_event, noting the mail. Start or update things in motion for live matters, such as a job",
    "search, a trip or a case with a company. Remember what you learn about them in memory. Leave old and settled",
    "things alone, and don't record each mail you read.",
  ].join("\n");

const voicePrompt = (mails: readonly Mail[]): string =>
  [
    "Here are mails the person sent lately. Learn how they write: greetings and sign-offs, length, tone with",
    'different people, words they use. Write it under "Writing as you" on their How to help you page, briefly,',
    "so your drafts sound like them.",
    "",
    ...mails.map((mail) => `To ${mail.to.map(({ address }) => address).join(", ")}, ${mail.subject}:\n${mail.text}`),
  ].join("\n\n");

const cardLine = (card: Card): string =>
  `- ${[card.title, card.question?.text, card.offer?.text, card.times?.purpose].filter(Boolean).join(": ")} (${card.id})`;

const blockLine = ({ title, start, end, uid }: CalendarItem): string => `- ${title}, ${start} to ${end} (${uid})`;

const sentPrompt = (sent: readonly SentMail[], cards: readonly Card[], blocks: readonly CalendarItem[]): string =>
  [
    "They sent these mails themselves, from their own mail app or from a draft of yours:",
    "",
    sent.map(({ account, mail }) => describe(account, mail, sentTextLimit)).join("\n\n---\n\n"),
    "",
    "Bring what each one belongs to up to date, as you would for a mail that arrives. If it answers something",
    "in motion, it now waits on the other side: set waiting_on to them, since today, move the stage or the next",
    "step, add it to a case's timeline, or finish the thing if the mail settles it.",
    ...(cards.length > 0
      ? [
          "Waiting on you on their Desk; take off with clear_card any card one of these mails has answered:",
          ...cards.map(cardLine),
        ]
      : []),
    ...(blocks.length > 0
      ? [
          "Your blocks coming up on Kumo's calendar; remove with delete_event any that was for work these mails",
          "have done, or shorten it with change_event to what's left:",
          ...blocks.map(blockLine),
        ]
      : []),
    "Leave a mail that belongs to nothing you keep. Each change carries its own note, so don't record these",
    "with done, and don't post.",
  ].join("\n");

const learnPrompt = (card: Card, sent: Mail): string =>
  [
    "They sent a draft you wrote, after changing it. Note what to do differently next time, briefly, under",
    '"Writing as you" on their How to help you page. If the change was only about facts, note nothing.',
    "",
    `Your draft:\n${plainOf(card.draft?.body ?? "")}`,
    "",
    `What they sent:\n${sent.text}`,
  ].join("\n");

const toNewCard = (card: Card): NewCard => {
  const { kind, title, options, allows_text: allowsText, draft } = card;
  return { kind, title, options, allows_text: allowsText, ...(draft && { draft }) };
};

const summarise = (account: string, mail: Mail): string =>
  `- ${mail.date.slice(0, 16)} · ${senderOf(mail)} · ${mail.subject} (${account} ${mail.messageId})`;

const toSentMark = (text: string | undefined): SentMark | undefined => {
  if (text === undefined) return undefined;
  try {
    const parsed = JSON.parse(text) as Partial<SentMark>;
    return typeof parsed.read_at === "string" && !Number.isNaN(Date.parse(parsed.read_at))
      ? { read_at: parsed.read_at, seen: listOf(parsed.seen) }
      : undefined;
  } catch {
    return undefined;
  }
};

const isFiledUndo = (payload: unknown): payload is FiledUndo => fieldOf(payload, "kind") === "mail_filed";

const isBlockedUndo = (payload: unknown): payload is BlockedUndo => fieldOf(payload, "kind") === "mail_blocked";

const parsedList = (text = "[]"): readonly unknown[] => {
  try {
    const value = JSON.parse(text) as unknown;
    return Array.isArray(value) ? (value as readonly unknown[]) : [];
  } catch {
    return [];
  }
};

const toAsks = (text: string | undefined): readonly UnsubscribeAsk[] =>
  parsedList(text).flatMap((item) => {
    const [card, account, messageId, sender] = ["card", "account", "message_id", "sender"].map((field) =>
      textOf(item, field),
    );
    return card && account && messageId && sender ? { card, account, message_id: messageId, sender } : [];
  });

// Who they've written to is judged by the sender's site, so a shop's offers count as known if they ever wrote to
// its support desk. A country's second level stays, so shop.co.uk isn't everyone at co.uk.
const siteOf = (address: string): string => {
  const labels = (address.split("@", 2)[1] ?? address).toLowerCase().split(".");
  const isCountryPair = labels.length > 2 && (labels.at(-2)?.length ?? 0) <= 3 && (labels.at(-1)?.length ?? 0) === 2;
  return labels.slice(isCountryPair ? -3 : -2).join(".");
};

const mailReference = (account: string, mail: Mail): NonNullable<DoneEntry["mail"]> => ({
  account,
  message_id: mail.messageId,
  from: senderOf(mail),
  subject: mail.subject,
});

type Into = "archive" | "bin" | "inbox" | { readonly folder: string };

// Mails to move together, as asked for: each folder's UIDs and Message-IDs, where they go, and why.
type Plan = {
  readonly account: string;
  readonly groups: readonly (UidGroup & { readonly ids: readonly string[] })[];
  readonly into: Into;
  readonly is_new: boolean;
  readonly from: string;
  readonly count: number;
  readonly reason: string;
};

type BatchAsk = Plan & { readonly card: string };

// Puts a batch back: each part moves from the destination to the folder it came from, by its UIDs there when the
// server gave them, or by Message-ID. Mail going back to the inbox isn't new, so it isn't read again.
type MovedUndo = {
  readonly kind: "mail_moved";
  readonly account: string;
  readonly destination: string;
  readonly moves: readonly { readonly to: string; readonly uids?: string; readonly ids?: readonly string[] }[];
  readonly restore: readonly string[];
};

type StepMail = NonNullable<Step["mails"]>[number];

export const batchAsksSetting = "mail_batch_asks";

const pageSize = 20;
const largestPartMegabytes = largestPartBytes / (1024 * 1024);
// More mails than this in one move wait for them to agree on the Desk.
export const askAbove = 25;
const applyLabel = "Apply";
const threadTextLimit = 1500;
const mostStepMails = 50;

// One email address on its own, such as clara.voss@northwind.example.
const emailAddress = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:".]+(?:\.[^\s@<>()[\]\\,;:".]+)+$/u;

// A recipient given by name, without an @, to find in their Contacts.
const isName = (given: string): boolean => !given.includes("@");

const recipientProblem = (field: "to" | "cc", given: readonly string[]): string | undefined => {
  const wrong = given.find((address) => !emailAddress.test(address));
  return wrong === undefined
    ? undefined
    : `"${wrong}" isn't an email address. Give one address each time and repeat --${field} for each, such as ` +
        `--${field} clara.voss@northwind.example --${field} tess.harlow@halcyon.example.`;
};

const plural = (count: number, noun: string): string =>
  `${count.toLocaleString("en-GB")} ${noun}${count === 1 ? "" : "s"}`;

const matching = (total: number): string =>
  total === 0 ? "nothing matches" : `${plural(total, "mail")} ${total === 1 ? "matches" : "match"}`;

const capitalised = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

const withStop = (text: string): string => (/[.!?]$/u.test(text) ? text : `${text}.`);

const listed = (names: readonly string[], most = names.length): string => {
  if (names.length > most) return `${names.slice(0, most).join(", ")} and ${plural(names.length - most, "other")}`;
  return names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1) ?? ""}`;
};

const isInbox = (folder: string): boolean => folder.toUpperCase() === "INBOX";

const folderName = (folder: string): string => (isInbox(folder) ? "Inbox" : folder);

const placesOf = (searched: readonly string[], isEverywhere: boolean): string =>
  isEverywhere ? "all their mail" : listed(searched.map(folderName), 2);

const originOf = (groups: readonly UidGroup[], folder: string | undefined): string => {
  const [only] = groups;
  if (only !== undefined && groups.length === 1) return folderName(only.folder);
  return folder === undefined ? plural(groups.length, "folder") : folderName(folder);
};

const intoWords = (into: Into): string => {
  if (typeof into === "object") return `into ${into.folder}`;
  const words = { archive: "into the archive", bin: "to the bin", inbox: "to the inbox" };
  return words[into];
};

const queryWords = ({ from = "", subject, text, since }: MailQuery): string =>
  [
    from,
    subject === undefined ? "" : `“${subject}” in the subject`,
    text === undefined ? "" : `“${text}”`,
    since === undefined ? "" : `since ${since}`,
  ]
    .filter(Boolean)
    .join(", ");

const bareSubject = (subject: string): string => subject.replace(/^(?:\s*(?:re|fwd?|aw|sv)\s*:)+/iu, "").trim();

const subjectOf = (mail: Mail, isBare = false): string =>
  (isBare ? bareSubject(mail.subject) : mail.subject.trim()) || "(no subject)";

const stepDate = (date: string): string => {
  const parsed = Date.parse(date);
  return toTimestamp(Number.isNaN(parsed) ? 0 : parsed);
};

const toStepMail = (mail: Mail, limit?: number): StepMail => ({
  from: senderOf(mail),
  subject: subjectOf(mail),
  date: stepDate(mail.date),
  ...(limit !== undefined && { text: mail.text.slice(0, limit) }),
  ...(limit !== undefined && mail.text.length > limit && { cut: true as const }),
});

// The senders of a batch, most mails first.
const countedSenders = (mails: readonly Mail[]): readonly string[] => {
  const counts = Map.groupBy(mails, (mail) => senderOf(mail));
  return [...counts].toSorted(([, left], [, right]) => right.length - left.length).map(([sender]) => sender);
};

const filings: Readonly<Record<Filing, { readonly verb: (about: string) => string; readonly tally: string }>> = {
  archive: { verb: (about) => `Archived ${about}`, tally: "archived" },
  bin: { verb: (about) => `Binned ${about}`, tally: "binned" },
  inbox: { verb: (about) => `Moved ${about} back to the inbox`, tally: "back in the inbox" },
  flag: { verb: (about) => `Flagged ${about}`, tally: "flagged" },
  unflag: { verb: (about) => `Unflagged ${about}`, tally: "unflagged" },
};

const useNames: Readonly<Record<FolderUse, string>> = {
  inbox: "the inbox",
  archive: "the archive",
  sent: "sent mail",
  drafts: "drafts",
  trash: "the bin",
  junk: "junk",
};

const plainInto = ["archive", "bin", "inbox"] as const;

const isPlainInto = (value: unknown): value is (typeof plainInto)[number] =>
  plainInto.includes(value as (typeof plainInto)[number]);

// The first of these that says something.
const filled = (...texts: readonly (string | undefined)[]): string =>
  texts.find((text) => text !== undefined && text !== "") ?? "";

const queryOf = (input: unknown): MailQuery => {
  const limit = fieldOf(input, "limit");
  return {
    ...Object.fromEntries(
      ["from", "subject", "text", "since", "folder", "more"].flatMap((field) =>
        textOf(input, field).trim() === "" ? [] : [[field, textOf(input, field).trim()]],
      ),
    ),
    ...(typeof limit === "number" && { limit }),
  };
};

const isMovedUndo = (payload: unknown): payload is MovedUndo => fieldOf(payload, "kind") === "mail_moved";

const toInto = (value: unknown): Into | undefined => {
  if (isPlainInto(value)) return value;
  const folder = textOf(value, "folder");
  return folder === "" ? undefined : { folder };
};

const toBatchAsks = (text: string | undefined): readonly BatchAsk[] =>
  parsedList(text).flatMap((item) => {
    const into = toInto(fieldOf(item, "into"));
    const groups = fieldOf(item, "groups");
    const count = fieldOf(item, "count");
    const [card, account] = [textOf(item, "card"), textOf(item, "account")];
    return card && account && into && typeof count === "number" && Array.isArray(groups)
      ? {
          card,
          account,
          groups: (groups as readonly unknown[]).map((group) => ({
            folder: textOf(group, "folder"),
            uids: (fieldOf(group, "uids") as readonly number[] | undefined) ?? [],
            ids: listOf(fieldOf(group, "ids")),
          })),
          into,
          is_new: fieldOf(item, "is_new") === true,
          from: textOf(item, "from"),
          count,
          reason: textOf(item, "reason"),
        }
      : [];
  });

export const createMailbox = ({
  host,
  store,
  desk,
  clock,
  fetch: fetcher,
  complete,
  quickChoice,
  work,
  stakesChoice = () => Promise.resolve(undefined),
  matters = () => [],
  preferences = () => "",
  info,
  comingUp = () => [],
  onHealth = ignore,
  onReading = ignore,
  createSource = createMailSource,
  sentPollMs = 5 * 60 * 1000,
  workspace,
  contacts,
}: MailOptions): Mailbox => {
  const connections = createCell<ReadonlyMap<Account, Connection>>(new Map());
  const arrivals = createCell<Promise<void>>(Promise.resolve());
  const restored = createCell<ReadonlySet<string>>(new Set());
  const sentTimer = createCell<Cancel | undefined>(undefined);
  const isClosed = createCell(false);

  const logger = (message: string, details: Readonly<Record<string, unknown>>): void => {
    info(message, details);
  };

  const findPart = createFindPart({ workspace, fetch: fetcher });

  const outlookToken = (values: Values): (() => Promise<Result<string, string>>) =>
    createOutlookToken({
      tokens: {
        read: () => textValue(host.find("outlook")?.values ?? values, "token") || textValue(values, "token"),
        write: (token) => {
          const saved = host.find("outlook")?.values ?? values;
          store.setSetting(valuesSetting("outlook"), JSON.stringify({ ...saved, token }));
        },
      },
      fetch: fetcher,
      clock,
      tokenUrl: outlookTokenUrl,
      clientId: outlookClientId,
      scope: outlookScope,
    });

  const configOf = (account: Account, values: Values): Config | undefined => {
    switch (account) {
      case "icloud":
      case "gmail": {
        const user = textValue(values, account === "icloud" ? "apple_id" : "address");
        const password = textValue(values, "app_password");
        return user === "" || password === ""
          ? undefined
          : { account, user, auth: { password }, key: `${account}:${user}:${password}` };
      }
      case "outlook": {
        const user = textValue(values, "address");
        return user === "" || textValue(values, "token") === ""
          ? undefined
          : { account, user, auth: { accessToken: outlookToken(values) }, key: `${account}:${user}` };
      }
    }
  };

  const connectionOf = (account: string): Connection | undefined =>
    account === "" ? connections.get().values().next().value : connections.get().get(account as Account);

  const blocked = (): readonly string[] => {
    try {
      return listOf(JSON.parse(store.setting(blockedSetting) ?? "[]") as unknown);
    } catch {
      return [];
    }
  };

  const isBlocked = (address: string): boolean => {
    const lower = address.toLowerCase();
    return blocked().some((sender) => (sender.startsWith("@") ? lower.endsWith(sender) : lower === sender));
  };

  const fileInto: FileInto = async (reference, folder, reason) => {
    const account = reference.account ?? "";
    const connection = connectionOf(account);
    if (!connection) return fail(`${account} mail isn't set up any more.`);
    const filed = await connection.source.fileInto(reference.message_id, folder);
    if (!filed.ok) return filed;
    desk.addDone({
      text: `Filed "${reference.subject}" from ${reference.from} into ${folder}`,
      ...(reason !== "" && { reason }),
      mail: reference,
      quiet: false,
      undo: { kind: "mail_filed", account, id: reference.message_id, back: "inbox" } satisfies FiledUndo,
    });
    return ok(undefined);
  };

  const evidence = async (): Promise<readonly string[]> => {
    const since = toTimestamp(clock.now() - evidenceDays * dayMs);
    const read = await Promise.all(
      connections
        .get()
        .values()
        .map(async ({ account, source }) => {
          const recent = await source.recent(since);
          return recent.ok ? recent.value.map((mail) => summarise(account, mail)) : [];
        }),
    );
    return read
      .flat()
      .toSorted((left, right) => left.localeCompare(right))
      .slice(-evidenceLimit);
  };

  const folders = createMailFolders({ store, desk, complete, info, fileInto, evidence });

  const judge = async (account: string, mail: Mail): Promise<Judgement> => {
    const answered = await complete(
      attentionPrompt(account, mail, folders.note(), matters(), preferences().trim()),
      attentionSchema,
      await quickChoice(),
    );
    const judged = answered.ok ? toJudgement(answered.value) : undefined;
    if (judged) return judged;
    info("The attention pass couldn't judge a mail, so Kumo looks at it", {
      error: answered.ok ? "an answer out of shape" : answered.failure,
    });
    return {
      decision: "work",
      stakes: "high",
      folder: "",
      reason: "The attention pass couldn't judge it.",
      confidence: 0,
    };
  };

  const listSetting = (key: string): readonly string[] => listOf(parsedList(store.setting(key)));

  const remember = (key: string, sender: string): void => {
    const senders = new Set([...listSetting(key), sender]);
    store.setSetting(key, JSON.stringify([...senders]));
  };

  const asks = (): readonly UnsubscribeAsk[] => toAsks(store.setting(asksSetting));

  const moveOut = async (
    { account, source }: Connection,
    mail: Mail,
    to: "archive" | "bin",
    reason: string,
  ): Promise<void> => {
    const filed = await source.file(mail.messageId, to);
    if (!filed.ok) {
      desk.addDone({
        text: `Couldn't move "${mail.subject}" from ${senderOf(mail)}; it's still in your inbox`,
        reason: filed.failure,
        mail: mailReference(account, mail),
        quiet: false,
      });
      return;
    }
    desk.addDone({
      text: `${to === "bin" ? "Binned" : "Archived"} "${mail.subject}" from ${senderOf(mail)}`,
      ...(reason !== "" && { reason }),
      mail: mailReference(account, mail),
      quiet: false,
      undo: { kind: "mail_filed", account, id: mail.messageId, back: "inbox" } satisfies FiledUndo,
    });
  };

  const unsubscribeNow = async ({ account, source }: Connection, mail: Mail, reason: string): Promise<void> => {
    const done = await source.unsubscribe(mail);
    if (!done.ok) {
      info("A list couldn't be unsubscribed from", { error: done.failure });
      return;
    }
    remember(unsubscribedSetting, mail.from.address.toLowerCase());
    desk.addDone({
      text: `Unsubscribed from ${senderOf(mail)}`,
      reason,
      mail: mailReference(account, mail),
      quiet: false,
    });
  };

  const answerAsk = async (card: { readonly id: string }, given: CardAnswer): Promise<undefined> => {
    const ask = asks().find((candidate) => candidate.card === card.id);
    store.setSetting(asksSetting, JSON.stringify(asks().filter((candidate) => candidate.card !== card.id)));
    if (!ask) return undefined;
    if (given.option !== "Unsubscribe") {
      remember(keptListsSetting, ask.sender);
      return undefined;
    }
    const connection = connectionOf(ask.account);
    const read = connection ? await connection.source.read(ask.message_id) : fail("Its mail isn't set up any more.");
    if (connection && read.ok) await unsubscribeNow(connection, read.value, "You asked");
    else info("A list couldn't be unsubscribed from", { error: read.ok ? "no mail" : read.failure });
    return undefined;
  };

  const askToUnsubscribe = (account: string, mail: Mail, sender: string): void => {
    const card = desk.addCard({
      kind: "question",
      title: `Unsubscribe from ${senderOf(mail)}?`,
      options: [{ label: "Unsubscribe" }, { label: "Stay subscribed" }],
      allows_text: false,
      quiet: true,
      question: {
        text: `Their promotions go to the bin. You've written to ${siteOf(sender)} before, so I'm asking first.`,
      },
    });
    store.setSetting(
      asksSetting,
      JSON.stringify([...asks(), { card: card.id, account, message_id: mail.messageId, sender }]),
    );
    desk.handleCard(card.id, answerAsk);
  };

  // A promotion's list is left only when they've never written to the sender; otherwise they're asked, quietly.
  const leaveList = async (connection: Connection, mail: Mail): Promise<void> => {
    const sender = mail.from.address.toLowerCase();
    const isSettled =
      mail.unsubscribe === undefined ||
      sender === "" ||
      [...listSetting(unsubscribedSetting), ...listSetting(keptListsSetting)].includes(sender) ||
      asks().some((ask) => ask.sender === sender);
    if (isSettled) return;
    const written = await connection.source.hasWritten(siteOf(sender));
    if (!written.ok) {
      info("Sent mail couldn't be checked, so Kumo stays subscribed", { error: written.failure });
      return;
    }
    if (written.value) askToUnsubscribe(connection.account, mail, sender);
    else await unsubscribeNow(connection, mail, "Promotions from a sender you've never written to");
  };

  const keep = async (connection: Connection, mail: Mail, judged: Judgement): Promise<void> => {
    const folder = judged.folder || (judged.decision === "newsletter" ? "Newsletters" : "");
    const placed =
      folder === ""
        ? fail("No folder was named.")
        : await folders.place(mailReference(connection.account, mail), folder, judged.reason);
    // With no folder of theirs to fit it, the archive keeps it out of the inbox and in search.
    if (!placed.ok) await moveOut(connection, mail, "archive", judged.reason);
  };

  // What the attention pass can finish itself, when it's sure: the rest goes to Kumo.
  const sort = async (connection: Connection, mail: Mail, judged: Judgement): Promise<boolean> => {
    if (judged.confidence < sureEnough) return false;
    switch (judged.decision) {
      case "promotion": {
        await moveOut(connection, mail, "bin", judged.reason);
        await leaveList(connection, mail);
        return true;
      }
      case "notice": {
        await moveOut(connection, mail, "bin", judged.reason);
        return true;
      }
      case "newsletter":
      case "record": {
        await keep(connection, mail, judged);
        return true;
      }
      case "work":
      case "urgent": {
        return false;
      }
    }
  };

  const binBlocked = async ({ account, source }: Connection, mail: Mail): Promise<boolean> => {
    const filed = await source.file(mail.messageId, "bin");
    if (!filed.ok) {
      info("A blocked sender's mail couldn't be binned, so Kumo reads it", { error: filed.failure });
      return false;
    }
    desk.addDone({
      text: `Binned a mail from ${senderOf(mail)}, whom you blocked`,
      reason: "A blocked sender",
      mail: mailReference(account, mail),
      quiet: true,
      undo: { kind: "mail_filed", account, id: mail.messageId, back: "inbox" } satisfies FiledUndo,
    });
    return true;
  };

  const arrive = async (connection: Connection, mail: Mail): Promise<void> => {
    const { account } = connection;
    if (restored.get().has(mail.messageId)) {
      restored.update((current) => new Set([...current].filter((id) => id !== mail.messageId)));
      return;
    }
    onReading(toTimestamp(clock.now()));
    if (isBlocked(mail.from.address) && (await binBlocked(connection, mail))) return;
    const judged = await judge(account, mail);
    if (await sort(connection, mail, judged)) return;
    const sender = await contacts?.known(mail.from.address);
    const prompt = workPrompt(account, mail, judged, folders.note(), sender);
    const done = await work(prompt, await stakesChoice(judged.stakes));
    if (done.ok) return;
    desk.addDone({
      text: `Couldn't look at "${mail.subject}" from ${senderOf(mail)}; it's still in your inbox`,
      reason: done.failure,
      mail: mailReference(account, mail),
      quiet: false,
    });
  };

  // Mail is handled one at a time, in the order it came; each settles once Kumo is done with it.
  const onMail = (connection: Connection, mail: Mail): Promise<void> =>
    arrivals.update(async (previous) => {
      await previous;
      try {
        await arrive(connection, mail);
      } catch (error) {
        info("A new mail couldn't be handled", { error: String(error) });
      }
    });

  const reconcile = (): void => {
    if (isClosed.get()) return;
    for (const account of accounts) {
      const found = host.find(account);
      const config = found?.state === "on" ? configOf(account, found.values) : undefined;
      const current = connections.get().get(account);
      if (current && current.key === config?.key) continue;
      if (current) {
        current.stop();
        void current.source.close();
        connections.update((all) => new Map([...all].filter(([key]) => key !== account)));
        onHealth(account, { ok: true });
      }
      if (!config) continue;
      const markKey = `${watermarkSetting}:${account}:${config.user}`;
      const saved = store.setting(markKey);
      const source = createSource({
        account,
        user: config.user,
        auth: config.auth,
        logger,
        ...(saved !== undefined && { watermark: JSON.parse(saved) as SavedWatermark }),
        onWatermark: (watermark) => {
          store.setSetting(markKey, JSON.stringify(watermark));
        },
        onHealth: (health) => {
          onHealth(account, health);
        },
      });
      const watching = createCell<Connection | undefined>(undefined);
      const stop = source.watch((mail) => {
        const connection = watching.get();
        return connection ? onMail(connection, mail) : Promise.resolve();
      });
      const connection: Connection = { ...config, source, stop };
      watching.set(connection);
      connections.update((all) => new Map([...all, [account, connection]]));
    }
    if (connections.get().size === 0) onReading(undefined);
  };

  const draftCards = (): readonly Card[] => desk.cards().filter((card) => card.kind === "draft" && card.draft);

  const matches = (card: Card, account: string, sent: Mail): boolean => {
    const { draft } = card;
    if (draft?.account !== account || Date.parse(sent.date) < Date.parse(card.at) - draftSlackMs) return false;
    if (sent.messageId === draft.message_id) return true;
    const parent = draft.in_reply_to;
    if (parent !== undefined && (sent.inReplyTo === parent || sent.references.includes(parent))) return true;
    if (parent !== undefined && sent.inReplyTo !== undefined) return false;
    const recipients = new Set(draft.to.map((wanted) => addressKey(wanted)));
    return (
      subjectKey(sent.subject) === subjectKey(draft.subject) &&
      sent.to.some(({ address }) => recipients.has(addressKey(address)))
    );
  };

  const bringUpToDate = async (sent: readonly SentMail[]): Promise<void> => {
    const cards = desk.cards().filter(({ kind }) => kind !== "draft" && kind !== "invite");
    const blocks = comingUp().filter(({ calendar }) => calendar.kumo);
    const done = await work(sentPrompt(sent, cards, blocks));
    if (done.ok) return;
    for (const { account, mail } of sent) {
      desk.addDone({
        text: `Couldn't bring things up to date with your mail "${mail.subject}"`,
        reason: done.failure,
        mail: { account, message_id: mail.messageId, from: "You", subject: mail.subject },
        quiet: false,
      });
    }
  };

  const sentKey = ({ account, user }: Connection): string => `${sentSetting}:${account}:${user}`;

  const readSent = async (
    connection: Connection,
  ): Promise<{ readonly fresh: readonly Mail[]; readonly keep: () => void }> => {
    const key = sentKey(connection);
    const mark = toSentMark(store.setting(key));
    const readAt = clock.now();
    // IMAP searches Sent by day in the server's own time zone, so read a day back and skip what was seen.
    const since = (mark === undefined ? readAt : Date.parse(mark.read_at)) - dayMs;
    const sent = await connection.source.sent(toTimestamp(since));
    if (!sent.ok) {
      info("Sent mail couldn't be read, so Kumo reads it next time", {
        account: connection.account,
        error: sent.failure,
      });
      return { fresh: [], keep: ignore };
    }
    const seen = new Set(mark?.seen);
    return {
      fresh: sent.value.filter(({ messageId }) => !seen.has(messageId)),
      keep: () => {
        const kept: SentMark = { read_at: toTimestamp(readAt), seen: sent.value.map(({ messageId }) => messageId) };
        store.setSetting(key, JSON.stringify(kept));
      },
    };
  };

  const matchDraft = async (account: string, mail: Mail): Promise<void> => {
    const card = draftCards().find((candidate) => matches(candidate, account, mail));
    if (!card) return;
    desk.removeCard(card.id);
    forgetParts(card.id);
    const drafted = withSignature(
      plainOf(card.draft?.body ?? ""),
      card.draft?.signature === undefined ? undefined : { text: card.draft.signature, images: [] },
    );
    const isChanged = wordsOf(mail.text) !== wordsOf(drafted);
    if (isChanged) await work(learnPrompt(card, mail));
  };

  const watchSent = async (): Promise<void> => {
    const fresh = createCell<readonly SentMail[]>([]);
    const reads = createCell<readonly (() => void)[]>([]);
    for (const connection of connections.get().values()) {
      const { fresh: mails, keep } = await readSent(connection);
      reads.update((current) => [...current, keep]);
      for (const mail of mails) {
        await matchDraft(connection.account, mail);
        fresh.update((current) => [...current, { account: connection.account, mail }]);
      }
    }
    if (fresh.get().length > 0) await bringUpToDate(fresh.get());
    for (const keep of reads.get()) keep();
  };

  const pollSent = (): void => {
    if (isClosed.get()) return;
    sentTimer.set(
      clock.after(sentPollMs, () => {
        void watchSent()
          .catch((error: unknown) => {
            info("Sent mail couldn't be watched", { error: String(error) });
          })
          .then(pollSent);
      }),
    );
  };

  const partsAll = (): Readonly<Record<string, DraftParts>> => {
    try {
      const parsed = JSON.parse(store.setting(draftPartsSetting) ?? "{}") as unknown;
      return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, DraftParts>) : {};
    } catch {
      return {};
    }
  };

  const partsOf = (card: string | undefined): DraftParts | undefined =>
    card === undefined ? undefined : partsAll()[card];

  // Kept only for drafts still on the Desk.
  const keepParts = (card: string, parts: DraftParts): void => {
    const waiting = new Set(draftCards().map(({ id }) => id));
    const kept = Object.entries({ ...partsAll(), [card]: parts }).filter(([id]) => waiting.has(id) || id === card);
    store.setSetting(draftPartsSetting, JSON.stringify(Object.fromEntries(kept)));
  };

  const forgetParts = (card: string): void => {
    const kept = Object.entries(partsAll()).filter(([id]) => id !== card);
    store.setSetting(draftPartsSetting, JSON.stringify(Object.fromEntries(kept)));
  };

  // Their signature for an account, learned from what they sent lately and kept for a day. Without one, none.
  const signatureOf = async ({ account, user, source }: Connection): Promise<Signature | undefined> => {
    const key = `${signatureSetting}:${account}:${user}`;
    const saved = toStored(store.setting(key));
    // Learned again once a day, so a new signature is picked up within the day.
    if (saved && clock.now() - Date.parse(saved.learned_at) < dayMs) return fromStoredSignature(saved);
    const bodies = await source.sentBodies(signatureSample);
    if (!bodies.ok) {
      info("Sent mail couldn't be read for the signature, so Kumo uses the one it knew", { error: bodies.failure });
      return saved && fromStoredSignature(saved);
    }
    const learned = learnSignature(bodies.value);
    const stored = toStoredSignature(toTimestamp(clock.now()), learned);
    store.setSetting(key, JSON.stringify(stored));
    return learned;
  };

  const rewrite = async (card: Card, change: string): Promise<NewCard | undefined> => {
    const { draft } = card;
    const connection = draft ? connectionOf(draft.account) : undefined;
    if (!draft || !connection) return toNewCard(card);
    const answered = await complete(
      [
        "Rewrite this draft reply as asked, in the person's own voice. Keep what's right; change only what's asked.",
        "It's light Markdown: keep its formatting, and any picture (![…](…)) where it fits. Their signature is",
        "added after it, so don't sign with it.",
        "",
        `Draft:\n${draft.body}`,
        "",
        `They asked: ${change}`,
      ].join("\n"),
      rewriteSchema,
    );
    const body = answered.ok ? textOf(answered.value, "body").trim() : "";
    if (body === "") {
      info("A draft couldn't be rewritten", { error: answered.ok ? "an empty draft" : answered.failure });
      return toNewCard(card);
    }
    const parts = partsOf(card.id) ?? { attach: [], signature: draft.signature !== undefined };
    const signature = parts.signature ? await signatureOf(connection) : undefined;
    const letter = await composeLetter({
      markdown: body,
      attach: parts.attach,
      find: findPart,
      ...(signature && { signature }),
    });
    if (!letter.ok) {
      info("A rewritten draft couldn't be put together", { error: letter.failure });
      return toNewCard(card);
    }
    const saved = await connection.source.draft({
      from: toAddress(draft.from),
      to: draft.to.map((address) => toAddress(address)),
      ...(draft.cc && { cc: draft.cc.map((address) => toAddress(address)) }),
      subject: draft.subject,
      body: letter.value.text,
      html: letter.value.html,
      inline: letter.value.inline,
      attachments: letter.value.attachments,
      ...(draft.in_reply_to !== undefined && { inReplyTo: draft.in_reply_to }),
      replaces: draft.message_id,
    });
    if (!saved.ok) {
      info("A rewritten draft couldn't be saved", { error: saved.failure });
      return toNewCard(card);
    }
    const { kind, title, options, allows_text: allowsText } = card;
    const { account, from, to, cc, subject, in_reply_to: inReplyTo } = draft;
    const attachments = attachmentsOf(letter.value, signature);
    return {
      kind,
      title,
      options,
      allows_text: allowsText,
      draft: {
        account,
        from,
        to,
        ...(cc && { cc }),
        subject,
        ...(inReplyTo !== undefined && { in_reply_to: inReplyTo }),
        body,
        message_id: saved.value.messageId,
        ...(signature && { signature: signature.text }),
        ...(attachments.length > 0 && { attachments: [...attachments] }),
      },
    };
  };

  for (const ask of asks()) {
    if (desk.cards().some((card) => card.id === ask.card)) desk.handleCard(ask.card, answerAsk);
  }

  desk.handle("draft", async (card, answer) => {
    if (answer.text !== undefined) return rewrite(card, answer.text);
    const { draft } = card;
    const connection = draft ? connectionOf(draft.account) : undefined;
    if (draft && connection && answer.option === "Drop it") {
      const removed = await connection.source.removeDraft(draft.message_id);
      if (!removed.ok) info("A draft couldn't be removed", { error: removed.failure });
      forgetParts(card.id);
    }
    return;
  });

  const moveBack = async ({ account, destination, moves, restore }: MovedUndo): Promise<Result<undefined, string>> => {
    const connection = connectionOf(account);
    if (!connection) return fail(`${account} mail isn't set up any more.`);
    restored.update((current) => new Set([...current, ...restore]));
    for (const { to, uids, ids = [] } of moves) {
      const found =
        uids === undefined
          ? await connection.source.select({ messageIds: ids })
          : ok({ groups: [{ folder: destination, uids: fromUidSet(uids) }] });
      if (!found.ok) return found;
      const back = await connection.source.move(found.value.groups, isInbox(to) ? "inbox" : { folder: to });
      if (!back.ok) return back;
    }
    return ok(undefined);
  };

  desk.onUndo(async (_entry, payload) => {
    if (isBlockedUndo(payload)) {
      store.setSetting(blockedSetting, JSON.stringify(blocked().filter((sender) => sender !== payload.sender)));
      return ok(undefined);
    }
    if (isMovedUndo(payload)) return moveBack(payload);
    if (!isFiledUndo(payload)) return ok(undefined);
    const connection = connectionOf(payload.account);
    if (!connection) return fail(`${payload.account} mail isn't set up any more.`);
    if (payload.back === "inbox") restored.update((current) => new Set([...current, payload.id]));
    return connection.source.file(payload.id, payload.back);
  });

  const withSource = async (
    account: string,
    act: (connection: Connection) => Promise<ToolResult>,
  ): Promise<ToolResult> => {
    const connection = connectionOf(account);
    return connection ? act(connection) : failed("No mail is set up yet.");
  };

  const accountField = { type: "string", description: "icloud, outlook or gmail; leave it out for the only one." };

  const scopeFields = {
    from: { type: "string", description: "A sender's address, name or domain, such as acme.com." },
    subject: { type: "string" },
    text: { type: "string", description: "Words in the mail." },
    since: { type: "string", description: "A date, such as 2026-10-01." },
    folder: {
      type: "string",
      description:
        "Where to look: inbox, archive, sent, bin or one of the account's folders by name. Everywhere by default.",
    },
  };

  const pageFields = {
    limit: { type: "integer", description: `How many to show, ${String(pageSize)} by default and at most 50.` },
    more: { type: "string", description: "The cursor the last page gave, for the page after it." },
  };

  // The page's mails, one a line, between a line saying what was searched and one saying whether there's more.
  const pageText = (account: string, page: MailPage, heading: string): string => {
    const first = page.total - page.after - page.mails.length + 1;
    const range =
      page.mails.length === 0
        ? ""
        : ` These are ${String(first)}–${String(first + page.mails.length - 1)}, newest first.`;
    const more =
      page.more === undefined
        ? page.mails.length === 0
          ? []
          : ["That's all of them."]
        : [`${String(page.after)} more: run it again with --more ${page.more} for the next page.`];
    return [`${heading}${range}`, ...page.mails.map((mail) => summarise(account, mail)), ...more].join("\n");
  };

  const pageNote = (page: MailPage): string =>
    page.total === 0
      ? "Nothing matched"
      : `${plural(page.total, "mail")}${page.more === undefined ? "" : `, ${String(page.after)} more after these`}`;

  const draftField = {
    type: "array",
    items: { type: "string" },
    description:
      "One email address, or a name in their Contacts such as “Clara Voss” or “Clara Voss (work)”, each time; " +
      "repeat it for more, such as --to a@acme.com --to b@acme.com.",
  };

  const draftList = (): string =>
    draftCards()
      .map(({ id, title }) => `${id} (${title})`)
      .join(", ") || "none";

  const batchAsks = (): readonly BatchAsk[] => toBatchAsks(store.setting(batchAsksSetting));

  // The asks still on the Desk. One whose card went without an answer, such as one Kumo cleared, goes with its list
  // of every mail it would have moved.
  const waitingAsks = (): readonly BatchAsk[] =>
    batchAsks().filter((ask) => desk.cards().some((card) => card.id === ask.card));

  // Where a batch goes, from what Kumo gave: one of their folders by name, or the archive, the bin or the inbox.
  const intoOf = (text: string, isNew: boolean): Result<Into, string> => {
    const wanted = text.trim();
    const filing = wanted.toLowerCase();
    if (isPlainInto(filing)) return ok(filing);
    if (wanted === "") return fail("Say where they go, with --into: one of their folders, archive, bin or inbox.");
    const theirs = folders.names();
    if (theirs.length === 0) {
      return fail("They haven't chosen their mail folders yet, so mail can only go to archive, bin or inbox for now.");
    }
    const match = theirs.find((name) => sameName(name, wanted));
    if (match !== undefined) return ok({ folder: match });
    return isNew
      ? ok({ folder: wanted })
      : fail(
          `They have no folder called ${wanted}. Their folders: ${listed(theirs)}. Make one with --new-folder only ` +
            "when they've asked for it.",
        );
  };

  // Moves a batch and records it in Done with an undo. A move the server stopped partway says how far it got, and
  // why in its note; Undo puts back what moved.
  const applyMove = async (
    { account, source }: Connection,
    plan: Plan,
  ): Promise<Result<{ readonly text: string; readonly note: string }, string>> => {
    if (plan.is_new && typeof plan.into === "object") folders.addName(plan.into.folder, plan.reason);
    const ids = plan.groups.flatMap((group) => group.ids);
    if (plan.into === "inbox") restored.update((current) => new Set([...current, ...ids]));
    const moved = await source.move(plan.groups, plan.into, (count, total) => {
      info("Moving mail", { account, moved: count, total });
    });
    if (!moved.ok) return moved;
    const { moved: count, failure } = moved.value;
    const where = `from ${plan.from} ${intoWords(plan.into)}`;
    const text =
      failure === undefined
        ? `Moved ${plural(count, "mail")} ${where}`
        : `Moved ${String(count)} of ${plural(plan.count, "mail")} ${where}; the rest stayed where they were`;
    const note = filled(failure, plan.reason);
    const idsFrom = (origin: string): readonly string[] =>
      plan.groups.filter(({ folder }) => folder === origin).flatMap((group) => group.ids);
    desk.addDone({
      text,
      ...(note !== "" && { reason: note }),
      quiet: false,
      undo: {
        kind: "mail_moved",
        account,
        destination: moved.value.destination,
        moves: moved.value.placed.map(({ origin, uids }) =>
          uids === undefined ? { to: origin, ids: idsFrom(origin) } : { to: origin, uids: toUidSet(uids) },
        ),
        restore: moved.value.placed.flatMap(({ origin }) => (isInbox(origin) ? idsFrom(origin) : [])),
      } satisfies MovedUndo,
    });
    return ok({ text, note });
  };

  const answerMove = async (card: { readonly id: string }, given: CardAnswer): Promise<undefined> => {
    const ask = batchAsks().find((candidate) => candidate.card === card.id);
    store.setSetting(batchAsksSetting, JSON.stringify(batchAsks().filter((candidate) => candidate.card !== card.id)));
    if (ask === undefined || given.option !== applyLabel) return undefined;
    const connection = connectionOf(ask.account);
    const done = connection ? await applyMove(connection, ask) : fail(`${ask.account} mail isn't set up any more.`);
    if (!done.ok) {
      desk.addDone({
        text: `Couldn't move ${plural(ask.count, "mail")} from ${ask.from}`,
        reason: done.failure,
        quiet: false,
      });
    }
    return undefined;
  };

  // A big batch waits for one answer on the Desk, rather than moving at once.
  const askToMove = (plan: Plan, mails: readonly Mail[]): Card => {
    const senders = countedSenders(mails);
    const card = desk.addCard({
      kind: "question",
      title: `Move ${plural(plan.count, "mail")} from ${plan.from} ${intoWords(plan.into)}?`,
      options: [{ label: applyLabel }, { label: "Not now" }],
      allows_text: false,
      question: {
        text: [
          ...(plan.reason === "" ? [] : [withStop(plan.reason)]),
          `They're from ${listed(senders, 3)}. They go in one move, and Undo on your Done list puts them back.`,
        ].join(" "),
      },
    });
    store.setSetting(batchAsksSetting, JSON.stringify([...waitingAsks(), { ...plan, card: card.id }]));
    desk.handleCard(card.id, answerMove);
    return card;
  };

  const moveMails = async (connection: Connection, input: unknown): Promise<ToolResult> => {
    const ids = listOf(fieldOf(input, "message_id"));
    const query = queryOf(input);
    const hasQuery = Object.keys(query).length > 0;
    if (hasQuery && ids.length > 0)
      return failed("Pick mails by --message-id, or by --folder and search words, not both.");
    if (!hasQuery && ids.length === 0) {
      return failed("Say which mails: --message-id for each one, or --folder and any search words.");
    }
    const into = intoOf(textOf(input, "into"), fieldOf(input, "new_folder") === true);
    if (!into.ok) return failed(into.failure);
    const selected = await connection.source.select(ids.length > 0 ? { messageIds: ids } : { query });
    if (!selected.ok) return failed(selected.failure);
    const { groups, mails } = selected.value;
    const missing = new Set(ids).size - mails.length;
    const unfound = ids.length > 0 && missing > 0 ? ` ${plural(missing, "Message-ID")} weren't found.` : "";
    if (mails.length === 0)
      return { text: `Nothing matches, so nothing moved.${unfound}`, step: { title: "Found no mail to move" } };
    const reason = textOf(input, "reason").trim();
    const plan: Plan = {
      account: connection.account,
      groups: groups.map(({ folder, uids }) => ({
        folder,
        uids,
        ids: mails.filter((mail) => mail.folder === folder).map(({ messageId }) => messageId),
      })),
      into: into.value,
      is_new: fieldOf(input, "new_folder") === true,
      from: originOf(groups, query.folder),
      count: mails.length,
      reason,
    };
    const shown = mails
      .toSorted((left, right) => right.date.localeCompare(left.date))
      .slice(0, mostStepMails)
      .map((mail) => toStepMail(mail));
    if (mails.length > askAbove) {
      const card = askToMove(plan, mails);
      return {
        text:
          `That's ${plural(mails.length, "mail")}, so they're asked once on the Desk first, as ${card.id}: ` +
          `“${card.title}” They move when they tap ${applyLabel}, so don't ask again in the chat.${unfound}`,
        step: {
          title: `Asked you about moving ${plural(mails.length, "mail")} from ${plan.from} ${intoWords(plan.into)}`,
          note: "It's on your Desk until you choose",
          mails: shown,
        },
      };
    }
    const done = await applyMove(connection, plan);
    if (!done.ok) return failed(done.failure);
    const { text, note } = done.value;
    return {
      text: `${text}.${note === reason ? "" : ` ${withStop(note)}`}${unfound}`,
      step: { title: text, ...(note !== "" && { note }), mails: shown },
    };
  };

  // When mail last came from an address, and when they last wrote to it, for picking someone's address.
  const useOf =
    (source: MailSource): AddressUse =>
    async (address) => {
      const [received, sent] = await Promise.all([
        source.search({ from: address, limit: 1 }),
        source.search({ folder: "sent", text: address, limit: 1 }),
      ]);
      const from = received.ok ? received.value.mails[0]?.date : undefined;
      const to = sent.ok ? sent.value.mails[0]?.date : undefined;
      return { ...(from !== undefined && { from }), ...(to !== undefined && { to }) };
    };

  // Recipients as given: an address stays as it is; a name, without an @, is found in their Contacts.
  const resolveNames = async (
    { source }: Connection,
    givenTo: readonly string[],
    givenCc: readonly string[],
  ): Promise<
    Result<
      { readonly to: readonly string[]; readonly cc: readonly string[]; readonly found: readonly Recipient[] },
      string
    >
  > => {
    const isAddress = (given: string): boolean => contacts === undefined || !isName(given);
    const problem =
      recipientProblem(
        "to",
        givenTo.filter((given) => isAddress(given)),
      ) ??
      recipientProblem(
        "cc",
        givenCc.filter((given) => isAddress(given)),
      );
    if (problem !== undefined) return fail(problem);
    const resolve = async (
      given: string,
    ): Promise<Result<{ readonly address: string; readonly found?: Recipient }, string>> => {
      if (contacts === undefined || !isName(given)) return ok({ address: given });
      const found = await contacts.recipient(given, useOf(source));
      return found.ok ? ok({ address: found.value.address, found: found.value }) : found;
    };
    const [to, cc] = await Promise.all([Promise.all(givenTo.map(resolve)), Promise.all(givenCc.map(resolve))]);
    const all = [...to, ...cc];
    const [failure] = all.flatMap((result) => (result.ok ? [] : result.failure));
    if (failure !== undefined) return fail(failure);
    const addressOf = (result: Result<{ readonly address: string }, string>): readonly string[] =>
      result.ok ? [result.value.address] : [];
    return ok({
      to: to.flatMap((result) => addressOf(result)),
      cc: cc.flatMap((result) => addressOf(result)),
      found: all.flatMap((result) => (result.ok && result.value.found ? result.value.found : [])),
    });
  };

  const tools: readonly Tool[] = [
    {
      name: "mail_search",
      title: "Search mail",
      audience: "work",
      description:
        "Search their mail by sender, subject, words, date or folder, newest first, a page at a time, with each " +
        "mail's Message-ID. It says what it searched, how many match, and how to get the next page.",
      inputSchema: {
        type: "object",
        properties: { account: accountField, ...scopeFields, ...pageFields },
        additionalProperties: false,
      },
      call: (input) =>
        withSource(textOf(input, "account"), async ({ account, source }) => {
          const query = queryOf(input);
          const found = await source.search(query);
          if (!found.ok) return failed(found.failure);
          const where = placesOf(found.value.searched, query.folder === undefined);
          const what = queryWords(query);
          const heading =
            what === ""
              ? `${capitalised(where)} holds ${plural(found.value.total, "mail")}.`
              : `Searched ${where} for ${what}: ${matching(found.value.total)}.`;
          return {
            text: pageText(account, found.value, heading),
            step: {
              title: what === "" ? `Looked through ${where}` : `Searched mail for ${what}`,
              note: pageNote(found.value),
              mails: found.value.mails.map((mail) => toStepMail(mail)),
            },
          };
        }),
    },
    {
      name: "mail_inbox",
      title: "List the inbox",
      audience: "work",
      description:
        "List what's in their inbox now, newest first, a page at a time, with each mail's Message-ID and how many " +
        "are left. Use it to go through the inbox, such as to tidy it.",
      inputSchema: {
        type: "object",
        properties: { account: accountField, ...pageFields },
        additionalProperties: false,
      },
      call: (input) =>
        withSource(textOf(input, "account"), async ({ account, source }) => {
          const found = await source.search({ ...queryOf(input), folder: "inbox" });
          if (!found.ok) return failed(found.failure);
          const heading = `Their inbox holds ${plural(found.value.total, "mail")} now.`;
          return {
            text: pageText(account, found.value, heading),
            step: {
              title: "Looked through your inbox",
              note: pageNote(found.value),
              mails: found.value.mails.map((mail) => toStepMail(mail)),
            },
          };
        }),
    },
    {
      name: "mail_read",
      title: "Read a mail",
      audience: "work",
      description: "Read one mail whole by its Message-ID.",
      inputSchema: {
        type: "object",
        properties: { account: accountField, message_id: { type: "string" } },
        required: ["message_id"],
        additionalProperties: false,
      },
      call: (input) =>
        withSource(textOf(input, "account"), async ({ account, source }) => {
          const read = await source.read(textOf(input, "message_id"));
          if (!read.ok) return failed(read.failure);
          return {
            text: describe(account, read.value, textLimit, await contacts?.known(read.value.from.address)),
            step: {
              title: `Read “${subjectOf(read.value)}” from ${senderOf(read.value)}`,
              mails: [toStepMail(read.value, textLimit)],
            },
          };
        }),
    },
    {
      name: "mail_thread",
      title: "Read a thread",
      audience: "work",
      description: "Read the whole thread a mail belongs to, oldest first.",
      inputSchema: {
        type: "object",
        properties: { account: accountField, message_id: { type: "string" } },
        required: ["message_id"],
        additionalProperties: false,
      },
      call: (input) =>
        withSource(textOf(input, "account"), async ({ account, user, source }) => {
          const thread = await source.thread(textOf(input, "message_id"));
          if (!thread.ok) return failed(thread.failure);
          const [first] = thread.value;
          const others = [
            ...new Set(
              thread.value
                .filter((mail) => addressKey(mail.from.address) !== addressKey(user))
                .map((mail) => senderOf(mail)),
            ),
          ];
          const people = others.length === 0 ? "" : ` with ${listed(others, 2)}`;
          const described = await Promise.all(
            thread.value.map(async (mail) =>
              describe(account, mail, textLimit, await contacts?.known(mail.from.address)),
            ),
          );
          return {
            text: described.join("\n\n---\n\n"),
            step: {
              title: `Read the thread “${first === undefined ? "" : subjectOf(first, true)}”${people}`,
              note: plural(thread.value.length, "mail"),
              mails: thread.value.slice(-mostStepMails).map((mail) => toStepMail(mail, threadTextLimit)),
            },
          };
        }),
    },
    {
      name: "draft",
      title: "Draft a reply",
      audience: "work",
      description:
        "Write a draft into their Drafts folder and put it on the Desk for them to send. Never sent by you. With " +
        "reply_to, it answers that mail: to and subject follow it. With replaces, it takes the place of a draft " +
        "already on the Desk, keeping whatever you don't give again. Write in their voice, in light Markdown; it " +
        "goes as formatted mail with a plain-text copy, with pictures inline, files attached and their own signature " +
        "at the end.",
      inputSchema: {
        type: "object",
        properties: {
          account: accountField,
          reply_to: { type: "string", description: "The Message-ID of the mail it answers." },
          replaces: {
            type: "string",
            description: "The Desk card id of a draft this one replaces, such as to correct a recipient.",
          },
          to: draftField,
          cc: draftField,
          subject: { type: "string" },
          body: {
            type: "string",
            description:
              "Light Markdown: paragraphs, **bold**, *italics*, lists and [links](https://…). Put a picture in where " +
              "it belongs with ![what it shows](uploads/photo.jpg): a file in your workspace, such as one they " +
              "attached in the chat, or an https address. Don't sign with their signature; it's added.",
          },
          attach: {
            type: "array",
            items: { type: "string" },
            description: `A file to attach, from your workspace or an https address, up to ${String(largestPartMegabytes)} MB; repeat it for more.`,
          },
          signature: {
            type: "boolean",
            description: "Their signature goes at the end; --no-signature leaves it off, only when they ask.",
          },
          title: { type: "string", description: "The card's title, such as “Note to Hotel Orto”." },
        },
        additionalProperties: false,
      },
      call: (input) => {
        const replacing = textOf(input, "replaces").trim();
        const earlier = replacing === "" ? undefined : draftCards().find((card) => card.id === replacing);
        // A draft named to replace is in its own account, whichever they have first.
        return withSource(filled(textOf(input, "account"), earlier?.draft?.account), async (connection) => {
          const { account, user, source } = connection;
          if (replacing !== "" && earlier?.draft?.account !== account) {
            return failed(`There's no draft ${replacing} on the Desk to replace. Drafts there: ${draftList()}.`);
          }
          const before = earlier?.draft;
          const replyTo = filled(textOf(input, "reply_to"), before?.in_reply_to);
          const original = replyTo === "" ? undefined : await source.read(replyTo);
          if (original && !original.ok) return failed(original.failure);
          const answering = original?.value;
          const named = await resolveNames(connection, listOf(fieldOf(input, "to")), listOf(fieldOf(input, "cc")));
          if (!named.ok) return failed(named.failure);
          const { to: givenTo, cc: givenCc, found } = named.value;
          const answered = answering && replyRecipients(answering, user).map(({ address }) => address);
          const to = givenTo.length > 0 ? givenTo : (before?.to ?? answered ?? []);
          const cc = givenCc.length > 0 ? givenCc : (before?.cc ?? []);
          // A name as the mail it answers wrote it, such as its sender's.
          const headerName = (address: string | undefined): string | undefined =>
            answering &&
            [...(answering.replyTo ?? []), answering.from, ...answering.to, ...answering.cc].find(
              (written) =>
                address !== undefined && written.name !== undefined && isSameAddress(written.address, address),
            )?.name;
          const nameOf = (address: string): Address => {
            const name = found.find((recipient) => recipient.address === address)?.name ?? headerName(address);
            return name === undefined ? toAddress(address) : { address, name };
          };
          const subject = filled(textOf(input, "subject"), before?.subject, answering && reSubject(answering.subject));
          const body = filled(textOf(input, "body").trim(), before?.body);
          if (body === "" || subject === "" || to.length === 0) {
            return failed("A draft needs who it's to, a subject and a body, or reply_to.");
          }
          // A redraft keeps what the earlier one carried; a new draft is signed and carries nothing.
          const earlierParts = before
            ? (partsOf(earlier.id) ?? { attach: [], signature: before.signature !== undefined })
            : { attach: [], signature: true };
          const givenAttach = fieldOf(input, "attach");
          const givenSignature = fieldOf(input, "signature");
          const parts: DraftParts = {
            attach: Array.isArray(givenAttach) ? listOf(givenAttach) : earlierParts.attach,
            signature: typeof givenSignature === "boolean" ? givenSignature : earlierParts.signature,
          };
          const signature = parts.signature ? await signatureOf(connection) : undefined;
          const letter = await composeLetter({
            markdown: body,
            attach: parts.attach,
            find: findPart,
            ...(signature && { signature }),
          });
          if (!letter.ok) return failed(letter.failure);
          const saved = await source.draft({
            from: toAddress(user),
            to: to.map((address) => nameOf(address)),
            ...(cc.length > 0 && { cc: cc.map((address) => nameOf(address)) }),
            subject,
            body: letter.value.text,
            html: letter.value.html,
            inline: letter.value.inline,
            attachments: letter.value.attachments,
            ...(answering && {
              inReplyTo: answering.messageId,
              references: [...answering.references, answering.messageId],
            }),
          });
          if (!saved.ok) return failed(saved.failure);
          // A new draft for the same mail, or one named to replace, takes the old one's place in Drafts and on the Desk.
          const replaced = draftCards().filter(
            (card) =>
              card.id === replacing ||
              (answering !== undefined &&
                card.draft?.account === account &&
                card.draft.in_reply_to === answering.messageId),
          );
          for (const old of replaced) {
            const removed = old.draft ? await source.removeDraft(old.draft.message_id) : ok(undefined);
            if (!removed.ok) info("A replaced draft couldn't be removed", { error: removed.failure });
          }
          // The draft named to replace keeps its card; any other for the same mail goes.
          const [kept, ...dropped] = replaced.toSorted(
            (left, right) => Number(right.id === replacing) - Number(left.id === replacing),
          );
          for (const old of dropped) {
            desk.removeCard(old.id);
            forgetParts(old.id);
          }
          const attachments = attachmentsOf(letter.value, signature);
          const fresh: NewCard = {
            kind: "draft",
            title: textOf(input, "title").trim() || (earlier?.title ?? draftTitle(to[0] ?? "", headerName(to[0]))),
            options: [{ label: "Drop it" }],
            allows_text: true,
            draft: {
              account,
              from: user,
              to: [...to],
              ...(cc.length > 0 && { cc: [...cc] }),
              subject,
              body,
              message_id: saved.value.messageId,
              ...(answering && { in_reply_to: answering.messageId }),
              ...(signature && { signature: signature.text }),
              ...(attachments.length > 0 && { attachments: [...attachments] }),
            },
          };
          // The new draft takes the old one's place on the Desk, marked changed.
          if (kept) desk.replaceCard(kept.id, fresh);
          const id = kept?.id ?? desk.addCard(fresh).id;
          keepParts(id, parts);
          const whom = headerName(to[0]) ?? to[0] ?? "";
          const signed = parts.signature
            ? signature
              ? " Their signature from their sent mail is at the end."
              : " Their sent mail has no signature, so none is added."
            : "";
          const carried =
            attachments.length === 0
              ? ""
              : ` It carries ${listed(attachments.map(({ name, inline }) => (inline ? `${name} (inline)` : name)))}.`;
          return {
            text:
              `Saved the draft in Drafts and put it on the Desk as ${id}${kept ? ", in place of the earlier one" : ""}.` +
              `${signed}${carried}` +
              found.map(({ name, address, why }) => ` From Contacts, ${name}: ${address}, ${why}.`).join(""),
            step: {
              title: `${kept ? "Redrafted" : "Drafted"} ${answering ? "a reply" : "a mail"} to ${whom}`,
              note: `To ${to.join(", ")}`,
              mails: [{ from: "You", subject, date: toTimestamp(clock.now()), text: letter.value.text }],
            },
          };
        });
      },
    },
    {
      name: "file_mail",
      title: "File a mail",
      audience: "work",
      description:
        "File a mail into one of their folders, archive it, bin it, flag or unflag it, or move it back to the " +
        "inbox. Moves are recorded in their Done list with an undo, so don't record them again.",
      inputSchema: {
        type: "object",
        properties: {
          account: accountField,
          message_id: { type: "string" },
          to: { enum: ["folder", "archive", "bin", "inbox", "flag", "unflag"] },
          folder: { type: "string", description: "With to folder: which of their folders, such as Bookings & travel." },
          new_folder: { type: "boolean", description: "Make the folder first, only when they've asked for a new one." },
          reason: { type: "string", description: "Why, in a line, for their Done list." },
        },
        required: ["message_id", "to"],
        additionalProperties: false,
      },
      call: (input) =>
        withSource(textOf(input, "account"), async ({ account, source }) => {
          const id = textOf(input, "message_id");
          const read = await source.read(id);
          const reason = textOf(input, "reason").trim();
          const said = (title: string, tally: string): ToolStep => ({
            title,
            tally,
            ...(reason !== "" && { note: reason }),
          });
          if (textOf(input, "to") === "folder") {
            const folder = textOf(input, "folder").trim();
            if (folder === "") return failed("Say which folder, with folder.");
            if (!read.ok) return failed(read.failure);
            const reference = mailReference(account, read.value);
            const isNew = fieldOf(input, "new_folder") === true;
            const isHeld = folders.names().length === 0;
            const placed = await (isNew
              ? folders.add(reference, folder, reason)
              : folders.place(reference, folder, reason));
            if (!placed.ok) return failed(placed.failure);
            const about = `“${subjectOf(read.value)}” from ${senderOf(read.value)}`;
            return {
              text: placed.value,
              step: isHeld
                ? said(`Kept ${about} in the inbox until you choose your folders`, "kept for now")
                : said(`Filed ${about} into ${folder}`, `into ${folder}`),
            };
          }
          const to = textOf(input, "to") as Filing;
          // Marked before it moves, so its arrival back in the inbox is never read as new mail.
          if (to === "inbox") restored.update((current) => new Set([...current, id]));
          const filed = await source.file(id, to);
          if (!filed.ok) return failed(filed.failure);
          if ((to === "archive" || to === "bin") && read.ok) {
            desk.addDone({
              text: `${to === "bin" ? "Binned" : "Archived"} "${read.value.subject}" from ${senderOf(read.value)}`,
              ...(reason !== "" && { reason }),
              mail: mailReference(account, read.value),
              quiet: false,
              undo: { kind: "mail_filed", account, id, back: "inbox" } satisfies FiledUndo,
            });
          }
          const about = read.ok ? `“${subjectOf(read.value)}” from ${senderOf(read.value)}` : "a mail";
          const { verb, tally } = filings[to];
          return { text: `Filed it: ${to}.`, step: said(verb(about), tally) };
        }),
    },
    {
      name: "mail_move",
      title: "Move mails",
      audience: "work",
      description:
        "Move many mails at once: by Message-ID, or everything in a folder or a search, such as a folder an " +
        `earlier assistant made. They go into one of their folders, the archive, the bin or the inbox. Up to ` +
        `${String(askAbove)} move now; more wait for them to agree on one Desk card. It's one line in their Done ` +
        "list with an undo, so don't record it again.",
      inputSchema: {
        type: "object",
        properties: {
          account: accountField,
          message_id: {
            type: "array",
            items: { type: "string" },
            description: "A mail's Message-ID; repeat it for each mail.",
          },
          ...scopeFields,
          folder: {
            type: "string",
            description: "Take mail from this folder: inbox, archive or one of the account's folders by name.",
          },
          into: {
            type: "string",
            description: "Where they go: one of their folders by name, archive, bin or inbox.",
          },
          new_folder: { type: "boolean", description: "Make the folder first, only when they've asked for a new one." },
          reason: { type: "string", description: "Why, in a line, for their Done list." },
        },
        required: ["into"],
        additionalProperties: false,
      },
      call: (input) => withSource(textOf(input, "account"), (connection) => moveMails(connection, input)),
    },
    {
      name: "mail_folders",
      title: "List mail folders",
      audience: "work",
      description:
        "List every folder in their mail account with how many mails each holds, and which are their own folders " +
        "that you file into. Use it before moving an old folder's mail into theirs.",
      inputSchema: {
        type: "object",
        properties: { account: accountField },
        additionalProperties: false,
      },
      call: (input) =>
        withSource(textOf(input, "account"), async ({ account, source }) => {
          const listed = await source.folders();
          if (!listed.ok) return failed(listed.failure);
          const theirs = folders.names();
          const isTheirs = (name: string): boolean => theirs.some((own) => sameName(own, name));
          const lines = listed.value.map(({ name, use, messages, unseen }) => {
            const marks = [
              ...(use === undefined ? [] : [useNames[use]]),
              ...(isTheirs(name) ? ["one of their folders"] : []),
            ];
            const counts = `${plural(messages, "mail")}${unseen > 0 ? `, ${String(unseen)} unread` : ""}`;
            return `- ${name}: ${counts}${marks.length > 0 ? ` (${marks.join(", ")})` : ""}`;
          });
          const missing = theirs.filter((own) => listed.value.every(({ name }) => !sameName(name, own)));
          return {
            text: [
              `The folders in their ${account} mail:`,
              ...lines,
              ...(missing.length > 0
                ? [`Their folders not made yet (the first mail filed makes one): ${missing.join(", ")}.`]
                : []),
              ...(theirs.length === 0 ? ["They haven't chosen their own folders yet."] : []),
            ].join("\n"),
            step: { title: "Looked at your mail folders", note: plural(listed.value.length, "folder") },
          };
        }),
    },
    {
      name: "unsubscribe",
      title: "Unsubscribe",
      audience: "work",
      description: "Unsubscribe them from the list a mail came from, through its unsubscribe link. It's recorded.",
      inputSchema: {
        type: "object",
        properties: {
          account: accountField,
          message_id: { type: "string" },
          reason: { type: "string", description: "Why, in a line, for their Done list." },
        },
        required: ["message_id"],
        additionalProperties: false,
      },
      call: (input) =>
        withSource(textOf(input, "account"), async ({ account, source }) => {
          const read = await source.read(textOf(input, "message_id"));
          if (!read.ok) return failed(read.failure);
          const done = await source.unsubscribe(read.value);
          if (!done.ok) return failed(done.failure);
          remember(unsubscribedSetting, read.value.from.address.toLowerCase());
          const reason = textOf(input, "reason").trim();
          desk.addDone({
            text: `Unsubscribed from ${senderOf(read.value)}`,
            ...(reason !== "" && { reason }),
            mail: mailReference(account, read.value),
            quiet: false,
          });
          return {
            text: `Unsubscribed from ${senderOf(read.value)}.`,
            step: { title: `Unsubscribed from ${senderOf(read.value)}`, ...(reason !== "" && { note: reason }) },
          };
        }),
    },
    {
      name: "block",
      title: "Block a sender",
      audience: "work",
      description:
        "Bin every future mail from a sender, by address or @domain, when they've asked or it's clearly abuse. It's " +
        "recorded with an undo.",
      inputSchema: {
        type: "object",
        properties: { sender: { type: "string", description: "An address, or @domain for all of it." } },
        required: ["sender"],
        additionalProperties: false,
      },
      call: (input) => {
        const sender = textOf(input, "sender").trim().toLowerCase();
        if (sender === "") return Promise.resolve(failed("Say which address or @domain to block."));
        const senders = new Set([...blocked(), sender]);
        store.setSetting(blockedSetting, JSON.stringify([...senders]));
        desk.addDone({
          text: `Blocked ${sender}: their mail goes straight to the bin`,
          quiet: false,
          undo: { kind: "mail_blocked", sender } satisfies BlockedUndo,
        });
        return Promise.resolve({
          text: `Blocked ${sender}.`,
          step: { title: `Blocked ${sender}`, note: "Their mail goes straight to the bin" },
        });
      },
    },
  ];

  const waiting = waitingAsks();
  if (waiting.length < batchAsks().length) store.setSetting(batchAsksSetting, JSON.stringify(waiting));
  for (const ask of waiting) desk.handleCard(ask.card, answerMove);

  const check = async (account: Account, values: Values): Promise<CheckResult> => {
    const config = configOf(account, values);
    if (!config) return { problem: "Fill in every field first." };
    const source = createSource({ account, user: config.user, auth: config.auth, logger });
    try {
      const checked = await source.check();
      return checked.ok
        ? { summary: `Connected: ${String(checked.value.folders)} mail folders.` }
        : { problem: checked.failure };
    } finally {
      await source.close();
    }
  };

  const catchUp = async (onProgress: Progress, only?: readonly string[]): Promise<Result<undefined, string>> => {
    const since = toTimestamp(clock.now() - catchUpDays * dayMs);
    const reading = connections
      .get()
      .values()
      .filter(({ account }) => only?.includes(account) ?? true)
      .toArray();
    const readRecent = async ({ account, source }: Connection): Promise<Result<readonly string[], string>> => {
      const recent = await source.recent(since);
      if (!recent.ok) info("Recent mail couldn't be read", { account, error: recent.failure });
      return recent.ok ? ok(recent.value.map((mail) => summarise(account, mail))) : recent;
    };
    const read = await Promise.all(reading.map((connection) => readRecent(connection)));
    const [unread = "No mail is set up."] = read.flatMap((result) => (result.ok ? [] : result.failure));
    if (read.every((result) => !result.ok)) return fail(unread);
    const lines = read.flatMap((result) => (result.ok ? result.value : []));
    onProgress(0, lines.length);
    const parts = Math.ceil(lines.length / chunkSize);
    const indexes = Array.from({ length: parts }, (_, index) => index);
    const failures = createCell(0);
    for (const index of indexes) {
      const done = await work(catchUpPrompt(lines.slice(index * chunkSize, (index + 1) * chunkSize), index + 1, parts));
      if (!done.ok) failures.update((count) => count + 1);
      if (index + 1 < parts) onProgress((index + 1) * chunkSize, lines.length);
    }
    if (parts > 0 && failures.get() === parts) return fail("Kumo couldn't read any of it.");
    await folders.propose(lines);
    const sent = await Promise.all(
      reading.map(async ({ source }) => {
        const found = await source.sent(since);
        return found.ok ? found.value : [];
      }),
    );
    const sample = sent.flat().slice(-sentSample);
    if (sample.length > 0) await work(voicePrompt(sample));
    return ok(undefined);
  };

  const unsubscribe = host.subscribe(reconcile);
  reconcile();
  pollSent();

  return {
    tools,
    check,
    catchUp,
    accounts: () => connections.get().keys().toArray(),
    close: async () => {
      isClosed.set(true);
      unsubscribe();
      sentTimer.get()?.();
      for (const { stop } of connections.get().values()) stop();
      await arrivals.get();
      await Promise.all(
        connections
          .get()
          .values()
          .map(({ source }) => source.close()),
      );
    },
  };
};
