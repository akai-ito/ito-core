import { randomUUID } from "node:crypto";
import { ImapFlow, type FetchMessageObject, type ImapFlowError, type ListResponse, type SearchObject } from "imapflow";
import { createCell } from "#cell.ts";
import { systemClock, type Cancel } from "#clock.ts";
import {
  fromSyntheticMessageId,
  parseMail,
  threadIds,
  threadOf,
  toDraftMime,
  uniqueByMessageId,
  type Draft,
  type Mail,
} from "#mail/message.ts";
import { providers, signInHints, type Account, type Endpoint } from "#mail/providers.ts";
import { sendLetter, type Credentials } from "#mail/smtp.ts";
import { unsubscribeFrom } from "#mail/unsubscribe.ts";
import { fail, ok, type Result } from "#result.ts";

export type { Address, Draft, Mail, Unsubscribe } from "#mail/message.ts";
export { providers } from "#mail/providers.ts";

export type Filing = "archive" | "bin" | "inbox" | "flag" | "unflag";

export type MailQuery = {
  readonly from?: string;
  readonly subject?: string;
  readonly text?: string;
  readonly since?: string;
};

export type MailSource = {
  readonly account: string;
  readonly check: () => Promise<Result<{ readonly addresses: readonly string[]; readonly folders: number }, string>>;
  readonly watch: (onMail: (mail: Mail) => void) => () => void;
  readonly recent: (since: string) => Promise<Result<readonly Mail[], string>>;
  readonly read: (messageId: string) => Promise<Result<Mail, string>>;
  readonly search: (query: MailQuery) => Promise<Result<readonly Mail[], string>>;
  readonly thread: (messageId: string) => Promise<Result<readonly Mail[], string>>;
  readonly draft: (draft: Draft) => Promise<Result<{ readonly messageId: string }, string>>;
  readonly removeDraft: (messageId: string) => Promise<Result<undefined, string>>;
  readonly file: (messageId: string, filing: Filing) => Promise<Result<undefined, string>>;
  readonly unsubscribe: (mail: Mail) => Promise<Result<"posted" | "mailed", string>>;
  readonly sent: (since: string) => Promise<Result<readonly Mail[], string>>;
  readonly close: () => Promise<void>;
};

export type Auth = { readonly password: string } | { readonly accessToken: () => Promise<Result<string, string>> };

export type SourceOptions = {
  readonly account: Account;
  readonly user: string;
  readonly auth: Auth;
  readonly imap?: Endpoint;
  readonly smtp?: Endpoint;
  readonly fetch?: typeof fetch;
  readonly logger?: (message: string, details: Readonly<Record<string, unknown>>) => void;
};

type Folders = {
  readonly inbox: string;
  readonly archive?: string;
  readonly sent?: string;
  readonly drafts?: string;
  readonly trash?: string;
  readonly count: number;
};

type Session = { readonly client: ImapFlow; readonly folders: Folders };

type Place = { readonly folder: string; readonly uid: number };

type Found = { readonly place: Place; readonly mail: Mail };

type Watermark = { readonly uidValidity: bigint; readonly next: number };

const searchLimit = 50;
const addressSample = 50;
const idleRestartMs = 4 * 60_000;
const firstRetryMs = 1000;
const lastRetryMs = 5 * 60_000;
const inboxPath = "INBOX";
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

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const specialPath = (list: readonly ListResponse[], use: string): string | undefined =>
  list.find((entry) => entry.specialUse === use)?.path;

const toFolders = (list: readonly ListResponse[]): Folders => ({
  inbox: specialPath(list, "\\Inbox") ?? inboxPath,
  archive: specialPath(list, "\\Archive") ?? specialPath(list, "\\All"),
  sent: specialPath(list, "\\Sent"),
  drafts: specialPath(list, "\\Drafts"),
  trash: specialPath(list, "\\Trash"),
  count: list.filter((entry) => !entry.flags.has("\\Noselect")).length,
});

const present = (folders: readonly (string | undefined)[]): readonly string[] => [
  ...new Set(folders.filter((folder) => folder !== undefined)),
];

const toIso = (value: Date | string | undefined): string | undefined => {
  const date = value === undefined ? undefined : new Date(value);
  return date === undefined || Number.isNaN(date.getTime()) ? undefined : date.toISOString();
};

const parseDate = (text: string): Date | undefined => {
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? undefined : date;
};

const byDate = (left: Mail, right: Mail): number => left.date.localeCompare(right.date);

const byIdHeader = (name: string, id: string): SearchObject => ({ header: { [name]: `<${id}>` } });

const domainOf = (address: string): string => address.split("@", 2)[1] ?? "ito.invalid";

const ignore = (): void => undefined;

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
  const smtp = options.smtp ?? providers[account].smtp;
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

  const openClient = async (watching: boolean): Promise<Result<ImapFlow, string>> => {
    const signIn = await credentials();
    if (!signIn.ok) return signIn;
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
      return ok(client);
    } catch (error) {
      client.close();
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
  ): Promise<Result<Value, string>> => {
    const opened = await session();
    if (!opened.ok) return opened;
    try {
      return await work(opened.value);
    } catch (error) {
      const reason = explain(error);
      log("Mail work failed", { doing, reason });
      return fail(`Mail couldn't finish ${doing}: ${reason}`);
    }
  };

  const toMailFrom = async (message: FetchMessageObject, folder: string): Promise<Mail | undefined> => {
    if (message.source === undefined) return undefined;
    const receivedAt = toIso(message.internalDate);
    return parseMail(message.source, {
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
  ): Promise<readonly Mail[]> => {
    if (range === "") return [];
    const mails = createCell<readonly Mail[]>([]);
    const messages = client.fetch(range, { uid: true, flags: true, internalDate: true, source: true }, { uid: true });
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
    newest?: number,
  ): Promise<Result<readonly Mail[], string>> => {
    const collected = createCell<readonly Mail[]>([]);
    for (const folder of folders) {
      const found = await inFolder(client, folder, async (): Promise<Result<readonly Mail[], string>> => {
        const uids = await searchUids(client, query);
        if (!uids.ok) return uids;
        const chosen =
          newest === undefined ? uids.value : uids.value.toSorted((left, right) => right - left).slice(0, newest);
        return ok(await fetchMails(client, folder, toUidSet(chosen)));
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

  const everywhere = ({ folders }: Session): readonly string[] =>
    present([folders.inbox, folders.archive, folders.sent, folders.drafts, folders.trash]);

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

  const move = async (
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
        return move(opened, place, opened.folders.archive, "Archive");
      }
      case "bin": {
        return move(opened, place, opened.folders.trash, "Trash");
      }
      case "inbox": {
        return move(opened, place, opened.folders.inbox, "Inbox");
      }
      case "flag": {
        return flag(opened, place, true);
      }
      case "unflag": {
        return flag(opened, place, false);
      }
    }
  };

  const sentAddresses = async (opened: Session): Promise<readonly string[]> => {
    const { sent } = opened.folders;
    if (sent === undefined) return [];
    return inFolder(opened.client, sent, async () => {
      const exists = opened.client.mailbox === false ? 0 : opened.client.mailbox.exists;
      if (exists === 0) return [];
      const range = `${String(Math.max(1, exists - addressSample + 1))}:*`;
      const messages = await opened.client.fetchAll(range, { envelope: true });
      return messages.flatMap(({ envelope }) => (envelope?.from ?? []).map(({ address = "" }) => address));
    });
  };

  const check: MailSource["check"] = async () => {
    const previous = await sessions.get();
    if (previous?.ok === true) previous.value.client.close();
    sessions.set(openSession());
    return run("checking the account", async (opened) => {
      const seen = await sentAddresses(opened);
      const addresses = [...(user.includes("@") ? [user] : []), ...seen]
        .map((address) => address.toLowerCase())
        .filter((address, index, all) => address.includes("@") && all.indexOf(address) === index);
      return ok({ addresses, folders: opened.folders.count });
    });
  };

  const watch: MailSource["watch"] = (onMail) => {
    const isStopped = createCell(false);
    const current = createCell<ImapFlow | undefined>(undefined);
    const retry = createCell<Cancel | undefined>(undefined);
    const attempts = createCell(0);
    const watermark = createCell<Watermark | undefined>(undefined);
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
      const last = arrived.at(-1);
      if (last !== undefined) watermark.set({ ...mark, next: last.uid + 1 });
      for (const mail of arrived) {
        if (isStopped.get()) return;
        try {
          onMail(mail);
        } catch (error) {
          log("A new mail's listener failed", { reason: describe(error) });
        }
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
        watermark.set({ uidValidity: mailbox.uidValidity, next: mailbox.uidNext });
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
    run("reading recent mail", async (opened) => {
      const query = sinceQuery(since);
      if (!query.ok) return query;
      const { inbox, archive } = opened.folders;
      const mails = await mailsIn(opened.client, present([inbox, archive]), query.value);
      return mails.ok ? ok(mails.value.filter((mail) => !mail.flags.includes("\\Draft")).toSorted(byDate)) : mails;
    });

  const read: MailSource["read"] = (messageId) =>
    run("reading the mail", async (opened) => {
      const found = await findMail(opened, messageId);
      return found.ok ? ok(found.value.mail) : found;
    });

  const search: MailSource["search"] = (query) =>
    run("searching mail", async (opened) => {
      const since = query.since === undefined ? undefined : parseDate(query.since);
      if (since === undefined && query.since !== undefined) return fail(`"${query.since}" isn't a date.`);
      const criteria: SearchObject = {
        ...(query.from !== undefined && query.from !== "" && { from: query.from }),
        ...(query.subject !== undefined && query.subject !== "" && { subject: query.subject }),
        ...(query.text !== undefined && query.text !== "" && { text: query.text }),
        ...(since !== undefined && { since }),
      };
      if (Object.keys(criteria).length === 0)
        return fail("Say what to look for: a sender, a subject, words or a date.");
      const { inbox, archive, sent } = opened.folders;
      const mails = await mailsIn(opened.client, present([inbox, archive, sent]), criteria, searchLimit);
      return mails.ok ? ok(mails.value.toSorted(byDate).toReversed().slice(0, searchLimit)) : mails;
    });

  const thread: MailSource["thread"] = (messageId) =>
    run("reading the conversation", async (opened) => {
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
      const { inbox, archive, sent } = opened.folders;
      const mails = await mailsIn(opened.client, present([inbox, archive, sent]), query);
      return mails.ok ? ok(threadOf(mail.messageId, [mail, ...mails.value])) : mails;
    });

  const draft: MailSource["draft"] = (letter) =>
    run("saving the draft", async (opened) => {
      const { drafts } = opened.folders;
      if (drafts === undefined) return fail("This account has no Drafts folder.");
      if (letter.replaces !== undefined) {
        const removed = await deleteDraft(opened, letter.replaces);
        if (!removed.ok) return removed;
      }
      const messageId = `${randomUUID()}@${domainOf(letter.from.address)}`;
      const mime = await toDraftMime(letter, messageId, new Date());
      const appended = await opened.client.append(drafts, mime, ["\\Draft", "\\Seen"]);
      return appended === false ? fail("The mail server didn't keep the draft.") : ok({ messageId });
    });

  const removeDraft: MailSource["removeDraft"] = (messageId) =>
    run("removing the draft", async (opened) => {
      const removed = await deleteDraft(opened, messageId);
      if (!removed.ok) return removed;
      return removed.value ? ok(undefined) : fail("That draft isn't in the Drafts folder any more.");
    });

  const file: MailSource["file"] = (messageId, filing) =>
    run("filing the mail", async (opened) => {
      const place = await locate(opened.client, everywhere(opened), messageId);
      if (!place.ok) return place;
      return place.value === undefined ? fail(gone) : fileAt(opened, place.value, filing);
    });

  const unsubscribe: MailSource["unsubscribe"] = (mail) =>
    unsubscribeFrom(mail, {
      fetch: options.fetch ?? fetch,
      from: user.includes("@") ? user : (mail.to[0]?.address ?? user),
      send: async (letter) => {
        const signIn = await credentials();
        return signIn.ok ? sendLetter(smtp, signIn.value, letter) : signIn;
      },
    });

  const sent: MailSource["sent"] = (since) =>
    run("reading sent mail", async (opened) => {
      const query = sinceQuery(since);
      if (!query.ok) return query;
      if (opened.folders.sent === undefined) return fail("This account has no Sent folder.");
      const mails = await mailsIn(opened.client, [opened.folders.sent], query.value);
      return mails.ok ? ok(mails.value.toSorted(byDate)) : mails;
    });

  const close: MailSource["close"] = async () => {
    for (const stop of watchers.get()) stop();
    const opened = await sessions.get();
    sessions.set(undefined);
    if (opened?.ok !== true) return;
    await signOff(opened.value.client);
  };

  return { account, check, watch, recent, read, search, thread, draft, removeDraft, file, unsubscribe, sent, close };
};
