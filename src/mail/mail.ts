import { createCell } from "#cell.ts";
import { toTimestamp, type Cancel, type Clock } from "#clock.ts";
import type { Fetch } from "#capabilities/connect.ts";
import { valuesSetting, type CheckResult, type Host } from "#capabilities/host.ts";
import type { Values } from "#capabilities/manifest.ts";
import type { DeskKeeper, NewCard } from "#desk/desk.ts";
import type { Complete, JsonSchema } from "#engine/engine.ts";
import type { QuickChoice } from "#engine/quick-model.ts";
import {
  createMailSource,
  type Auth,
  type Filing,
  type Mail,
  type MailSource,
  type SavedWatermark,
  type SourceOptions,
} from "#mail/imap.ts";
import { createOutlookToken } from "#mail/outlook.ts";
import type { Account } from "#mail/providers.ts";
import type { Card, DoneEntry } from "#protocol/types.ts";
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
  readonly catchUp: (onProgress: Progress) => Promise<Result<undefined, string>>;
  readonly hasSource: () => boolean;
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
  readonly work: (prompt: string) => Promise<Result<string, string>>;
  readonly info: Info;
  readonly createSource?: CreateMailSource;
  readonly sentPollMs?: number;
};

const decisions = ["quiet", "work", "urgent"] as const;

type Decision = (typeof decisions)[number];

type Judgement = { readonly decision: Decision; readonly reason: string; readonly confidence: number };

type Config = { readonly account: Account; readonly user: string; readonly auth: Auth; readonly key: string };

type Connection = Config & { readonly source: MailSource; readonly stop: () => void };

type FiledUndo = { readonly kind: "mail_filed"; readonly account: string; readonly id: string; readonly back: Filing };

type BlockedUndo = { readonly kind: "mail_blocked"; readonly sender: string };

export const blockedSetting = "mail_blocked";

export const watermarkSetting = "mail_watermark";

const accounts: readonly Account[] = ["icloud", "outlook", "gmail"];

const dayMs = 24 * 60 * 60 * 1000;
const catchUpDays = 90;
const chunkSize = 100;
const textLimit = 6000;
const sentSample = 30;

const attentionSchema: JsonSchema = {
  type: "object",
  properties: {
    decision: { enum: ["quiet", "work", "urgent"] },
    reason: { type: "string" },
    confidence: { type: "number" },
  },
  required: ["decision", "reason", "confidence"],
  additionalProperties: false,
};

const rewriteSchema: JsonSchema = {
  type: "object",
  properties: { body: { type: "string" } },
  required: ["body"],
  additionalProperties: false,
};

const failed = (text: string): ToolResult => ({ text, isError: true });

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

const describe = (account: string, mail: Mail): string =>
  [
    `From: ${mail.from.name === undefined ? mail.from.address : `${mail.from.name} <${mail.from.address}>`}`,
    `To: ${mail.to.map(({ address }) => address).join(", ")}`,
    `Subject: ${mail.subject}`,
    `Date: ${mail.date}`,
    `Account: ${account}, Message-ID: ${mail.messageId}`,
    "",
    mail.text.slice(0, textLimit),
  ].join("\n");

const toJudgement = (answer: unknown): Judgement | undefined => {
  const decision = fieldOf(answer, "decision");
  const confidence = fieldOf(answer, "confidence");
  return decisions.includes(decision as Decision)
    ? {
        decision: decision as Decision,
        reason: textOf(answer, "reason").trim(),
        confidence: typeof confidence === "number" ? confidence : 0,
      }
    : undefined;
};

const attentionPrompt = (account: string, mail: Mail): string =>
  [
    "You read every mail for the person and decide what it needs. Judge by consequences, not tone: who sent it, a",
    "real deadline, the cost of waiting a day, and whether it touches something they care about.",
    "- quiet: nothing for them to do or know (promotions, receipts with nothing wrong, newsletters, notifications).",
    "- work: something to act on, keep or answer, such as a booking, a bill, a form, or a person writing to them.",
    "- urgent: work that can't wait a few hours, such as a same-day change, a security alert or a closing deadline.",
    "Give the reason in a line and how confident you are, from 0 to 1.",
    "",
    describe(account, mail),
  ].join("\n");

const workPrompt = (account: string, mail: Mail, judged: Judgement): string =>
  [
    `A mail arrived in their ${account} inbox, and you judged it ${judged.decision}: ${judged.reason}`,
    "",
    describe(account, mail),
    "",
    "Do what it needs. Put confirmed bookings on their calendar with add_event, saying in the notes which mail it",
    "came from. Draft any reply with draft, in their voice; it's never sent. File or unsubscribe from noise. Keep",
    "things in motion current, and record what you did with done.",
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

const isFiledUndo = (payload: unknown): payload is FiledUndo => fieldOf(payload, "kind") === "mail_filed";

const isBlockedUndo = (payload: unknown): payload is BlockedUndo => fieldOf(payload, "kind") === "mail_blocked";

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
  info,
  createSource = createMailSource,
  sentPollMs = 5 * 60 * 1000,
}: MailOptions): Mailbox => {
  const connections = createCell<ReadonlyMap<Account, Connection>>(new Map());
  const arrivals = createCell<Promise<void>>(Promise.resolve());
  const restored = createCell<ReadonlySet<string>>(new Set());
  const sentSince = createCell(toTimestamp(clock.now() - dayMs));
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

  const judge = async (account: string, mail: Mail): Promise<Judgement> => {
    const answered = await complete(attentionPrompt(account, mail), attentionSchema, await quickChoice());
    const judged = answered.ok ? toJudgement(answered.value) : undefined;
    if (judged) return judged;
    info("The attention pass couldn't judge a mail, so Kumo looks at it", {
      error: answered.ok ? "an answer out of shape" : answered.failure,
    });
    return { decision: "work", reason: "The attention pass couldn't judge it.", confidence: 0 };
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
    if (isBlocked(mail.from.address) && (await binBlocked(connection, mail))) return;
    const judged = await judge(account, mail);
    if (judged.decision === "quiet") {
      desk.addDone({
        text: `Read "${mail.subject}" from ${senderOf(mail)}: nothing needed`,
        ...(judged.reason !== "" && { reason: judged.reason }),
        mail: mailReference(account, mail),
        quiet: true,
      });
      return;
    }
    const done = await work(workPrompt(account, mail, judged));
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
  };

  const draftCards = (): readonly Card[] => desk.cards().filter((card) => card.kind === "draft" && card.draft);

  const matches = (card: Card, account: string, sent: Mail): boolean => {
    const { draft } = card;
    if (draft?.account !== account || sent.date < card.at) return false;
    if (draft.in_reply_to !== undefined) return sent.inReplyTo === draft.in_reply_to;
    return (
      sent.subject.trim() === draft.subject.trim() &&
      sent.to.some(({ address }) => draft.to.some((wanted) => wanted.toLowerCase() === address.toLowerCase()))
    );
  };

  const watchSent = async (): Promise<void> => {
    const waiting = draftCards();
    if (waiting.length === 0) {
      sentSince.set(toTimestamp(clock.now() - dayMs));
      return;
    }
    const since = sentSince.get();
    sentSince.set(toTimestamp(clock.now()));
    for (const connection of connections.get().values()) {
      const sent = await connection.source.sent(since);
      if (!sent.ok) {
        info("Sent mail couldn't be read", { account: connection.account, error: sent.failure });
        continue;
      }
      for (const mail of sent.value) {
        const card = waiting.find((candidate) => matches(candidate, connection.account, mail));
        if (!card) continue;
        desk.removeCard(card.id);
        const isChanged = mail.text.trim() !== (card.draft?.body ?? "").trim();
        if (isChanged) await work(learnPrompt(card, mail));
      }
    }
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
          const card = desk.addCard({
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
          });
          return { text: `Saved the draft in Drafts and put it on the Desk as ${card.id}.` };
        }),
    },
    {
      name: "file_mail",
      title: "File a mail",
      audience: "work",
      description:
        "Archive, bin, flag or unflag a mail, or move it back to the inbox. Archiving and binning are recorded in " +
        "their Done list with an undo, so don't record them again.",
      inputSchema: {
        type: "object",
        properties: {
          account: accountField,
          message_id: { type: "string" },
          to: { enum: ["archive", "bin", "inbox", "flag", "unflag"] },
          reason: { type: "string" },
        },
        required: ["message_id", "to"],
        additionalProperties: false,
      },
      call: (input) =>
        withSource(textOf(input, "account"), async ({ account, source }) => {
          const id = textOf(input, "message_id");
          const to = textOf(input, "to") as Filing;
          const read = await source.read(id);
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
        properties: { account: accountField, message_id: { type: "string" } },
        required: ["message_id"],
        additionalProperties: false,
      },
      call: (input) =>
        withSource(textOf(input, "account"), async ({ account, source }) => {
          const read = await source.read(textOf(input, "message_id"));
          if (!read.ok) return failed(read.failure);
          const done = await source.unsubscribe(read.value);
          if (!done.ok) return failed(done.failure);
          desk.addDone({
            text: `Unsubscribed from ${senderOf(read.value)}`,
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

  const catchUp = async (onProgress: Progress): Promise<Result<undefined, string>> => {
    const since = toTimestamp(clock.now() - catchUpDays * dayMs);
    const readRecent = async ({ account, source }: Connection): Promise<Result<readonly string[], string>> => {
      const recent = await source.recent(since);
      if (!recent.ok) info("Recent mail couldn't be read", { account, error: recent.failure });
      return recent.ok ? ok(recent.value.map((mail) => summarise(account, mail))) : recent;
    };
    const read = await Promise.all(
      connections
        .get()
        .values()
        .map((connection) => readRecent(connection)),
    );
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
    const sent = await Promise.all(
      connections
        .get()
        .values()
        .map(async ({ source }) => {
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
    hasSource: () => connections.get().size > 0,
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
