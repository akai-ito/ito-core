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
  fromSyntheticMessageId,
  parseMail,
  parseSentBody,
  rankSenders,
  threadIds,
  threadOf,
  toDraftMime,
  uniqueByMessageId,
  type Address,
  type Draft,
  type Mail,
  type SentBody,
} from "#mail/message.ts";
import { providers, signInHints, type Account, type Endpoint } from "#mail/providers.ts";
import { unsubscribeFrom, type Unsubscribed } from "#mail/unsubscribe.ts";
import type { Health } from "#problems/problems.ts";
import { fail, ok, type Result } from "#result.ts";

export type { Address, Draft, Mail, SentBody, Unsubscribe } from "#mail/message.ts";
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
  readonly draft: (draft: Draft) => Promise<Result<{ readonly messageId: string }, string>>;
  readonly removeDraft: (messageId: string) => Promise<Result<undefined, string>>;
  readonly file: (messageId: string, filing: Filing) => Promise<Result<undefined, string>>;
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
        return `${imap.host} didn't answer in time.`;
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

  const run = async <Value>(
    doing: string,
    work: (opened: Session) => Promise<Result<Value, string>>,
    isReading = false,
  ): Promise<Result<Value, string>> => {
    const opened = await session();
    if (!opened.ok) return opened;
    try {
      return await work(opened.value);
    } catch (error) {
      const reason = explain(error);
      if (isReading && isDropped(opened.value.client, error)) {
        log("The mail session dropped, so it reads again on a fresh one", { doing, reason });
        opened.value.client.close();
        return run(doing, work);
      }
      log("Mail work failed", { doing, reason });
      return fail(`Mail couldn't finish ${doing}: ${reason}`);
    }
  };

  const runReading = <Value>(
    doing: string,
    work: (opened: Session) => Promise<Result<Value, string>>,
  ): Promise<Result<Value, string>> => run(doing, work, true);

  const toMailFrom = async (message: FetchMessageObject, folder: string): Promise<Mail | undefined> => {
    const raw = message.source ?? message.headers;
    if (raw === undefined) return undefined;
    const receivedAt = toIso(message.internalDate);
    return parseMail(raw, {
      account,
      folder,
      uid: message.uid,
      flags: [...(message.flags ?? [])],
      ...(receivedAt !== undefined && { receivedAt }),
    });
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

  const locate = async (
    client: ImapFlow,
    folders: readonly string[],
    messageId: string,
  ): Promise<Result<Place | undefined, string>> => {
    const synthetic = fromSyntheticMessageId(messageId);
    if (synthetic !== undefined) return ok(synthetic);
    for (const folder of folders) {
      const uids = await inFolder(client, folder, () => searchUids(client, byIdHeader("message-id", messageId)));
      if (!uids.ok) return uids;
      const [uid] = uids.value.toSorted((left, right) => right - left);
      if (uid !== undefined) return ok({ folder, uid });
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
    const place = await locate(opened.client, everywhere(opened), messageId);
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
    const place = await locate(opened.client, [drafts], messageId);
    if (!place.ok) return place;
    if (place.value?.folder !== drafts) return ok(false);
    const { uid } = place.value;
    const deleted = await inFolder(opened.client, drafts, () =>
      opened.client.messageDelete(String(uid), { uid: true }),
    );
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

  const flag = async (opened: Session, place: Place, isOn: boolean): Promise<Result<undefined, string>> => {
    const changed = await inFolder(opened.client, place.folder, () =>
      isOn
        ? opened.client.messageFlagsAdd(String(place.uid), ["\\Flagged"], { uid: true })
        : opened.client.messageFlagsRemove(String(place.uid), ["\\Flagged"], { uid: true }),
    );
    return changed ? ok(undefined) : fail("The mail server didn't change the flag.");
  };

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
    return run("checking the account", async (opened) =>
      ok({ senders: await sendersIn(opened), folders: opened.folders.count }),
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
    runReading("reading recent mail", async (opened) => {
      const query = sinceQuery(since);
      if (!query.ok) return query;
      const { received, archive } = opened.folders;
      const mails = await mailsIn(opened.client, present([...received, archive]), query.value, true);
      return mails.ok ? ok(mails.value.filter((mail) => !mail.flags.includes("\\Draft")).toSorted(byDate)) : mails;
    });

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
    runReading("searching mail", async (opened) => {
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
    });

  const thread: MailSource["thread"] = (messageId) =>
    runReading("reading the conversation", async (opened) => {
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
    });

  const draft: MailSource["draft"] = (letter) =>
    run("saving the draft", async (opened) => {
      const { drafts } = opened.folders;
      if (drafts === undefined) return fail("This account has no Drafts folder.");
      const messageId = `${randomUUID()}@${domainOf(letter.from.address)}`;
      const mime = await toDraftMime(letter, messageId, new Date());
      const appended = await opened.client.append(drafts, mime, ["\\Draft", "\\Seen"]);
      if (appended === false) return fail("The mail server didn't keep the draft.");
      if (letter.replaces !== undefined) {
        const removed = await deleteDraft(opened, letter.replaces);
        if (!removed.ok) log("The draft it replaces couldn't be removed", { reason: removed.failure });
      }
      return ok({ messageId });
    });

  // One already gone from Drafts, such as sent or deleted in their mail app, counts as removed.
  const removeDraft: MailSource["removeDraft"] = (messageId) =>
    run("removing the draft", async (opened) => {
      const removed = await deleteDraft(opened, messageId);
      return removed.ok ? ok(undefined) : removed;
    });

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

  const file: MailSource["file"] = (messageId, filing) =>
    run("filing the mail", async (opened) => {
      const place = await locate(opened.client, everywhere(opened), messageId);
      if (!place.ok) return place;
      return place.value === undefined ? fail(gone) : fileAt(opened, place.value, filing);
    });

  const unsubscribe: MailSource["unsubscribe"] = (mail) => unsubscribeFrom(mail, options.fetch ?? fetch);

  const fileInto: MailSource["fileInto"] = (messageId, folder) =>
    run("filing the mail", async (opened) => {
      const place = await locate(opened.client, everywhere(opened), messageId);
      if (!place.ok) return place;
      if (place.value === undefined) return fail(gone);
      const target = await ensureFolder(opened, folder);
      if (!target.ok) return target;
      const moved = await moveOne(opened, place.value, target.value, folder);
      return moved.ok ? ok({ origin: place.value.folder }) : moved;
    });

  const folders: MailSource["folders"] = () =>
    runReading("listing the folders", async (opened) => {
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
    });

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
    runReading("picking out mail", (opened) =>
      "messageIds" in selection ? selectIds(opened, selection.messageIds) : selectQuery(opened, selection.query),
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
    run("moving mail", async (opened) => {
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
    });

  const hasWritten: MailSource["hasWritten"] = (address) =>
    run("reading sent mail", async (opened) => {
      const { sent } = opened.folders;
      if (sent === undefined) return ok(false);
      const query: SearchObject = { or: [{ to: address }, { cc: address }] };
      const uids = await inFolder(opened.client, sent, () => searchUids(opened.client, query));
      return uids.ok ? ok(uids.value.length > 0) : uids;
    });

  const senders: MailSource["senders"] = () =>
    runReading("reading sent mail", async (opened) => ok(await sendersIn(opened)));

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
    runReading("reading sent mail", async (opened) => {
      const query = sinceQuery(since);
      if (!query.ok) return query;
      if (opened.folders.sent === undefined) return fail("This account has no Sent folder.");
      const mails = await mailsIn(opened.client, [opened.folders.sent], query.value);
      return mails.ok ? ok(mails.value.toSorted(byDate)) : mails;
    });

  const sentBodies: MailSource["sentBodies"] = (limit) =>
    runReading("reading sent mail", async (opened) => {
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
    });

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
    file,
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
