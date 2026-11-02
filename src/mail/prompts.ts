import type { Stakes } from "#engine/quick-model.ts";
import type { JsonSchema } from "#engine/engine.ts";
import { plainOf } from "#mail/compose.ts";
import { isSameAddress, type Mail } from "#mail/message.ts";
import type { CalendarItem, Card } from "#protocol/types.ts";
import { fieldOf, textOf } from "#tools/input.ts";

// What Kumo is told about mail: a mail as it reads one, the attention pass that sorts each new mail, and the work
// that follows a mail arriving, a catch-up, sent mail and a draft rewritten on the Desk.

export const catchUpDays = 90;
export const textLimit = 6000;
const sentTextLimit = 2000;

const decisions = ["promotion", "notice", "newsletter", "record", "work", "urgent"] as const;

export type Decision = (typeof decisions)[number];

const stakes: readonly Stakes[] = ["low", "high"];

export type Judgement = {
  readonly decision: Decision;
  readonly stakes: Stakes;
  readonly folder: string;
  readonly reason: string;
  readonly confidence: number;
};

export type SentMail = { readonly account: string; readonly mail: Mail };

export const attentionSchema: JsonSchema = {
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

export const rewriteSchema: JsonSchema = {
  type: "object",
  properties: { body: { type: "string" } },
  required: ["body"],
  additionalProperties: false,
};

// Where the mail asks answers to go, when that isn't its sender.
const replyToLines = ({ from, replyTo = [] }: Mail): readonly string[] =>
  replyTo.every(({ address }) => isSameAddress(address, from.address))
    ? []
    : [`Reply-To: ${replyTo.map(({ address }) => address).join(", ")}`];

// A mail as the agent reads it, with who the sender is in their Contacts when that's known.
export const describe = (account: string, mail: Mail, limit = textLimit, sender?: string): string =>
  [
    `From: ${mail.from.name === undefined ? mail.from.address : `${mail.from.name} <${mail.from.address}>`}`,
    ...(sender === undefined ? [] : [sender]),
    ...replyToLines(mail),
    `To: ${mail.to.map(({ address }) => address).join(", ")}`,
    `Subject: ${mail.subject}`,
    `Date: ${mail.date}`,
    `Account: ${account}, Message-ID: ${mail.messageId}`,
    ...(mail.inReplyTo === undefined ? [] : [`In-Reply-To: ${mail.inReplyTo}`]),
    "",
    mail.text.slice(0, limit),
  ].join("\n");

export const toJudgement = (answer: unknown): Judgement | undefined => {
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

export const attentionPrompt = (
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
    "- newsletter: writing they signed up to read, such as an editorial newsletter. It goes into Newsletters.",
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

export const workPrompt = (
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

export const catchUpPrompt = (lines: readonly string[], part: number, parts: number): string =>
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

export const voicePrompt = (mails: readonly Mail[]): string =>
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

export const sentPrompt = (
  sent: readonly SentMail[],
  cards: readonly Card[],
  blocks: readonly CalendarItem[],
): string =>
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

export const learnPrompt = (card: Card, sent: Mail): string =>
  [
    "They sent a draft you wrote, after changing it. Note what to do differently next time, briefly, under",
    '"Writing as you" on their How to help you page. If the change was only about facts, note nothing.',
    "",
    `Your draft:\n${plainOf(card.draft?.body ?? "")}`,
    "",
    `What they sent:\n${sent.text}`,
  ].join("\n");

// A draft answering a mail is a reply; one written anew is a new mail.
export const rewritePrompt = (draft: string, change: string, isReply: boolean): string =>
  [
    `Rewrite this ${isReply ? "draft reply" : "draft of a new mail"} as asked, in the person's own voice. Keep what's`,
    "right; change only what's asked.",
    "It's light Markdown: keep its formatting, and any picture (![…](…)) where it fits. Their signature is",
    "added after it, so don't sign with it.",
    "",
    `Draft:\n${draft}`,
    "",
    `They asked: ${change}`,
  ].join("\n");
