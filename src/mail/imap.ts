import { randomUUID } from "node:crypto";
import {
  ImapFlow,
  type CopyResponseObject,
  type FetchMessageObject,
  type ImapFlowError,
  type ListResponse,
  type SearchObject,
} from "imapflow";
import { createCell } from "#cell.ts";
import { systemClock, type Cancel } from "#clock.ts";
import {
  addressKey,
  attachmentIn,
  fromSyntheticMessageId,
  parseMail,
  parseSentBody,
  rankSenders,
  threadIds,
  threadOf,
  toDraftMime,
  toMessageIds,
  uniqueByMessageId,
  type Address,
  type AttachmentContent,
  type Draft,
  type Mail,
  type SentBody,
} from "#mail/message.ts";
import { providers, signInHints, type Account, type Endpoint } from "#mail/providers.ts";
import { unsubscribeFrom, type Unsubscribed } from "#mail/unsubscribe.ts";
import type { Health } from "#problems/problems.ts";
import { fail, ok, type Result } from "#result.ts";

export type { Address, AttachmentContent, Draft, Mail, MailAttachment, SentBody, Unsubscribe } from "#mail/message.ts";
export type { Unsubscribed, UnsubscribeLetter } from "#mail/unsubscribe.ts";
export { providers } from "#mail/providers.ts";

export type Filing = "archive" | "bin" | "inbox" | "flag" | "unflag";

export type MailQuery = {
  readonly from?: string;
  readonly subject?: string;
  readonly text?: string;
  readonly since?: string;
  // inbox, archive, sent, drafts, bin, junk or one of the account's folders by name; when left out, every
  // folder they keep mail in.
  readonly folder?: string;
  readonly limit?: number;
  // The cursor a page gave, for the page after it.
  readonly more?: string;
};

// One page of what a search found, newest first, and how much more there is.
export type MailPage = {
  readonly mails: readonly Mail[];
  // How many match in the folders searched, and how many of those come after this page.
  readonly total: number;
  readonly after: number;
  readonly searched: readonly string[];
  readonly more?: string;
};

export type FolderUse = "inbox" | "archive" | "sent" | "drafts" | "trash" | "junk";

export type FolderCount = {
  readonly name: string;
  readonly use?: FolderUse;
  readonly messages: number;
  readonly unseen: number;
};

export type UidGroup = { readonly folder: string; readonly uids: readonly number[] };

// Mails picked out to move together: each folder's UIDs, and the mails' headers.
export type Batch = { readonly groups: readonly UidGroup[]; readonly mails: readonly Mail[] };

export type Selection = { readonly messageIds: readonly string[] } | { readonly query: MailQuery };

export type Destination = "archive" | "bin" | "inbox" | { readonly folder: string };

// Where a batch went: for each folder it came from, the mails' UIDs in the destination when the server says.
export type MovedBatch = {
  readonly moved: number;
  readonly destination: string;
  readonly placed: readonly { readonly origin: string; readonly uids?: readonly number[] }[];
  // Why it stopped partway, when it did. What moved before is still in placed, so it can be put back.
  readonly failure?: string;
};

export type MoveProgress = (moved: number, total: number) => void;

// What became of the draft a new one replaced: taken out of Drafts, already gone from it, or still there, and why.
export type Replaced = "removed" | "gone" | { readonly failure: string };

// A draft as saved: its Message-ID, the draft as it reads back from Drafts, or why it couldn't be read back, and
// what became of the one it replaced.
export type SavedDraft = {
  readonly messageId: string;
  readonly saved?: Mail;
  readonly unread?: string;
  readonly replaced?: Replaced;
};

// A change to how a mail is marked: read or unread, flagged or not.
export type Marking = { readonly seen?: boolean; readonly flagged?: boolean };

// What marking did, for each Message-ID asked: changed, or not found.
export type Marked = { readonly changed: readonly string[]; readonly missing: readonly string[] };

export type MailSource = {
  readonly account: string;
  readonly check: () => Promise<Result<{ readonly senders: readonly Address[]; readonly folders: number }, string>>;
  // Hands on each new mail in the inbox. Until what onMail gives back settles, the saved watermark stays before
  // that mail, so one a restart cuts off is read again rather than skipped.
  readonly watch: (onMail: (mail: Mail) => Promise<void>) => () => void;
  readonly recent: (since: string) => Promise<Result<readonly Mail[], string>>;
  readonly read: (messageId: string) => Promise<Result<Mail, string>>;
  readonly search: (query: MailQuery) => Promise<Result<MailPage, string>>;
  readonly thread: (messageId: string) => Promise<Result<readonly Mail[], string>>;
  // Saves a draft, reads it back from Drafts, and only then takes out the draft it replaces. A save the server
  // didn't answer in time is looked for before it's tried again, so it's never saved twice.
  readonly draft: (draft: Draft) => Promise<Result<SavedDraft, string>>;
  readonly removeDraft: (messageId: string) => Promise<Result<"removed" | "gone", string>>;
  // Whether the draft with exactly this Message-ID is still in Drafts.
  readonly hasDraft: (messageId: string) => Promise<Result<boolean, string>>;
  readonly file: (messageId: string, filing: Filing) => Promise<Result<undefined, string>>;
  // Marks mails read or unread, flagged or not, by Message-ID, without moving them.
  readonly mark: (messageIds: readonly string[], marking: Marking) => Promise<Result<Marked, string>>;
  // One file a mail carries, by the id its listing gave, read without marking the mail read.
  readonly attachment: (messageId: string, id: string) => Promise<Result<AttachmentContent, string>>;
  // Moves a mail into the folder of that name, making the folder first when the account hasn't one, and gives the
  // folder it was in, so an undo can put it back there.
  readonly fileInto: (messageId: string, folder: string) => Promise<Result<{ readonly origin: string }, string>>;
  // Every folder in the account, with how many mails each holds.
  readonly folders: () => Promise<Result<readonly FolderCount[], string>>;
  // Picks out mails to move together: by Message-ID, or everything a search finds, however many.
  readonly select: (selection: Selection) => Promise<Result<Batch, string>>;
  // Moves mails a folder at a time, with one UID MOVE per chunk, making a named folder first if it's missing.
  readonly move: (
    groups: readonly UidGroup[],
    destination: Destination,
    onProgress?: MoveProgress,
  ) => Promise<Result<MovedBatch, string>>;
  // Whether they've ever written to an address, or to anyone at a domain.
  readonly hasWritten: (address: string) => Promise<Result<boolean, string>>;
  // The addresses they send from, the most used first, each with the name they send under, from their last mails in
  // Sent: their aliases too, once they've sent from them.
  readonly senders: () => Promise<Result<readonly Address[], string>>;
  // The address they last wrote to someone from, from Sent, or undefined when they never have.
  readonly lastFrom: (address: string) => Promise<Result<string | undefined, string>>;
  // Leaves the list a mail came from by its one-click link, or gives the mail that leaves a list which only takes
  // mail, for them to send.
  readonly unsubscribe: (mail: Mail) => Promise<Result<Unsubscribed, string>>;
  readonly sent: (since: string) => Promise<Result<readonly Mail[], string>>;
  // The last few mails in Sent, whole, newest first, for learning their signature.
  readonly sentBodies: (limit: number) => Promise<Result<readonly SentBody[], string>>;
  readonly close: () => Promise<void>;
};

export type Auth = { readonly password: string } | { readonly accessToken: () => Promise<Result<string, string>> };

export type SourceOptions = {
  readonly account: Account;
  readonly user: string;
  readonly auth: Auth;
  readonly imap?: Endpoint;
  readonly fetch?: typeof fetch;
  readonly logger?: (message: string, details: Readonly<Record<string, unknown>>) => void;
  readonly watermark?: SavedWatermark;
  readonly onWatermark?: (watermark: SavedWatermark) => void;
  readonly onHealth?: (health: Health) => void;
  // How long one try at reading or changing mail may take before the server counts as not answering.
  readonly attemptMs?: number;
};

export type SavedWatermark = { readonly uidValidity: string; readonly next: number };

type Credentials =
  { readonly user: string; readonly pass: string } | { readonly user: string; readonly accessToken: string };

type Folders = {
  readonly inbox: string;
  readonly list: readonly ListResponse[];
  readonly archive?: string;
  readonly sent?: string;
  readonly drafts?: string;
  readonly trash?: string;
  readonly junk?: string;
  // Every folder that holds mail they received, the inbox first: their own folders and the archive, but not
  // Sent, Drafts, Trash or Junk. Gmail's All Mail already holds every label.
  readonly received: readonly string[];
  readonly count: number;
};

type Session = { readonly client: ImapFlow; readonly folders: Folders };

type Place = { readonly folder: string; readonly uid: number };

type Found = { readonly place: Place; readonly mail: Mail };

type Watermark = { readonly uidValidity: bigint; readonly next: number };

// How many mails of a batch moved from one folder, and their UIDs in the destination while the server says.
type Landed = { readonly count: number; readonly uids: readonly number[] | undefined };

const pageSize = 20;
const mostPerPage = 50;
// UIDs per MOVE, and Message-IDs per search, so no command grows past what servers accept.
const moveChunkSize = 250;
const idChunk = 25;
const addressSample = 200;
// How many of their latest mails to someone are looked at for one really to them, as IMAP's TO search matches part
// of an address.
const lastFromSample = 10;
const idleRestartMs = 4 * 60_000;
const firstRetryMs = 1000;
const lastRetryMs = 5 * 60_000;
const inboxPath = "INBOX";
const notReceived: ReadonlySet<string> = new Set([
  "\\Sent",
  "\\Drafts",
  "\\Trash",
  "\\Junk",
  "\\Flagged",
  "\\Important",
]);
// Folders some servers list that never hold received mail, such as Outlook's Outbox and Exchange's own.
const notMail = /^(?:notes|outbox|conversation history|sync issues|rss feeds|rss subscriptions)$/iu;
const gone = "That mail isn't in this account any more.";
// One try at reading or changing one mail gets this long, a search or a thread a little longer, and work over many
// mails, such as a catch-up or a batch move, longer still; a slow server is tried once more on a fresh connection.
const attemptLimitMs = 40_000;
const searchLimitMs = 90_000;
const bulkLimitMs = 4 * 60_000;
const connectLimitMs = 30_000;
// How many candidates a Message-ID search may give before they're checked, and how many of a folder's newest mails
// are looked through by their envelopes when the server's search hasn't caught up, as Exchange's can lag.
const mostCandidates = 50;
const scanDepth = 200;
// Where a mail was last seen, by Message-ID, so a mail a search found is read from where it was, checked first.
const mostPlaces = 2000;

export const backoffMs = (attempt: number): number =>
  Math.min(firstRetryMs * 2 ** Math.max(0, attempt - 1), lastRetryMs);

export const toUidSet = (uids: readonly number[]): string =>
  [...new Set(uids)]
    .toSorted((left, right) => left - right)
    .reduce<readonly (readonly [number, number])[]>((runs, uid) => {
      const last = runs.at(-1);
      return last?.[1] === uid - 1 ? [...runs.slice(0, -1), [last[0], uid]] : [...runs, [uid, uid]];
    }, [])
    .map(([first, last]) => (first === last ? String(first) : `${String(first)}:${String(last)}`))
    .join(",");

export const fromUidSet = (text: string): readonly number[] =>
  text.split(",").flatMap((part) => {
    const [first = NaN, last = first] = part.split(":").map(Number);
    return Number.isSafeInteger(first) && Number.isSafeInteger(last) && first <= last
      ? Array.from({ length: last - first + 1 }, (_, index) => first + index)
      : [];
  });

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));

type Late = { readonly isLate: true };

const late: Late = { isLate: true };

const isLate = (value: unknown): value is Late => value === late;

// The work, or Late once it has taken longer than it may.
const inTime = async <Value>(work: Promise<Value>, limitMs: number): Promise<Value | Late> => {
  const timer = createCell<ReturnType<typeof setTimeout> | undefined>(undefined);
  const expiry = new Promise<Late>((resolve) => {
    timer.set(
      setTimeout(() => {
        resolve(late);
      }, limitMs),
    );
  });
  try {
    return await Promise.race([work, expiry]);
  } finally {
    clearTimeout(timer.get());
  }
};

// Said when a save was cut short and Drafts couldn't be asked whether it was kept.
const unknown = (reason: string): string =>
  `Mail couldn't finish saving the draft: ${reason} It couldn't be checked whether the draft was kept, and the ` +
  "earlier draft is untouched. Look in Drafts before trying again.";

// How one try went: done, with its result, or cut short, as the server didn't answer in time or the connection
// dropped, so whatever it was doing may or may not have happened.
type Tried<Value> = { readonly done: Result<Value, string> } | { readonly cut: string };

// Whether an envelope's Message-ID is exactly this one.
const isSameId = (header: string | undefined, messageId: string): boolean => toMessageIds(header)[0] === messageId;

const specialPath = (list: readonly ListResponse[], use: string): string | undefined =>
  list.find((entry) => entry.specialUse === use)?.path;

const present = (folders: readonly (string | undefined)[]): readonly string[] => [
  ...new Set(folders.filter((folder) => folder !== undefined)),
];

const isSelectable = (entry: ListResponse): boolean =>
  !entry.flags.has("\\Noselect") && !entry.flags.has("\\NonExistent");

const isReceived = (entry: ListResponse): boolean =>
  isSelectable(entry) && !notReceived.has(entry.specialUse ?? "") && !notMail.test(entry.name);

const toFolders = (list: readonly ListResponse[]): Folders => {
  const inbox = specialPath(list, "\\Inbox") ?? inboxPath;
  const all = specialPath(list, "\\All");
  return {
    inbox,
    list,
    archive: specialPath(list, "\\Archive") ?? all,
    sent: specialPath(list, "\\Sent"),
    drafts: specialPath(list, "\\Drafts"),
    trash: specialPath(list, "\\Trash"),
    junk: specialPath(list, "\\Junk"),
    received: all === undefined ? present([inbox, ...list.filter(isReceived).map(({ path }) => path)]) : [inbox, all],
    count: list.filter((entry) => !entry.flags.has("\\Noselect")).length,
  };
};

const toIso = (value: Date | string | undefined): string | undefined => {
  const date = value === undefined ? undefined : new Date(value);
  return date === undefined || Number.isNaN(date.getTime()) ? undefined : date.toISOString();
};

const parseDate = (text: string): Date | undefined => {
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? undefined : date;
};

const byDate = (left: Mail, right: Mail): number => left.date.localeCompare(right.date);

const newestFirst = (uids: readonly number[]): readonly number[] => uids.toSorted((left, right) => right - left);

type Dated = { readonly mail: Mail; readonly at: string };

// A folder's mails newest first by UID, each dated no later than the one before. Sorted by these dates, a page
// takes each folder's mails in UID order, so a folder's cursor never passes one that wasn't shown, even when mail
// filed into it later carries an older date.
const inUidOrder = (mails: readonly Mail[]): readonly Dated[] =>
  mails
    .toSorted((left, right) => right.uid - left.uid)
    .reduce<readonly Dated[]>((dated, mail) => {
      const before = dated.at(-1)?.at;
      return [...dated, { mail, at: before !== undefined && before < mail.date ? before : mail.date }];
    }, []);

type Page = { readonly shown: readonly Mail[]; readonly taken: readonly Mail[] };

// The newest of each folder's mails, up to the limit, and every mail passed on the way, such as a second copy of
// one or one marked deleted, so each folder's cursor moves past them too.
const takePage = (folders: readonly (readonly Mail[])[], limit: number): Page =>
  folders
    .flatMap((mails) => inUidOrder(mails))
    .toSorted((left, right) => right.at.localeCompare(left.at))
    .reduce<Page>(
      (page, { mail }) => {
        if (page.shown.length >= limit) return page;
        const isShown =
          !mail.flags.includes("\\Deleted") && page.shown.every(({ messageId }) => messageId !== mail.messageId);
        return { shown: isShown ? [...page.shown, mail] : page.shown, taken: [...page.taken, mail] };
      },
      { shown: [], taken: [] },
    );

const chunked = <Value>(values: readonly Value[], size: number): readonly (readonly Value[])[] =>
  Array.from({ length: Math.ceil(values.length / size) }, (_, index) => values.slice(index * size, (index + 1) * size));

type Cursor = Readonly<Record<string, number>>;

const toCursor = (cursor: Cursor): string => Buffer.from(JSON.stringify(cursor)).toString("base64url");

const fromCursor = (text: string | undefined): Result<Cursor, string> => {
  if (text === undefined || text === "") return ok({});
  try {
    const value = JSON.parse(Buffer.from(text, "base64url").toString("utf8")) as unknown;
    const isCursor =
      typeof value === "object" &&
      value !== null &&
      Object.values(value).every((uid) => typeof uid === "number" && Number.isSafeInteger(uid));
    return isCursor ? ok(value as Cursor) : fail(`"${text}" isn't a cursor a search gave.`);
  } catch {
    return fail(`"${text}" isn't a cursor a search gave.`);
  }
};

const uses: Readonly<Record<string, FolderUse>> = {
  "\\Inbox": "inbox",
  "\\Archive": "archive",
  "\\All": "archive",
  "\\Sent": "sent",
  "\\Drafts": "drafts",
  "\\Trash": "trash",
  "\\Junk": "junk",
};

const byIdHeader = (name: string, id: string): SearchObject => ({ header: { [name]: `<${id}>` } });

const domainOf = (address: string): string => address.split("@", 2)[1] ?? "ito.invalid";

const ignore = (): void => undefined;

const droppedCodes: ReadonlySet<string> = new Set(["NoConnection", "EConnectionClosed"]);

const isDropped = (client: ImapFlow, error: unknown): boolean =>
  !client.usable || (error instanceof Error && droppedCodes.has((error as ImapFlowError).code ?? ""));

const signOff = async (client: ImapFlow): Promise<void> => {
  try {
    await client.logout();
  } catch {
    client.close();
  }
};

const inFolder = async <Value>(client: ImapFlow, folder: string, work: () => Promise<Value>): Promise<Value> => {
  const lock = await client.getMailboxLock(folder);
  try {
    return await work();
  } finally {
    lock.release();
  }
};

export const createMailSource = (options: SourceOptions): MailSource => {
  const { account, user } = options;
  const imap = options.imap ?? providers[account].imap;
  const sessions = createCell<Promise<Result<Session, string>> | undefined>(undefined);
  const watchers = createCell<ReadonlySet<() => void>>(new Set());
  const places = createCell<ReadonlyMap<string, Place>>(new Map());
  const limitOf = (limitMs: number): number => options.attemptMs ?? limitMs;
  const lateText = `${imap.host} didn't answer in time.`;

  // Where a mail was seen, by its Message-ID, the newest kept.
  const rememberAll = (seen: readonly (readonly [string, Place])[]): void => {
    const real = seen.filter(([messageId]) => fromSyntheticMessageId(messageId) === undefined);
    if (real.length === 0) return;
    const fresh = new Set(real.map(([messageId]) => messageId));
    places.update((all) => new Map([...[...all].filter(([id]) => !fresh.has(id)), ...real].slice(-mostPlaces)));
  };

  const remember = (messageId: string, place: Place): void => {
    rememberAll([[messageId, place]]);
  };

  const log = (message: string, details: Readonly<Record<string, unknown>>): void => {
    options.logger?.(message, { account, ...details });
  };

  const imapLogger =
    options.logger === undefined
      ? false
      : {
          debug: ignore,
          info: ignore,
          warn: (entry: unknown) => {
            log("Mail connection warning", { entry });
          },
          error: (entry: unknown) => {
            log("Mail connection error", { entry });
          },
        };

  const explain = (error: unknown): string => {
    const details = error instanceof Error ? (error as ImapFlowError) : undefined;
    if (details?.authenticationFailed === true) {
      return `${imap.host} didn't accept the sign-in for ${user}. ${signInHints[account]}`;
    }
    switch (details?.code ?? "") {
      case "ENOTFOUND":
      case "EAI_AGAIN": {
        return `${imap.host} couldn't be found; the network may be down.`;
      }
      case "ECONNREFUSED":
      case "ECONNRESET":
      case "EPIPE": {
        return `${imap.host} couldn't be reached: ${describe(error)}`;
      }
      case "CONNECT_TIMEOUT":
      case "GREETING_TIMEOUT":
      case "ETIMEDOUT":
      case "ETIMEOUT": {
        return lateText;
      }
      default: {
        return details?.responseText ?? describe(error);
      }
    }
  };

  const credentials = async (): Promise<Result<Credentials, string>> => {
    if ("password" in options.auth) return ok({ user, pass: options.auth.password });
    const token = await options.auth.accessToken();
    return token.ok ? ok({ user, accessToken: token.value }) : fail(`Couldn't sign in to ${account}: ${token.failure}`);
  };

  const health = (next: Health): void => {
    options.onHealth?.(next);
  };

  const openClient = async (watching: boolean): Promise<Result<ImapFlow, string>> => {
    const signIn = await credentials();
    if (!signIn.ok) {
      health({ ok: false, reason: signIn.failure, isAuth: true });
      return signIn;
    }
    const client = new ImapFlow({
      host: imap.host,
      port: imap.port,
      secure: imap.secure,
      auth: signIn.value,
      logger: imapLogger,
      clientInfo: { name: "Ito" },
      connectionTimeout: connectLimitMs,
      disableAutoIdle: watching,
      maxIdleTime: idleRestartMs,
    });
    client.on("error", (error) => {
      log("Mail connection failed", { reason: explain(error) });
    });
    try {
      await client.connect();
      health({ ok: true });
      return ok(client);
    } catch (error) {
      client.close();
      const isAuth = error instanceof Error && (error as ImapFlowError).authenticationFailed === true;
      health({ ok: false, reason: explain(error), isAuth });
      return fail(explain(error));
    }
  };

  const openSession = async (): Promise<Result<Session, string>> => {
    const opened = await openClient(false);
    if (!opened.ok) return opened;
    try {
      return ok({ client: opened.value, folders: toFolders(await opened.value.list()) });
    } catch (error) {
      opened.value.close();
      return fail(explain(error));
    }
  };

  const session = async (): Promise<Result<Session, string>> => {
    const current = sessions.get();
    const settled = await current;
    if (settled?.ok === true && settled.value.client.usable) return settled;
    const next = sessions.get() === current ? openSession() : (sessions.get() ?? openSession());
    sessions.set(next);
    return next;
  };

  // One try at some work, bounded in time. A try the server didn't answer in time closes the connection, so the
  // next starts on a fresh one rather than queueing behind it.
  const attempt = async <Value>(
    doing: string,
    work: (opened: Session) => Promise<Result<Value, string>>,
    limitMs = attemptLimitMs,
  ): Promise<Tried<Value>> => {
    const opened = await session();
    if (!opened.ok) return opened.failure === lateText ? { cut: lateText } : { done: opened };
    const { client } = opened.value;
    try {
      const answered = await inTime(work(opened.value), limitOf(limitMs));
      if (!isLate(answered)) return { done: answered };
      log("The mail server didn't answer in time, so the connection is closed", { doing, limitMs: limitOf(limitMs) });
      client.close();
      return { cut: lateText };
    } catch (error) {
      const reason = explain(error);
      if (reason === lateText || isDropped(client, error)) {
        client.close();
        return { cut: reason };
      }
      log("Mail work failed", { doing, reason });
      return { done: fail(`Mail couldn't finish ${doing}: ${reason}`) };
    }
  };

  // Work that's safe to do twice, such as reading, or a change that finds its mail again each time, gets a second try
  // on a fresh connection when the first is cut short; other work says it may or may not have happened.
  const run = async <Value>(
    doing: string,
    work: (opened: Session) => Promise<Result<Value, string>>,
    isRepeatable = false,
    limitMs = attemptLimitMs,
  ): Promise<Result<Value, string>> => {
    const first = await attempt(doing, work, limitMs);
    if ("done" in first) return first.done;
    if (!isRepeatable) {
      return fail(
        `Mail couldn't finish ${doing}: ${first.cut} It may or may not have happened, so look before trying again.`,
      );
    }
    log("The mail server didn't finish, so it's tried again on a fresh connection", { doing, reason: first.cut });
    const second = await attempt(doing, work, limitMs);
    return "done" in second
      ? second.done
      : fail(`Mail couldn't finish ${doing}, tried twice: ${second.cut} Trying again later is safe.`);
  };

  const runReading = <Value>(
    doing: string,
    work: (opened: Session) => Promise<Result<Value, string>>,
    limitMs = attemptLimitMs,
  ): Promise<Result<Value, string>> => run(doing, work, true, limitMs);

  const toMailFrom = async (message: FetchMessageObject, folder: string): Promise<Mail | undefined> => {
    const raw = message.source ?? message.headers;
    if (raw === undefined) return undefined;
    const receivedAt = toIso(message.internalDate);
    const mail = await parseMail(raw, {
      account,
      folder,
      uid: message.uid,
      flags: [...(message.flags ?? [])],
      ...(receivedAt !== undefined && { receivedAt }),
      ...(message.source === undefined && { isHeaders: true }),
    });
    return mail;
  };

  const fetchMails = async (
    client: ImapFlow,
    folder: string,
    range: string | SearchObject,
    isHeadersOnly = false,
  ): Promise<readonly Mail[]> => {
    if (range === "") return [];
    const mails = createCell<readonly Mail[]>([]);
    const part = isHeadersOnly ? { headers: true } : { source: true };
    const messages = client.fetch(range, { uid: true, flags: true, internalDate: true, ...part }, { uid: true });
    for await (const message of messages) {
      const mail = await toMailFrom(message, folder);
      if (mail !== undefined) mails.update((current) => [...current, mail]);
    }
    rememberAll(mails.get().map(({ messageId, uid }) => [messageId, { folder, uid }] as const));
    return mails.get();
  };

  const searchUids = async (client: ImapFlow, query: SearchObject): Promise<Result<readonly number[], string>> => {
    const found = await client.search(query, { uid: true });
    return found === false ? fail("The mail server refused the search.") : ok(found ?? []);
  };

  const mailsIn = async (
    client: ImapFlow,
    folders: readonly string[],
    query: SearchObject,
    isHeadersOnly = false,
  ): Promise<Result<readonly Mail[], string>> => {
    const collected = createCell<readonly Mail[]>([]);
    for (const folder of folders) {
      const found = await inFolder(client, folder, async (): Promise<Result<readonly Mail[], string>> => {
        const uids = await searchUids(client, query);
        return uids.ok ? ok(await fetchMails(client, folder, toUidSet(uids.value), isHeadersOnly)) : uids;
      });
      if (!found.ok) return found;
      collected.update((current) => [...current, ...found.value]);
    }
    return ok(uniqueByMessageId(collected.get()));
  };

  // Of these UIDs in the open folder, the ones whose Message-ID is exactly this one, newest first. A server's search
  // can match more loosely than that: IMAP's is a substring match, and Exchange answers from its search index.
  const exactly = async (client: ImapFlow, uids: readonly number[], messageId: string): Promise<readonly number[]> => {
    if (uids.length === 0) return [];
    const picked = newestFirst(uids).slice(0, mostCandidates);
    const messages = await client.fetchAll(toUidSet(picked), { uid: true, envelope: true }, { uid: true });
    return newestFirst(
      messages.filter(({ envelope }) => isSameId(envelope?.messageId, messageId)).map(({ uid }) => uid),
    );
  };

  // The newest of the open folder's last mails with this Message-ID, read from their envelopes, for a mail the
  // server's search hasn't caught up with yet, such as a draft just saved or a mail just sent.
  const scanned = async (client: ImapFlow, messageId: string): Promise<number | undefined> => {
    const exists = client.mailbox === false ? 0 : client.mailbox.exists;
    if (exists === 0) return undefined;
    const range = `${String(Math.max(1, exists - scanDepth + 1))}:*`;
    const messages = await client.fetchAll(range, { uid: true, envelope: true });
    const [uid] = newestFirst(
      messages.filter(({ envelope }) => isSameId(envelope?.messageId, messageId)).map((message) => message.uid),
    );
    return uid;
  };

  // Whether the mail is still where it was seen. Where it was may be gone, such as a folder since deleted; then it's
  // looked for afresh.
  const isStillAt = async (client: ImapFlow, { folder, uid }: Place, messageId: string): Promise<boolean> => {
    try {
      const found = await inFolder(client, folder, () => exactly(client, [uid], messageId));
      return found.length > 0;
    } catch {
      return false;
    }
  };

  // Where a mail with exactly this Message-ID is, in the first of these folders that has it: where it was last seen,
  // when it's still there, or else as the server's search finds it, every match checked, or failing that, among the
  // newest mails of the inbox, Drafts and Sent. A mail is never taken for another that only resembles it.
  const locate = async (
    opened: Session,
    folders: readonly string[],
    messageId: string,
  ): Promise<Result<Place | undefined, string>> => {
    const { client } = opened;
    const synthetic = fromSyntheticMessageId(messageId);
    if (synthetic !== undefined) return ok(synthetic);
    const seen = places.get().get(messageId);
    if (seen !== undefined && folders.includes(seen.folder) && (await isStillAt(client, seen, messageId)))
      return ok(seen);
    for (const folder of folders) {
      const found = await inFolder(client, folder, async (): Promise<Result<number | undefined, string>> => {
        const uids = await searchUids(client, byIdHeader("message-id", messageId));
        if (!uids.ok) return uids;
        const [uid] = await exactly(client, uids.value, messageId);
        return ok(uid);
      });
      if (!found.ok) return found;
      if (found.value !== undefined) {
        remember(messageId, { folder, uid: found.value });
        return ok({ folder, uid: found.value });
      }
    }
    const { inbox, drafts, sent } = opened.folders;
    const recent = present([drafts, sent, inbox]).filter((candidate) => folders.includes(candidate));
    for (const folder of recent) {
      const uid = await inFolder(client, folder, () => scanned(client, messageId));
      if (uid !== undefined) {
        remember(messageId, { folder, uid });
        return ok({ folder, uid });
      }
    }
    return ok(undefined);
  };

  // Every folder a mail can be found in by its Message-ID, Sent last: a copy of their own there, such as of a mail
  // they sent themselves or a list they're on, is only taken when there's no other.
  const everywhere = ({ folders }: Session): readonly string[] =>
    present([...folders.received, folders.archive, folders.drafts, folders.junk, folders.trash, folders.sent]);

  const kept = ({ folders }: Session): readonly string[] =>
    present([...folders.received, folders.archive, folders.sent]);

  const findMail = async (opened: Session, messageId: string): Promise<Result<Found, string>> => {
    const place = await locate(opened, everywhere(opened), messageId);
    if (!place.ok) return place;
    if (place.value === undefined) return fail(gone);
    const { folder, uid } = place.value;
    const [mail] = await inFolder(opened.client, folder, () => fetchMails(opened.client, folder, String(uid)));
    return mail === undefined ? fail(gone) : ok({ place: place.value, mail });
  };

  const threadIdAt = async ({ client }: Session, { folder, uid }: Place): Promise<string | undefined> => {
    if (!client.capabilities.has("X-GM-EXT-1") && !client.capabilities.has("OBJECTID")) return undefined;
    const message = await inFolder(client, folder, () =>
      client.fetchOne(String(uid), { uid: true, threadId: true }, { uid: true }),
    );
    return message === false ? undefined : message.threadId;
  };

  const sinceQuery = (since: string): Result<SearchObject, string> => {
    const date = parseDate(since);
    return date === undefined ? fail(`"${since}" isn't a date.`) : ok({ since: date });
  };

  const deleteDraft = async (opened: Session, messageId: string): Promise<Result<boolean, string>> => {
    const { drafts } = opened.folders;
    if (drafts === undefined) return fail("This account has no Drafts folder.");
    const place = await locate(opened, [drafts], messageId);
    if (!place.ok) return place;
    if (place.value?.folder !== drafts) return ok(false);
    const { uid } = place.value;
    const deleted = await inFolder(opened.client, drafts, () =>
      opened.client.messageDelete(String(uid), { uid: true }),
    );
    if (deleted) places.update((all) => new Map([...all].filter(([id]) => id !== messageId)));
    return deleted ? ok(true) : fail("The mail server didn't delete the draft.");
  };

  const moveOne = async (
    opened: Session,
    place: Place,
    target: string | undefined,
    name: string,
  ): Promise<Result<undefined, string>> => {
    if (target === undefined) return fail(`This account has no ${name} folder.`);
    if (place.folder === target) return ok(undefined);
    const moved = await inFolder(opened.client, place.folder, () =>
      opened.client.messageMove(String(place.uid), target, { uid: true }),
    );
    return moved === false ? fail(`The mail server didn't move the mail to ${name}.`) : ok(undefined);
  };

  // Sets or clears the mail's flags, such as \\Seen for read and \\Flagged for Mail's flag, where it is.
  const setMarks = async (opened: Session, place: Place, marking: Marking): Promise<Result<undefined, string>> => {
    const wanted = [
      ...(marking.seen === undefined ? [] : [["\\Seen", marking.seen] as const]),
      ...(marking.flagged === undefined ? [] : [["\\Flagged", marking.flagged] as const]),
    ];
    const added = wanted.filter(([, isOn]) => isOn).map(([name]) => name);
    const removed = wanted.filter(([, isOn]) => !isOn).map(([name]) => name);
    const range = String(place.uid);
    const changed = await inFolder(opened.client, place.folder, async () => {
      const isAdded = added.length === 0 || (await opened.client.messageFlagsAdd(range, added, { uid: true }));
      const isRemoved = removed.length === 0 || (await opened.client.messageFlagsRemove(range, removed, { uid: true }));
      return isAdded && isRemoved;
    });
    return changed ? ok(undefined) : fail("The mail server didn't change how the mail is marked.");
  };

  const flag = (opened: Session, place: Place, isOn: boolean): Promise<Result<undefined, string>> =>
    setMarks(opened, place, { flagged: isOn });

  const fileAt = (opened: Session, place: Place, filing: Filing): Promise<Result<undefined, string>> => {
    switch (filing) {
      case "archive": {
        return moveOne(opened, place, opened.folders.archive, "Archive");
      }
      case "bin": {
        return moveOne(opened, place, opened.folders.trash, "Trash");
      }
      case "inbox": {
        return moveOne(opened, place, opened.folders.inbox, "Inbox");
      }
      case "flag": {
        return flag(opened, place, true);
      }
      case "unflag": {
        return flag(opened, place, false);
      }
    }
  };

  const sendersIn = async (opened: Session): Promise<readonly Address[]> => {
    const { sent } = opened.folders;
    if (sent === undefined) return [];
    const written = await inFolder(opened.client, sent, async () => {
      const exists = opened.client.mailbox === false ? 0 : opened.client.mailbox.exists;
      if (exists === 0) return [];
      const range = `${String(Math.max(1, exists - addressSample + 1))}:*`;
      const messages = await opened.client.fetchAll(range, { envelope: true });
      return messages.flatMap(({ envelope }) =>
        (envelope?.from ?? []).map(({ address = "", name }) => ({
          address: address.toLowerCase(),
          ...(name !== undefined && { name }),
        })),
      );
    });
    return rankSenders(written);
  };

  const check: MailSource["check"] = async () => {
    const previous = await sessions.get();
    if (previous?.ok === true) previous.value.client.close();
    sessions.set(openSession());
    return run(
      "checking the account",
      async (opened) => ok({ senders: await sendersIn(opened), folders: opened.folders.count }),
      false,
      bulkLimitMs,
    );
  };

  const watch: MailSource["watch"] = (onMail) => {
    const isStopped = createCell(false);
    const current = createCell<ImapFlow | undefined>(undefined);
    const retry = createCell<Cancel | undefined>(undefined);
    const attempts = createCell(0);
    const saved = options.watermark;
    const watermark = createCell<Watermark | undefined>(
      saved === undefined ? undefined : { uidValidity: BigInt(saved.uidValidity), next: saved.next },
    );
    // The UIDs of mails handed on and not yet handled.
    const handling = createCell<ReadonlySet<number>>(new Set());
    const save = (): void => {
      const mark = watermark.get();
      if (mark === undefined) return;
      const next = Math.min(mark.next, ...handling.get());
      options.onWatermark?.({ uidValidity: mark.uidValidity.toString(), next });
    };
    const setMark = (next: Watermark): void => {
      if (next.uidValidity !== watermark.get()?.uidValidity) handling.set(new Set());
      watermark.set(next);
      save();
    };
    const handled = (uid: number): void => {
      handling.update((current) => new Set([...current].filter((pending) => pending !== uid)));
      save();
    };
    const handOn = async (mail: Mail): Promise<void> => {
      try {
        await onMail(mail);
      } catch (error) {
        log("A new mail's listener failed", { reason: describe(error) });
      }
      handled(mail.uid);
    };
    const queue = createCell<Promise<void>>(Promise.resolve());

    const idle = async (client: ImapFlow): Promise<void> => {
      if (isStopped.get() || current.get() !== client) return;
      try {
        await client.idle({ whenFree: true });
      } catch (error) {
        log("Mail IDLE stopped", { reason: explain(error) });
      }
    };

    const drain = async (client: ImapFlow): Promise<void> => {
      const mark = watermark.get();
      if (mark === undefined || isStopped.get()) return;
      const mails = await fetchMails(client, inboxPath, `${String(mark.next)}:*`);
      const arrived = mails.filter((mail) => mail.uid >= mark.next).toSorted((left, right) => left.uid - right.uid);
      handling.update((current) => new Set([...current, ...arrived.map(({ uid }) => uid)]));
      const last = arrived.at(-1);
      if (last !== undefined) setMark({ ...mark, next: last.uid + 1 });
      for (const mail of arrived) {
        if (isStopped.get()) return;
        void handOn(mail);
      }
    };

    const enqueue = (client: ImapFlow): void => {
      const previous = queue.get();
      const next = async (): Promise<void> => {
        await previous;
        try {
          await drain(client);
        } catch (error) {
          log("Mail arrival couldn't be read", { reason: explain(error) });
        }
        void idle(client);
      };
      queue.set(next());
    };

    const reconnect = (reason: string): void => {
      if (isStopped.get()) return;
      const attempt = attempts.update((count) => count + 1);
      const delayMs = backoffMs(attempt);
      log("Mail watch reconnecting", { reason, attempt, delayMs });
      retry.set(systemClock.after(delayMs, start));
    };

    const begin = async (client: ImapFlow): Promise<void> => {
      const mailbox = await client.mailboxOpen(inboxPath);
      const mark = watermark.get();
      if (mark?.uidValidity !== mailbox.uidValidity) {
        setMark({ uidValidity: mailbox.uidValidity, next: mailbox.uidNext });
      }
      attempts.set(0);
      client.on("exists", () => {
        enqueue(client);
      });
      enqueue(client);
    };

    const connect = async (): Promise<void> => {
      if (isStopped.get()) return;
      const opened = await openClient(true);
      if (!opened.ok) {
        reconnect(opened.failure);
        return;
      }
      const client = opened.value;
      if (isStopped.get()) {
        client.close();
        return;
      }
      current.set(client);
      client.on("close", () => {
        if (current.get() !== client) return;
        current.set(undefined);
        reconnect("The connection closed.");
      });
      try {
        await begin(client);
      } catch (error) {
        log("Mail watch couldn't open the inbox", { reason: explain(error) });
        client.close();
      }
    };

    const stop = (): void => {
      if (isStopped.get()) return;
      isStopped.set(true);
      retry.get()?.();
      const client = current.get();
      current.set(undefined);
      watchers.update((all) => new Set([...all].filter((watcher) => watcher !== stop)));
      if (client !== undefined) void signOff(client);
    };

    const start = (): void => {
      void connect();
    };

    watchers.update((all) => new Set([...all, stop]));
    start();
    return stop;
  };

  const recent: MailSource["recent"] = (since) =>
    runReading(
      "reading recent mail",
      async (opened) => {
        const query = sinceQuery(since);
        if (!query.ok) return query;
        const { received, archive } = opened.folders;
        const mails = await mailsIn(opened.client, present([...received, archive]), query.value, true);
        return mails.ok ? ok(mails.value.filter((mail) => !mail.flags.includes("\\Draft")).toSorted(byDate)) : mails;
      },
      bulkLimitMs,
    );

  const read: MailSource["read"] = (messageId) =>
    runReading("reading the mail", async (opened) => {
      const found = await findMail(opened, messageId);
      return found.ok ? ok(found.value.mail) : found;
    });

  const folderNamed = ({ folders }: Session, name: string): string | undefined => {
    const wanted = name.trim().toLowerCase();
    return folders.list.find(
      (entry) => isSelectable(entry) && (entry.name.toLowerCase() === wanted || entry.path.toLowerCase() === wanted),
    )?.path;
  };

  const folderList = ({ folders }: Session): string =>
    folders.list
      .filter(isSelectable)
      .map(({ path }) => path)
      .join(", ");

  // The folders a search or a batch looks in: one by its role or name, or by default every folder they keep mail in.
  const scopeOf = (
    opened: Session,
    folder: string | undefined,
    all: readonly string[],
  ): Result<readonly string[], string> => {
    const wanted = folder?.trim() ?? "";
    if (wanted === "") return ok(all);
    const { inbox, archive, sent, drafts, trash, junk } = opened.folders;
    const roles: ReadonlyMap<string, string | undefined> = new Map([
      ["inbox", inbox],
      ["archive", archive],
      ["sent", sent],
      ["drafts", drafts],
      ["bin", trash],
      ["trash", trash],
      ["junk", junk],
    ]);
    const role = roles.get(wanted.toLowerCase());
    if (role !== undefined) return ok([role]);
    if (roles.has(wanted.toLowerCase())) return fail(`This account has no ${wanted} folder.`);
    const named = folderNamed(opened, wanted);
    return named === undefined
      ? fail(`There's no folder called ${wanted}. The account's folders: ${folderList(opened)}.`)
      : ok([named]);
  };

  const criteriaOf = (query: MailQuery): Result<SearchObject, string> => {
    const since = query.since === undefined || query.since === "" ? undefined : parseDate(query.since);
    if (since === undefined && query.since !== undefined && query.since !== "")
      return fail(`"${query.since}" isn't a date.`);
    return ok({
      ...(query.from !== undefined && query.from !== "" && { from: query.from }),
      ...(query.subject !== undefined && query.subject !== "" && { subject: query.subject }),
      ...(query.text !== undefined && query.text !== "" && { text: query.text }),
      ...(since !== undefined && { since }),
    });
  };

  // What a query asks for: its criteria, or everything when it names a folder and nothing else.
  const lookFor = (query: MailQuery): Result<SearchObject, string> => {
    const criteria = criteriaOf(query);
    if (!criteria.ok || Object.keys(criteria.value).length > 0) return criteria;
    return (query.folder?.trim() ?? "") === ""
      ? fail("Say what to look for: a sender, a subject, words, a date or a folder, such as --folder inbox.")
      : ok({ all: true });
  };

  const search: MailSource["search"] = (query) =>
    runReading(
      "searching mail",
      async (opened) => {
        const criteria = lookFor(query);
        if (!criteria.ok) return criteria;
        const scope = scopeOf(opened, query.folder, kept(opened));
        if (!scope.ok) return scope;
        const cursor = fromCursor(query.more);
        if (!cursor.ok) return cursor;
        const limit = Math.min(Math.max(1, Math.trunc(query.limit ?? pageSize)), mostPerPage);
        const found = createCell<
          readonly {
            readonly folder: string;
            readonly matches: number;
            readonly older: readonly number[];
            readonly mails: readonly Mail[];
          }[]
        >([]);
        for (const folder of scope.value) {
          const read = await inFolder(opened.client, folder, async (): Promise<Result<undefined, string>> => {
            const uids = await searchUids(opened.client, criteria.value);
            if (!uids.ok) return uids;
            const below = cursor.value[folder];
            const older = newestFirst(uids.value.filter((uid) => below === undefined || uid < below));
            const mails = await fetchMails(opened.client, folder, toUidSet(older.slice(0, limit)), true);
            found.update((current) => [...current, { folder, matches: uids.value.length, older, mails }]);
            return ok(undefined);
          });
          if (!read.ok) return read;
        }
        const page = takePage(
          found.get().map(({ mails }) => mails),
          limit,
        );
        const next = found.get().map(({ folder, older }) => {
          const from = page.taken.filter((mail) => mail.folder === folder).map(({ uid }) => uid);
          const oldest = from.length === 0 ? cursor.value[folder] : Math.min(...from);
          return { folder, oldest, left: older.filter((uid) => oldest === undefined || uid < oldest).length };
        });
        const after = next.reduce((sum, { left }) => sum + left, 0);
        const more = Object.fromEntries(
          next.flatMap(({ folder, oldest }) => (oldest === undefined ? [] : [[folder, oldest]])),
        );
        return ok({
          mails: page.shown.toSorted(byDate).toReversed(),
          total: found.get().reduce((sum, { matches }) => sum + matches, 0),
          after,
          searched: scope.value,
          ...(after > 0 && { more: toCursor(more) }),
        });
      },
      searchLimitMs,
    );

  const thread: MailSource["thread"] = (messageId) =>
    runReading(
      "reading the conversation",
      async (opened) => {
        const found = await findMail(opened, messageId);
        if (!found.ok) return found;
        const { mail, place } = found.value;
        const threadId = await threadIdAt(opened, place);
        const query: SearchObject = {
          or: [
            ...[...threadIds(mail)].flatMap((id) => [
              byIdHeader("message-id", id),
              byIdHeader("references", id),
              byIdHeader("in-reply-to", id),
            ]),
            ...(threadId === undefined ? [] : [{ threadId }]),
          ],
        };
        const mails = await mailsIn(opened.client, kept(opened), query);
        return mails.ok ? ok(threadOf(mail.messageId, [mail, ...mails.value])) : mails;
      },
      searchLimitMs,
    );

  // Where in Drafts the draft with this Message-ID is now, if it's there.
  const draftPlace = (opened: Session, messageId: string): Promise<Result<Place | undefined, string>> => {
    const { drafts } = opened.folders;
    return drafts === undefined
      ? Promise.resolve(fail("This account has no Drafts folder."))
      : locate(opened, [drafts], messageId);
  };

  const appendDraft = async (opened: Session, messageId: string, mime: Buffer): Promise<Result<undefined, string>> => {
    const { drafts } = opened.folders;
    if (drafts === undefined) return fail("This account has no Drafts folder.");
    const appended = await opened.client.append(drafts, mime, ["\\Draft", "\\Seen"]);
    if (appended === false) return fail("The mail server didn't keep the draft.");
    if (appended.uid !== undefined) remember(messageId, { folder: appended.destination, uid: appended.uid });
    return ok(undefined);
  };

  // Whether a save cut short was kept after all, looked for by its own Message-ID: so a save is never made twice.
  const wasKept = async (messageId: string): Promise<boolean | undefined> => {
    const looked = await attempt("looking for the draft in Drafts", (opened) => draftPlace(opened, messageId));
    return "done" in looked && looked.done.ok ? looked.done.value !== undefined : undefined;
  };

  // Puts the draft into Drafts once. A save the server didn't answer in time is looked for, and made again only when
  // it isn't there; what's said after that is what's known: kept, not kept, or unknown.
  const keepDraft = async (messageId: string, mime: Buffer): Promise<Result<undefined, string>> => {
    const first = await attempt("saving the draft", (opened) => appendDraft(opened, messageId, mime));
    if ("done" in first) return first.done;
    log("A draft's save was cut short, so it's looked for before trying again", { reason: first.cut });
    const kept = await wasKept(messageId);
    if (kept === undefined) return fail(unknown(first.cut));
    if (kept) return ok(undefined);
    const second = await attempt("saving the draft", (opened) => appendDraft(opened, messageId, mime));
    if ("done" in second) return second.done;
    const keptLate = await wasKept(messageId);
    if (keptLate === undefined) return fail(unknown(second.cut));
    return keptLate
      ? ok(undefined)
      : fail(
          `Mail couldn't save the draft: ${second.cut} Tried twice, and nothing changed: the new draft isn't in ` +
            "Drafts and the earlier one is untouched, so trying again is safe.",
        );
  };

  // The draft as it reads back from Drafts.
  const readDraft = (messageId: string): Promise<Result<Mail, string>> =>
    runReading("reading the draft back", async (opened) => {
      const place = await draftPlace(opened, messageId);
      if (!place.ok) return place;
      if (place.value === undefined) return fail("The draft isn't in Drafts.");
      const { folder, uid } = place.value;
      const [mail] = await inFolder(opened.client, folder, () => fetchMails(opened.client, folder, String(uid)));
      return mail === undefined ? fail("The draft isn't in Drafts.") : ok(mail);
    });

  // One already gone from Drafts, such as sent or deleted in their mail app, is gone; only a draft with exactly that
  // Message-ID is ever taken out.
  const removeDraft: MailSource["removeDraft"] = (messageId) =>
    run(
      "removing the draft",
      async (opened) => {
        const removed = await deleteDraft(opened, messageId);
        return removed.ok ? ok(removed.value ? ("removed" as const) : ("gone" as const)) : removed;
      },
      true,
    );

  const hasDraft: MailSource["hasDraft"] = (messageId) =>
    runReading("looking in Drafts", async (opened) => {
      const place = await draftPlace(opened, messageId);
      return place.ok ? ok(place.value !== undefined) : place;
    });

  const draft: MailSource["draft"] = async (letter) => {
    const messageId = `${randomUUID()}@${domainOf(letter.from.address)}`;
    const mime = await toDraftMime(letter, messageId, new Date());
    const kept = await keepDraft(messageId, mime);
    if (!kept.ok) return kept;
    const back = await readDraft(messageId);
    const removed = letter.replaces === undefined ? undefined : await removeDraft(letter.replaces);
    const replaced: Replaced | undefined =
      removed === undefined ? undefined : removed.ok ? removed.value : { failure: removed.failure };
    return ok({
      messageId,
      ...(back.ok ? { saved: back.value } : { unread: back.failure }),
      ...(replaced !== undefined && { replaced }),
    });
  };

  // The session with the account's folders as they are now.
  const relist = async ({ client }: Session): Promise<Session> => {
    const fresh = { client, folders: toFolders(await client.list()) };
    sessions.set(Promise.resolve(ok(fresh)));
    return fresh;
  };

  const ensureFolder = async (opened: Session, name: string): Promise<Result<string, string>> => {
    const delimiter = opened.folders.list.find((entry) => entry.delimiter)?.delimiter ?? "/";
    // A name is one folder at the top, never a path into others.
    const wanted = name.replaceAll(delimiter, "-").trim();
    const found = folderNamed(opened, name) ?? folderNamed(opened, wanted);
    if (found !== undefined) return ok(found);
    if (wanted === "") return fail("A folder needs a name.");
    try {
      await opened.client.mailboxCreate(wanted);
      log("Made a mail folder", { folder: wanted });
    } catch (error) {
      // One made since this session listed them, such as for a mail filed at the same moment, is there to use.
      if (folderNamed(await relist(opened), wanted) === undefined) throw error;
    }
    const made = folderNamed(await relist(opened), wanted);
    return made === undefined ? fail(`The mail server didn't make the folder ${wanted}.`) : ok(made);
  };

  // Found again each time, so a second try after one cut short only finishes what the first didn't.
  const file: MailSource["file"] = (messageId, filing) =>
    run(
      "filing the mail",
      async (opened) => {
        const place = await locate(opened, everywhere(opened), messageId);
        if (!place.ok) return place;
        return place.value === undefined ? fail(gone) : fileAt(opened, place.value, filing);
      },
      true,
    );

  const mark: MailSource["mark"] = (messageIds, marking) =>
    run(
      "marking mail",
      async (opened): Promise<Result<Marked, string>> => {
        const changed = createCell<readonly string[]>([]);
        const missing = createCell<readonly string[]>([]);
        const unique = new Set(messageIds);
        for (const messageId of unique) {
          const place = await locate(opened, everywhere(opened), messageId);
          if (!place.ok) return place;
          if (place.value === undefined) {
            missing.update((current) => [...current, messageId]);
            continue;
          }
          const done = await setMarks(opened, place.value, marking);
          if (!done.ok) return done;
          changed.update((current) => [...current, messageId]);
        }
        return ok({ changed: changed.get(), missing: missing.get() });
      },
      true,
    );

  const attachment: MailSource["attachment"] = (messageId, id) =>
    runReading("reading the attachment", async (opened) => {
      const place = await locate(opened, everywhere(opened), messageId);
      if (!place.ok) return place;
      if (place.value === undefined) return fail(gone);
      const { folder, uid } = place.value;
      const message = await inFolder(opened.client, folder, () =>
        opened.client.fetchOne(String(uid), { uid: true, source: true }, { uid: true }),
      );
      if (message === false || message.source === undefined) return fail(gone);
      const found = await attachmentIn(message.source, id);
      return found === undefined
        ? fail(`That mail has no attachment ${id}. Read the mail for the ids of the files it carries.`)
        : ok(found);
    });

  const unsubscribe: MailSource["unsubscribe"] = (mail) => unsubscribeFrom(mail, options.fetch ?? fetch);

  const fileInto: MailSource["fileInto"] = (messageId, folder) =>
    run(
      "filing the mail",
      async (opened) => {
        const place = await locate(opened, everywhere(opened), messageId);
        if (!place.ok) return place;
        if (place.value === undefined) return fail(gone);
        const target = await ensureFolder(opened, folder);
        if (!target.ok) return target;
        const moved = await moveOne(opened, place.value, target.value, folder);
        return moved.ok ? ok({ origin: place.value.folder }) : moved;
      },
      true,
    );

  const folders: MailSource["folders"] = () =>
    runReading(
      "listing the folders",
      async (opened) => {
        const listed = await opened.client.list({ statusQuery: { messages: true, unseen: true } });
        return ok(
          listed.filter(isSelectable).map((entry) => {
            const use = entry.path === opened.folders.inbox ? "inbox" : uses[entry.specialUse ?? ""];
            return {
              name: entry.path,
              ...(use !== undefined && { use }),
              messages: entry.status?.messages ?? 0,
              unseen: entry.status?.unseen ?? 0,
            };
          }),
        );
      },
      searchLimitMs,
    );

  // The UIDs in the open folder of mails with these Message-IDs, a few ids to a search.
  const uidsWithIds = async (client: ImapFlow, ids: readonly string[]): Promise<Result<readonly number[], string>> => {
    const uids = createCell<readonly number[]>([]);
    for (const part of chunked(ids, idChunk)) {
      const [only] = part;
      const query: SearchObject =
        only !== undefined && part.length === 1
          ? byIdHeader("message-id", only)
          : { or: part.map((id) => byIdHeader("message-id", id)) };
      const matched = await searchUids(client, query);
      if (!matched.ok) return matched;
      uids.update((current) => [...current, ...matched.value]);
    }
    return ok(uids.get());
  };

  // Finds mails by Message-ID a folder at a time, inbox first, so each is taken from the first folder that has it,
  // as reading one does.
  const selectIds = async (opened: Session, ids: readonly string[]): Promise<Result<Batch, string>> => {
    const synthetic = ids.flatMap((id) => fromSyntheticMessageId(id) ?? []);
    const wanted = createCell<ReadonlySet<string>>(
      new Set(ids.filter((id) => fromSyntheticMessageId(id) === undefined)),
    );
    const groups = createCell<readonly UidGroup[]>([]);
    const mails = createCell<readonly Mail[]>([]);
    for (const folder of everywhere(opened)) {
      const looking = [...wanted.get()];
      const own = synthetic.filter((place) => place.folder === folder).map(({ uid }) => uid);
      if (looking.length === 0 && own.length === 0) continue;
      const found = await inFolder(opened.client, folder, async (): Promise<Result<readonly Mail[], string>> => {
        const uids = await uidsWithIds(opened.client, looking);
        return uids.ok ? ok(await fetchMails(opened.client, folder, toUidSet([...own, ...uids.value]), true)) : uids;
      });
      if (!found.ok) return found;
      const taken = found.value.filter((mail) => wanted.get().has(mail.messageId) || own.includes(mail.uid));
      const takenIds = new Set(taken.map(({ messageId }) => messageId));
      wanted.set(new Set(looking.filter((id) => !takenIds.has(id))));
      if (taken.length === 0) continue;
      groups.update((current) => [...current, { folder, uids: taken.map(({ uid }) => uid) }]);
      mails.update((current) => [...current, ...taken]);
    }
    return ok({ groups: groups.get(), mails: mails.get() });
  };

  const selectQuery = async (opened: Session, query: MailQuery): Promise<Result<Batch, string>> => {
    const criteria = lookFor(query);
    if (!criteria.ok) return criteria;
    const { received, archive } = opened.folders;
    const scope = scopeOf(opened, query.folder, present([...received, archive]));
    if (!scope.ok) return scope;
    const collected = createCell<readonly Mail[]>([]);
    for (const folder of scope.value) {
      const found = await inFolder(opened.client, folder, async (): Promise<Result<readonly Mail[], string>> => {
        const uids = await searchUids(opened.client, criteria.value);
        return uids.ok ? ok(await fetchMails(opened.client, folder, toUidSet(uids.value), true)) : uids;
      });
      if (!found.ok) return found;
      collected.update((current) => [...current, ...found.value]);
    }
    // A mail in two folders, such as Gmail's inbox and All Mail, moves from the first.
    const mails = uniqueByMessageId(collected.get());
    const groups = scope.value.flatMap((folder) => {
      const uids = mails.filter((mail) => mail.folder === folder).map(({ uid }) => uid);
      return uids.length === 0 ? [] : { folder, uids };
    });
    return ok({ groups, mails });
  };

  const select: MailSource["select"] = (selection) =>
    runReading(
      "picking out mail",
      (opened) =>
        "messageIds" in selection ? selectIds(opened, selection.messageIds) : selectQuery(opened, selection.query),
      bulkLimitMs,
    );

  const destinationOf = async (opened: Session, destination: Destination): Promise<Result<string, string>> => {
    if (typeof destination === "object") return ensureFolder(opened, destination.folder);
    const { archive, trash, inbox } = opened.folders;
    const paths = { archive, bin: trash, inbox };
    const path = paths[destination];
    return path === undefined
      ? fail(`This account has no ${destination === "bin" ? "Trash" : "Archive"} folder.`)
      : ok(path);
  };

  const move: MailSource["move"] = (groups, destination, onProgress) =>
    run(
      "moving mail",
      async (opened) => {
        const target = await destinationOf(opened, destination);
        if (!target.ok) return target;
        // One chunk moved, or why not: a dropped connection too, so what moved before it is still told.
        const moveChunk = async (
          folder: string,
          part: readonly number[],
        ): Promise<Result<CopyResponseObject, string>> => {
          try {
            const done = await inFolder(opened.client, folder, () =>
              opened.client.messageMove(toUidSet(part), target.value, { uid: true }),
            );
            return done === false ? fail(`The mail server didn't move the mail out of ${folder}.`) : ok(done);
          } catch (error) {
            return fail(`Mail couldn't finish moving mail: ${explain(error)}`);
          }
        };
        const parts = groups
          .filter(({ folder }) => folder !== target.value)
          .flatMap(({ folder, uids }) =>
            chunked(newestFirst(uids).toReversed(), moveChunkSize).map((part) => ({ folder, part })),
          );
        const total = parts.reduce((sum, { part }) => sum + part.length, 0);
        // For each folder mail came from, how many moved and, while the server says, their UIDs in the destination.
        const landed = createCell<ReadonlyMap<string, Landed>>(new Map());
        const movedSoFar = (): number =>
          landed
            .get()
            .values()
            .reduce((sum, { count }) => sum + count, 0);
        const stopped = createCell<string | undefined>(undefined);
        for (const { folder, part } of parts) {
          const done = await moveChunk(folder, part);
          if (!done.ok) {
            stopped.set(done.failure);
            break;
          }
          const map = done.value.uidMap;
          landed.update((all) => {
            const { count, uids } = all.get(folder) ?? { count: 0, uids: [] };
            const there = uids === undefined || map === undefined ? undefined : [...uids, ...map.values()];
            return new Map([...all, [folder, { count: count + (map?.size ?? part.length), uids: there }]]);
          });
          onProgress?.(movedSoFar(), total);
        }
        const failure = stopped.get();
        if (failure !== undefined && movedSoFar() === 0) return fail(failure);
        return ok({
          moved: movedSoFar(),
          destination: target.value,
          placed: [...landed.get()].map(([origin, { uids }]) => ({ origin, ...(uids !== undefined && { uids }) })),
          ...(failure !== undefined && { failure }),
        });
      },
      false,
      bulkLimitMs,
    );

  const hasWritten: MailSource["hasWritten"] = (address) =>
    run("reading sent mail", async (opened) => {
      const { sent } = opened.folders;
      if (sent === undefined) return ok(false);
      const query: SearchObject = { or: [{ to: address }, { cc: address }] };
      const uids = await inFolder(opened.client, sent, () => searchUids(opened.client, query));
      return uids.ok ? ok(uids.value.length > 0) : uids;
    });

  const senders: MailSource["senders"] = () =>
    runReading("reading sent mail", async (opened) => ok(await sendersIn(opened)), searchLimitMs);

  const lastFrom: MailSource["lastFrom"] = (address) =>
    runReading("reading sent mail", async (opened) => {
      const { sent } = opened.folders;
      if (sent === undefined) return ok(undefined);
      const wanted = addressKey(address);
      return inFolder(opened.client, sent, async (): Promise<Result<string | undefined, string>> => {
        const uids = await searchUids(opened.client, { or: [{ to: wanted }, { cc: wanted }] });
        if (!uids.ok) return uids;
        const latest = newestFirst(uids.value).slice(0, lastFromSample);
        if (latest.length === 0) return ok(undefined);
        const messages = await opened.client.fetchAll(toUidSet(latest), { uid: true, envelope: true }, { uid: true });
        const isTo = ({ envelope }: FetchMessageObject): boolean =>
          [...(envelope?.to ?? []), ...(envelope?.cc ?? [])].some((to) => addressKey(to.address ?? "") === wanted);
        const [newest] = messages.filter((message) => isTo(message)).toSorted((left, right) => right.uid - left.uid);
        const from = newest?.envelope?.from?.[0]?.address;
        return ok(from === undefined ? undefined : from.toLowerCase());
      });
    });

  const sent: MailSource["sent"] = (since) =>
    runReading(
      "reading sent mail",
      async (opened) => {
        const query = sinceQuery(since);
        if (!query.ok) return query;
        if (opened.folders.sent === undefined) return fail("This account has no Sent folder.");
        const mails = await mailsIn(opened.client, [opened.folders.sent], query.value);
        return mails.ok ? ok(mails.value.toSorted(byDate)) : mails;
      },
      bulkLimitMs,
    );

  const sentBodies: MailSource["sentBodies"] = (limit) =>
    runReading(
      "reading sent mail",
      async (opened) => {
        const folder = opened.folders.sent;
        if (folder === undefined) return ok([]);
        return inFolder(opened.client, folder, async (): Promise<Result<readonly SentBody[], string>> => {
          const uids = await searchUids(opened.client, { all: true });
          if (!uids.ok) return uids;
          const latest = uids.value.toSorted((left, right) => left - right).slice(-limit);
          if (latest.length === 0) return ok([]);
          const bodies = createCell<readonly SentBody[]>([]);
          const messages = opened.client.fetch(toUidSet(latest), { uid: true, source: true }, { uid: true });
          for await (const { source } of messages) {
            if (source === undefined) continue;
            const body = await parseSentBody(source);
            bodies.update((current) => [body, ...current]);
          }
          return ok(bodies.get());
        });
      },
      searchLimitMs,
    );

  const close: MailSource["close"] = async () => {
    for (const stop of watchers.get()) stop();
    const opened = await sessions.get();
    sessions.set(undefined);
    if (opened?.ok !== true) return;
    await signOff(opened.value.client);
  };

  return {
    account,
    check,
    watch,
    recent,
    read,
    search,
    thread,
    draft,
    removeDraft,
    hasDraft,
    file,
    mark,
    attachment,
    fileInto,
    folders,
    select,
    move,
    hasWritten,
    senders,
    lastFrom,
    unsubscribe,
    sent,
    sentBodies,
    close,
  };
};
