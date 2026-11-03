import { createCell } from "#cell.ts";
import type { Destination, Draft, Mail, MailQuery, MailSource, SentBody, SourceOptions, UidGroup } from "#mail/imap.ts";
import type { Health } from "#problems/problems.ts";
import { fail, ok } from "#result.ts";

export type ArrivingMail = {
  readonly account: string;
  readonly message_id: string;
  readonly from: string;
  readonly reply_to?: string;
  readonly in_reply_to?: string;
  readonly to: readonly string[];
  readonly subject: string;
  readonly text: string;
  readonly unsubscribe?: string;
};

// Where a mail was moved: a filing such as bin, or a folder of theirs by name.
export type Moved = { readonly account: string; readonly messageId: string; readonly to: string };

export type FakeMail = {
  readonly create: (options: SourceOptions) => MailSource;
  readonly arrive: (mail: ArrivingMail) => void;
  // Mail already in one of the account's folders, such as one an earlier assistant made.
  readonly keep: (folder: string, mail: ArrivingMail) => void;
  readonly folderOf: (account: string, messageId: string) => string | undefined;
  readonly hold: (account: string, count: number) => void;
  readonly expectDrafts: (ids: readonly string[]) => void;
  readonly drafts: () => readonly Draft[];
  readonly removedDrafts: () => readonly string[];
  readonly moved: () => readonly Moved[];
  readonly unsubscribed: () => readonly string[];
  readonly send: (account: string, mail: Mail) => void;
  // A mail they sent, whole, as the signature is learned from: the newest last.
  readonly sentWhole: (account: string, body: SentBody) => void;
  readonly breakSentBodies: (broken: boolean) => void;
  readonly breakReading: () => void;
  // The next batch move stops after this many mails, as when the connection drops partway.
  readonly stopMovesAfter: (count: number) => void;
  // Unsubscribing and removing drafts fail from now on, as when a list has only a web page or the server drops.
  readonly refuseUnsubscribes: () => void;
  readonly refuseDraftRemoval: () => void;
  readonly dropSent: (times: number) => void;
  readonly health: (account: string, health: Health) => void;
};

type Box = { readonly inbox: readonly Mail[]; readonly watchers: ReadonlySet<(mail: Mail) => void> };

const toAddress = (text: string): Mail["from"] => {
  const named = /^(?<name>.*?)\s*<(?<address>[^>]+)>$/u.exec(text)?.groups;
  return named?.address === undefined ? { address: text } : { address: named.address, name: named.name ?? "" };
};

const has = (text: string, wanted: string | undefined): boolean =>
  wanted === undefined || text.toLowerCase().includes(wanted.toLowerCase());

const folderPaths: Readonly<Record<string, string>> = { inbox: "INBOX", archive: "Archive", bin: "Trash" };

const pathOf = (destination: Destination): string =>
  typeof destination === "object" ? destination.folder : (folderPaths[destination] ?? destination);

const matches = (mail: Mail, query: MailQuery): boolean =>
  (query.folder === undefined ||
    mail.folder.toLowerCase() === (folderPaths[query.folder] ?? query.folder).toLowerCase()) &&
  has(`${mail.from.name ?? ""} ${mail.from.address}`, query.from) &&
  has(mail.subject, query.subject) &&
  has(mail.text, query.text);

const byFolder = (mails: readonly Mail[]): readonly UidGroup[] =>
  [...Map.groupBy(mails, (mail) => mail.folder)].map(([folder, inFolder]) => ({
    folder,
    uids: inFolder.map(({ uid }) => uid),
  }));

export const createFakeMail = (now: () => string): FakeMail => {
  const boxes = createCell<ReadonlyMap<string, Box>>(new Map());
  const draftIds = createCell<readonly string[]>([]);
  const saved = createCell<readonly Draft[]>([]);
  const removed = createCell<readonly string[]>([]);
  const moves = createCell<readonly Moved[]>([]);
  const unsubscribes = createCell<readonly string[]>([]);
  const sentMail = createCell<ReadonlyMap<string, readonly Mail[]>>(new Map());
  const isBroken = createCell(false);
  const sentDrops = createCell(0);
  const bodies = createCell<ReadonlyMap<string, readonly SentBody[]>>(new Map());
  const isSentBroken = createCell(false);
  const moveLimit = createCell<number | undefined>(undefined);
  const isUnsubscribeRefused = createCell(false);
  const isRemovalRefused = createCell(false);
  const healthListeners = createCell<ReadonlyMap<string, (health: Health) => void>>(new Map());

  const boxOf = (account: string): Box => boxes.get().get(account) ?? { inbox: [], watchers: new Set() };

  const change = (account: string, update: (box: Box) => Box): void => {
    boxes.update((all) => new Map([...all, [account, update(boxOf(account))]]));
  };

  const toMail = (account: string, mail: Omit<ArrivingMail, "account">, uid: number): Mail => ({
    account,
    folder: "INBOX",
    uid,
    messageId: mail.message_id,
    ...(mail.in_reply_to !== undefined && { inReplyTo: mail.in_reply_to }),
    references: mail.in_reply_to === undefined ? [] : [mail.in_reply_to],
    from: toAddress(mail.from),
    ...(mail.reply_to !== undefined && { replyTo: [toAddress(mail.reply_to)] }),
    to: mail.to.map((address) => toAddress(address)),
    cc: [],
    subject: mail.subject,
    date: now(),
    text: mail.text,
    ...(mail.unsubscribe !== undefined && { unsubscribe: { post: mail.unsubscribe, url: mail.unsubscribe } }),
    flags: [],
  });

  const move = (account: string, messageId: string, to: string): ReturnType<MailSource["file"]> => {
    moves.update((all) => [...all, { account, messageId, to }]);
    return Promise.resolve(ok(undefined));
  };

  const create = ({ account, user, onHealth }: SourceOptions): MailSource => {
    if (onHealth) healthListeners.update((all) => new Map([...all, [account, onHealth]]));
    return source(account, user);
  };

  const source = (account: string, user: string): MailSource => ({
    account,
    check: () => Promise.resolve(ok({ addresses: [user], folders: 4 })),
    watch: (onMail) => {
      change(account, (box) => ({ ...box, watchers: new Set([...box.watchers, onMail]) }));
      return () => {
        change(account, (box) => ({
          ...box,
          watchers: new Set([...box.watchers].filter((watcher) => watcher !== onMail)),
        }));
      };
    },
    recent: () =>
      Promise.resolve(isBroken.get() ? fail("The mail server refused the sign-in.") : ok(boxOf(account).inbox)),
    folders: () => {
      const counted = [...Map.groupBy(boxOf(account).inbox, (mail) => mail.folder)].map(([name, mails]) => ({
        name,
        ...(name === "INBOX" && { use: "inbox" as const }),
        messages: mails.length,
        unseen: 0,
      }));
      return Promise.resolve(ok(counted));
    },
    select: (selection) => {
      const mails = boxOf(account).inbox.filter((mail) =>
        "messageIds" in selection ? selection.messageIds.includes(mail.messageId) : matches(mail, selection.query),
      );
      return Promise.resolve(ok({ groups: byFolder(mails), mails }));
    },
    move: (groups, destination, onProgress) => {
      const to = pathOf(destination);
      const picked = boxOf(account).inbox.filter((mail) =>
        groups.some(({ folder, uids }) => folder === mail.folder && mail.folder !== to && uids.includes(mail.uid)),
      );
      const limit = moveLimit.get();
      moveLimit.set(undefined);
      const moving = picked.slice(0, limit);
      change(account, (box) => ({
        ...box,
        inbox: box.inbox.map((mail) => (moving.includes(mail) ? { ...mail, folder: to } : mail)),
      }));
      moves.update((all) => [...all, ...moving.map(({ messageId }) => ({ account, messageId, to }))]);
      onProgress?.(moving.length, moving.length);
      return Promise.resolve(
        ok({
          moved: moving.length,
          destination: to,
          placed: byFolder(moving).map(({ folder, uids }) => ({ origin: folder, uids })),
          ...(moving.length < picked.length && {
            failure: "Mail couldn't finish moving mail: Connection not available",
          }),
        }),
      );
    },
    read: (messageId) => {
      const found = boxOf(account).inbox.find((mail) => mail.messageId === messageId);
      return Promise.resolve(found ? ok(found) : fail("That mail isn't in this account any more."));
    },
    search: (query) => {
      const found = boxOf(account)
        .inbox.filter((mail) => matches(mail, query))
        .toReversed();
      const start = Number(query.more ?? "0");
      const limit = query.limit ?? 20;
      const shown = found.slice(start, start + limit);
      const after = Math.max(0, found.length - start - shown.length);
      return Promise.resolve(
        ok({
          mails: shown,
          total: found.length,
          after,
          searched: [query.folder ?? "INBOX"],
          ...(after > 0 && { more: String(start + limit) }),
        }),
      );
    },
    thread: (messageId) => {
      const found = boxOf(account).inbox.find((mail) => mail.messageId === messageId);
      return Promise.resolve(ok(found ? [found] : []));
    },
    draft: (draft) => {
      const [next = `draft-${String(saved.get().length + 1)}@ito.local`, ...rest] = draftIds.get();
      draftIds.set(rest);
      saved.update((all) => [...all, draft]);
      return Promise.resolve(ok({ messageId: next }));
    },
    removeDraft: (messageId) => {
      if (isRemovalRefused.get()) {
        return Promise.resolve(fail("Mail couldn't finish removing the draft: Connection not available"));
      }
      removed.update((all) => [...all, messageId]);
      return Promise.resolve(ok(undefined));
    },
    file: (messageId, filing) => move(account, messageId, filing),
    fileInto: (messageId, folder) => move(account, messageId, folder),
    hasWritten: (address) =>
      Promise.resolve(
        ok((sentMail.get().get(account) ?? []).some((mail) => mail.to.some((to) => has(to.address, address)))),
      ),
    unsubscribe: (mail) => {
      if (isUnsubscribeRefused.get()) {
        return Promise.resolve(fail("This list only unsubscribes on its web page: https://mail.pizza.example/leave"));
      }
      unsubscribes.update((all) => [...all, mail.messageId]);
      return Promise.resolve(ok("posted" as const));
    },
    sent: () => {
      if (sentDrops.get() === 0) return Promise.resolve(ok(sentMail.get().get(account) ?? []));
      sentDrops.update((count) => count - 1);
      return Promise.resolve(fail("Mail couldn't finish reading sent mail: Connection not available"));
    },
    sentBodies: (limit) =>
      Promise.resolve(
        isSentBroken.get()
          ? fail("Mail couldn't finish reading sent mail: Connection not available")
          : ok((bodies.get().get(account) ?? []).slice(-limit).toReversed()),
      ),
    close: () => Promise.resolve(),
  });

  return {
    create,
    keep: (folder, { account, ...mail }) => {
      const kept = { ...toMail(account, mail, boxOf(account).inbox.length + 1), folder };
      change(account, (box) => ({ ...box, inbox: [...box.inbox, kept] }));
    },
    folderOf: (account, messageId) => boxOf(account).inbox.find((mail) => mail.messageId === messageId)?.folder,
    arrive: ({ account, ...mail }) => {
      const arrived = toMail(account, mail, boxOf(account).inbox.length + 1);
      change(account, (box) => ({ ...box, inbox: [...box.inbox, arrived] }));
      for (const watcher of boxOf(account).watchers) watcher(arrived);
    },
    hold: (account, count) => {
      const held = Array.from({ length: count }, (_, index) =>
        toMail(
          account,
          {
            message_id: `held-${String(index + 1)}@news.example`,
            from: "News <news@news.example>",
            to: [],
            subject: `Issue ${String(index + 1)}`,
            text: "This week's news.",
          },
          index + 1,
        ),
      );
      change(account, (box) => ({ ...box, inbox: [...box.inbox, ...held] }));
    },
    expectDrafts: (ids) => {
      draftIds.set(ids);
    },
    drafts: () => saved.get(),
    removedDrafts: () => removed.get(),
    moved: () => moves.get(),
    unsubscribed: () => unsubscribes.get(),
    send: (account, mail) => {
      sentMail.update((all) => new Map([...all, [account, [...(all.get(account) ?? []), mail]]]));
    },
    sentWhole: (account, body) => {
      bodies.update((all) => new Map([...all, [account, [...(all.get(account) ?? []), body]]]));
    },
    breakSentBodies: (broken) => {
      isSentBroken.set(broken);
    },
    breakReading: () => {
      isBroken.set(true);
    },
    stopMovesAfter: (count) => {
      moveLimit.set(count);
    },
    refuseUnsubscribes: () => {
      isUnsubscribeRefused.set(true);
    },
    refuseDraftRemoval: () => {
      isRemovalRefused.set(true);
    },
    dropSent: (times) => {
      sentDrops.set(times);
    },
    health: (account, health) => {
      healthListeners.get().get(account)?.(health);
    },
  };
};
