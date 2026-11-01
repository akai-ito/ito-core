import { createCell } from "#cell.ts";
import { toTimestamp, type Cancel, type Clock } from "#clock.ts";
import type { Fetch } from "#capabilities/connect.ts";
import { valuesSetting, type CheckResult, type Host } from "#capabilities/host.ts";
import type { Values } from "#capabilities/manifest.ts";
import type { CardAnswer, DeskKeeper, NewCard } from "#desk/desk.ts";
import type { Complete, JsonSchema } from "#engine/engine.ts";
import type { QuickChoice, Stakes, StakesChoice } from "#engine/quick-model.ts";
import {
  createMailSource,
  type Auth,
  type Filing,
  type Mail,
  type MailSource,
  type SavedWatermark,
  type SourceOptions,
} from "#mail/imap.ts";
import { createMailFolders, type FileInto } from "#mail/folders.ts";
import { createOutlookToken } from "#mail/outlook.ts";
import type { Account } from "#mail/providers.ts";
import type { Health } from "#problems/problems.ts";
import type { CalendarItem, Card, DoneEntry, ModelChoice } from "#protocol/types.ts";
import { fail, ok, type Result } from "#result.ts";
import { outlookClientId, outlookScope, outlookTokenUrl } from "#sources/sources.ts";
import type { Store } from "#store/store.ts";
import { fieldOf, textOf } from "#tools/input.ts";
import type { Tool, ToolResult } from "#tools/mcp.ts";
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
  readonly info: Info;
  readonly comingUp?: () => readonly CalendarItem[];
  readonly onHealth?: (account: Account, health: Health) => void;
  // When Kumo reads a new mail, and undefined once no account is connected.
  readonly onReading?: (at: string | undefined) => void;
  readonly createSource?: CreateMailSource;
  readonly sentPollMs?: number;
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

const draftTitle = (to: string, original: Mail | undefined): string =>
  original?.from.name === undefined
    ? `Draft to ${firstName(to)}${domainName(to) === "" ? "" : ` at ${domainName(to)}`}`
    : `Draft to ${original.from.name}`;

const describe = (account: string, mail: Mail, limit = textLimit): string =>
  [
    `From: ${mail.from.name === undefined ? mail.from.address : `${mail.from.name} <${mail.from.address}>`}`,
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

const attentionPrompt = (account: string, mail: Mail, folders: string, matters: readonly string[]): string =>
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
    "Give the reason in a line and how confident you are, from 0 to 1.",
    "",
    describe(account, mail),
  ].join("\n");

const workPrompt = (account: string, mail: Mail, judged: Judgement, folders: string): string =>
  [
    `A mail arrived in their ${account} inbox, and you judged it ${judged.decision}: ${judged.reason}`,
    "",
    describe(account, mail),
    "",
    "Do what it needs. Put confirmed bookings on their calendar with add_event, saying in the notes which mail it",
    "came from. Draft any reply with draft, in their voice; it's never sent. Keep things in motion current, and",
    "record what you did with done.",
    "If it's an opportunity, such as a role, an investor, or a company asking them to join or work with it, be",
    "prompt. Keep it in the right thing in motion, such as their job search, and when the company is new to them,",
    "put a two-line brief of what it actually does in that option's note, from the mail and a web search. A",
    "meeting time that's confirmed goes on their calendar with add_event; a time that's only proposed goes on",
    "Kumo's calendar as a hold, until it's settled. A new opportunity is worth one line to them now, with the brief.",
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
    `Your draft:\n${card.draft?.body ?? ""}`,
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
  info,
  comingUp = () => [],
  onHealth = ignore,
  onReading = ignore,
  createSource = createMailSource,
  sentPollMs = 5 * 60 * 1000,
}: MailOptions): Mailbox => {
  const connections = createCell<ReadonlyMap<Account, Connection>>(new Map());
  const arrivals = createCell<Promise<void>>(Promise.resolve());
  const restored = createCell<ReadonlySet<string>>(new Set());
  const sentTimer = createCell<Cancel | undefined>(undefined);
  const isClosed = createCell(false);

  const logger = (message: string, details: Readonly<Record<string, unknown>>): void => {
    info(message, details);
  };

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
      attentionPrompt(account, mail, folders.note(), matters()),
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
    const done = await work(workPrompt(account, mail, judged, folders.note()), await stakesChoice(judged.stakes));
    if (done.ok) return;
    desk.addDone({
      text: `Couldn't look at "${mail.subject}" from ${senderOf(mail)}; it's still in your inbox`,
      reason: done.failure,
      mail: mailReference(account, mail),
      quiet: false,
    });
  };

  const onMail = (connection: Connection, mail: Mail): void => {
    void arrivals.update(async (previous) => {
      await previous;
      try {
        await arrive(connection, mail);
      } catch (error) {
        info("A new mail couldn't be handled", { error: String(error) });
      }
    });
  };

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
        if (connection) onMail(connection, mail);
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
    const isChanged = mail.text.trim() !== (card.draft?.body ?? "").trim();
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

  const rewrite = async (card: Card, change: string): Promise<NewCard | undefined> => {
    const { draft } = card;
    const connection = draft ? connectionOf(draft.account) : undefined;
    if (!draft || !connection) return toNewCard(card);
    const answered = await complete(
      [
        "Rewrite this draft reply as asked, in the person's own voice. Keep what's right; change only what's asked.",
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
    const saved = await connection.source.draft({
      from: toAddress(draft.from),
      to: draft.to.map((address) => toAddress(address)),
      ...(draft.cc && { cc: draft.cc.map((address) => toAddress(address)) }),
      subject: draft.subject,
      body,
      ...(draft.in_reply_to !== undefined && { inReplyTo: draft.in_reply_to }),
      replaces: draft.message_id,
    });
    if (!saved.ok) {
      info("A rewritten draft couldn't be saved", { error: saved.failure });
      return toNewCard(card);
    }
    const { kind, title, options, allows_text: allowsText } = card;
    return {
      kind,
      title,
      options,
      allows_text: allowsText,
      draft: { ...draft, body, message_id: saved.value.messageId },
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
    }
    return;
  });

  desk.onUndo(async (_entry, payload) => {
    if (isBlockedUndo(payload)) {
      store.setSetting(blockedSetting, JSON.stringify(blocked().filter((sender) => sender !== payload.sender)));
      return ok(undefined);
    }
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

  const tools: readonly Tool[] = [
    {
      name: "mail_search",
      title: "Search mail",
      audience: "work",
      description: "Search their mail by sender, subject, words or date, newest first, with each mail's Message-ID.",
      inputSchema: {
        type: "object",
        properties: {
          account: accountField,
          from: { type: "string" },
          subject: { type: "string" },
          text: { type: "string" },
          since: { type: "string", description: "A date, such as 2026-10-01." },
        },
        additionalProperties: false,
      },
      call: (input) =>
        withSource(textOf(input, "account"), async ({ account, source }) => {
          const query = Object.fromEntries(
            ["from", "subject", "text", "since"].flatMap((field) =>
              textOf(input, field) === "" ? [] : [[field, textOf(input, field)]],
            ),
          );
          const found = await source.search(query);
          if (!found.ok) return failed(found.failure);
          return {
            text:
              found.value.length === 0
                ? "No mail matches."
                : found.value.map((mail) => summarise(account, mail)).join("\n"),
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
          return read.ok ? { text: describe(account, read.value) } : failed(read.failure);
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
        withSource(textOf(input, "account"), async ({ account, source }) => {
          const thread = await source.thread(textOf(input, "message_id"));
          return thread.ok
            ? { text: thread.value.map((mail) => describe(account, mail)).join("\n\n---\n\n") }
            : failed(thread.failure);
        }),
    },
    {
      name: "draft",
      title: "Draft a reply",
      audience: "work",
      description:
        "Write a draft into their Drafts folder and put it on the Desk for them to send. Never sent by you. With " +
        "reply_to, it answers that mail: to and subject follow it. Write in their voice.",
      inputSchema: {
        type: "object",
        properties: {
          account: accountField,
          reply_to: { type: "string", description: "The Message-ID of the mail it answers." },
          to: { type: "array", items: { type: "string" } },
          cc: { type: "array", items: { type: "string" } },
          subject: { type: "string" },
          body: { type: "string", description: "Plain text, as it will be sent." },
          title: { type: "string", description: "The card's title, such as “Note to Hotel Orto”." },
        },
        required: ["body"],
        additionalProperties: false,
      },
      call: (input) =>
        withSource(textOf(input, "account"), async ({ account, user, source }) => {
          const replyTo = textOf(input, "reply_to");
          const original = replyTo === "" ? undefined : await source.read(replyTo);
          if (original && !original.ok) return failed(original.failure);
          const answering = original?.value;
          const given = listOf(fieldOf(input, "to"));
          const to = given.length > 0 ? given : answering ? [answering.from.address] : [];
          const subject = textOf(input, "subject") || (answering ? reSubject(answering.subject) : "");
          const body = textOf(input, "body").trim();
          if (body === "" || subject === "" || to.length === 0) {
            return failed("A draft needs who it's to, a subject and a body, or reply_to.");
          }
          const cc = listOf(fieldOf(input, "cc"));
          const saved = await source.draft({
            from: toAddress(user),
            to: to.map((address) => toAddress(address)),
            ...(cc.length > 0 && { cc: cc.map((address) => toAddress(address)) }),
            subject,
            body,
            ...(answering && {
              inReplyTo: answering.messageId,
              references: [...answering.references, answering.messageId],
            }),
          });
          if (!saved.ok) return failed(saved.failure);
          // A new draft for the same mail replaces the one before it, in Drafts and on the Desk.
          const replaced = answering
            ? draftCards().filter(
                (card) => card.draft?.account === account && card.draft.in_reply_to === answering.messageId,
              )
            : [];
          for (const old of replaced) {
            const removed = old.draft ? await source.removeDraft(old.draft.message_id) : ok(undefined);
            if (!removed.ok) info("A replaced draft couldn't be removed", { error: removed.failure });
          }
          const [kept, ...dropped] = replaced;
          for (const old of dropped) desk.removeCard(old.id);
          const fresh: NewCard = {
            kind: "draft",
            title: textOf(input, "title").trim() || draftTitle(to[0] ?? "", answering),
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
            },
          };
          // The new draft takes the old one's place on the Desk, marked changed.
          if (kept) desk.replaceCard(kept.id, fresh);
          const id = kept?.id ?? desk.addCard(fresh).id;
          return { text: `Saved the draft in Drafts and put it on the Desk as ${id}.` };
        }),
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
          if (textOf(input, "to") === "folder") {
            const folder = textOf(input, "folder").trim();
            if (folder === "") return failed("Say which folder, with folder.");
            if (!read.ok) return failed(read.failure);
            const reason = textOf(input, "reason").trim();
            const reference = mailReference(account, read.value);
            const isNew = fieldOf(input, "new_folder") === true;
            const placed = await (isNew
              ? folders.add(reference, folder, reason)
              : folders.place(reference, folder, reason));
            return placed.ok ? { text: placed.value } : failed(placed.failure);
          }
          const to = textOf(input, "to") as Filing;
          const filed = await source.file(id, to);
          if (!filed.ok) return failed(filed.failure);
          if ((to === "archive" || to === "bin") && read.ok) {
            const reason = textOf(input, "reason").trim();
            desk.addDone({
              text: `${to === "bin" ? "Binned" : "Archived"} "${read.value.subject}" from ${senderOf(read.value)}`,
              ...(reason !== "" && { reason }),
              mail: mailReference(account, read.value),
              quiet: false,
              undo: { kind: "mail_filed", account, id, back: "inbox" } satisfies FiledUndo,
            });
          }
          return { text: `Filed it: ${to}.` };
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
          return { text: `Unsubscribed from ${senderOf(read.value)}.` };
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
        return Promise.resolve({ text: `Blocked ${sender}.` });
      },
    },
  ];

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
