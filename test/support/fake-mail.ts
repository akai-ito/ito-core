import { createCell } from "#cell.ts";
import type {
  AttachmentContent,
  Destination,
  Draft,
  Mail,
  Marking,
  MailQuery,
  MailSource,
  SentBody,
  SourceOptions,
  UidGroup,
} from "#mail/imap.ts";
import { attachedName, isSameAddress, rankSenders } from "#mail/message.ts";
import { toLetter } from "#mail/unsubscribe.ts";
import type { Health } from "#problems/problems.ts";
import { fail, ok } from "#result.ts";

export type ArrivingMail = {
  readonly account: string;
  readonly message_id: string;
  readonly from: string;
  readonly reply_to?: string;
  readonly in_reply_to?: string;
  readonly to: readonly string[];
  readonly cc?: readonly string[];
  readonly subject: string;
  readonly text: string;
  // The whole text, with the history it quotes, when that's more than text.
  readonly full_text?: string;
  // When it was sent; now by default.
  readonly date?: string;
  // A one-click unsubscribe link, and a mailto: one, for a list that takes mail to leave.
  readonly unsubscribe?: string;
  readonly unsubscribe_mailto?: string;
  // Files it carries, each by its id, as a mail read whole lists them.
  readonly files?: readonly {
    readonly id: string;
    readonly filename?: string;
    readonly contentType: string;
    readonly content: Buffer;
  }[];
};

// A change Kumo made to how a mail is marked.
export type Mark = Marking & { readonly account: string; readonly messageId: string };

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
  // A draft deleted in their mail app, out of Drafts without Kumo.
  readonly deleteInMail: (messageId: string) => void;
  readonly moved: () => readonly Moved[];
  readonly marks: () => readonly Mark[];
  readonly unsubscribed: () => readonly string[];
  readonly send: (account: string, mail: Mail) => void;
  // A mail they sent, whole, as the signature is learned from: the newest last.
  readonly sentWhole: (account: string, body: SentBody) => void;
  readonly breakSentBodies: (broken: boolean) => void;
  // Reading the addresses they send from fails while broken, as when the connection drops.
  readonly breakSenders: (broken: boolean) => void;
  readonly breakReading: () => void;
  // The next batch move stops after this many mails, as when the connection drops partway.
  readonly stopMovesAfter: (count: number) => void;
  // Unsubscribing and removing drafts fail from now on, as when a list has only a web page or the server drops.
  readonly refuseUnsubscribes: () => void;
  readonly refuseDraftRemoval: () => void;
  readonly dropSent: (times: number) => void;
  readonly health: (account: string, health: Health) => void;
};

type Box = {
  readonly inbox: readonly Mail[];
  readonly watchers: ReadonlySet<(mail: Mail) => void>;
  readonly files: ReadonlyMap<string, readonly AttachmentContent[]>;
};

// A draft as it reads back from Drafts.
const savedMail = (account: string, messageId: string, draft: Draft, date: string): Mail => ({
  account,
  folder: "Drafts",
  uid: 1,
  messageId,
  ...(draft.inReplyTo !== undefined && { inReplyTo: draft.inReplyTo }),
  references: [...new Set([...(draft.references ?? []), ...(draft.inReplyTo === undefined ? [] : [draft.inReplyTo])])],
  from: draft.from,
  to: draft.to,
  cc: draft.cc ?? [],
  subject: draft.subject,
  date,
  text: draft.body,
  flags: ["\\Draft", "\\Seen"],
  body: { from: "text" },
  attachments: [
    ...(draft.inline ?? []).map(({ filename, contentType, content }, index) => ({
      id: `1.${String(index + 2)}`,
      filename,
      contentType,
      size: content.length,
      inline: true,
    })),
    ...(draft.attachments ?? []).map(({ filename, contentType, content }, index) => ({
      id: String(index + 2),
      filename: attachedName(filename),
      contentType,
      size: content.length,
      inline: false,
    })),
  ],
});

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
  const deleted = createCell<readonly string[]>([]);
  const moves = createCell<readonly Moved[]>([]);
  const marked = createCell<readonly Mark[]>([]);
  const unsubscribes = createCell<readonly string[]>([]);
  const sentMail = createCell<ReadonlyMap<string, readonly Mail[]>>(new Map());
  const isBroken = createCell(false);
  const sentDrops = createCell(0);
  const bodies = createCell<ReadonlyMap<string, readonly SentBody[]>>(new Map());
  const isSentBroken = createCell(false);
  const isSendersBroken = createCell(false);
  const moveLimit = createCell<number | undefined>(undefined);
  const isUnsubscribeRefused = createCell(false);
  const isRemovalRefused = createCell(false);
  const healthListeners = createCell<ReadonlyMap<string, (health: Health) => void>>(new Map());

  const boxOf = (account: string): Box =>
    boxes.get().get(account) ?? { inbox: [], watchers: new Set(), files: new Map() };

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
    cc: (mail.cc ?? []).map((address) => toAddress(address)),
    subject: mail.subject,
    date: mail.date ?? now(),
    text: mail.text,
    ...(mail.full_text !== undefined && { fullText: mail.full_text }),
    ...((mail.unsubscribe !== undefined || mail.unsubscribe_mailto !== undefined) && {
      unsubscribe: {
        ...(mail.unsubscribe !== undefined && { post: mail.unsubscribe, url: mail.unsubscribe }),
        ...(mail.unsubscribe_mailto !== undefined && { mailto: mail.unsubscribe_mailto }),
      },
    }),
    flags: [],
    ...(mail.files !== undefined &&
      mail.files.length > 0 && {
        attachments: mail.files.map(({ id, filename, contentType, content }) => ({
          id,
          ...(filename !== undefined && { filename }),
          contentType,
          size: content.length,
          inline: false,
        })),
      }),
  });

  const keepFiles = (account: string, mail: Omit<ArrivingMail, "account">): void => {
    const files = (mail.files ?? []).map(({ id, filename, contentType, content }) => ({
      id,
      ...(filename !== undefined && { filename }),
      contentType,
      size: content.length,
      inline: false,
      content,
    }));
    change(account, (box) => ({ ...box, files: new Map([...box.files, [mail.message_id, files]]) }));
  };

  // Records the move and puts the mail there, a filing by its folder, as the server would: flags leave it in place.
  const move = (account: string, messageId: string, to: string): string => {
    const origin = boxOf(account).inbox.find((mail) => mail.messageId === messageId)?.folder ?? "INBOX";
    const folder = to === "flag" || to === "unflag" ? origin : (folderPaths[to] ?? to);
    moves.update((all) => [...all, { account, messageId, to }]);
    change(account, (box) => ({
      ...box,
      inbox: box.inbox.map((mail) => (mail.messageId === messageId ? { ...mail, folder } : mail)),
    }));
    return origin;
  };

  const create = ({ account, onHealth }: SourceOptions): MailSource => {
    if (onHealth) healthListeners.update((all) => new Map([...all, [account, onHealth]]));
    return source(account);
  };

  const sentFrom = (account: string): readonly Mail[] => sentMail.get().get(account) ?? [];

  const sendersOf = (account: string): ReturnType<typeof rankSenders> =>
    rankSenders(sentFrom(account).map(({ from }) => from));

  const isTo = (mail: Mail, address: string): boolean =>
    [...mail.to, ...mail.cc].some((to) => isSameAddress(to.address, address));

  const source = (account: string): MailSource => ({
    account,
    check: () => Promise.resolve(ok({ senders: sendersOf(account), folders: 4 })),
    senders: () =>
      Promise.resolve(
        isSendersBroken.get()
          ? fail("Mail couldn't finish reading sent mail: Connection not available")
          : ok(sendersOf(account)),
      ),
    lastFrom: (address) => {
      const last = sentFrom(account).findLast((mail) => isTo(mail, address));
      return Promise.resolve(ok(last?.from.address.toLowerCase()));
    },
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
      const { replaces } = draft;
      const isRefused = replaces !== undefined && isRemovalRefused.get();
      if (replaces !== undefined && !isRefused) removed.update((all) => [...all, replaces]);
      const refused = { failure: "Mail couldn't finish removing the draft: Connection not available" };
      const replaced = isRefused ? refused : ("removed" as const);
      const answer = {
        messageId: next,
        saved: savedMail(account, next, draft, now()),
        ...(replaces !== undefined && { replaced }),
      };
      return Promise.resolve(ok(answer));
    },
    removeDraft: (messageId) => {
      if (isRemovalRefused.get()) {
        return Promise.resolve(fail("Mail couldn't finish removing the draft: Connection not available"));
      }
      removed.update((all) => [...all, messageId]);
      return Promise.resolve(ok("removed" as const));
    },
    // Every draft is there but the ones taken out, by Kumo or in their mail app.
    hasDraft: (messageId) =>
      Promise.resolve(ok(!removed.get().includes(messageId) && !deleted.get().includes(messageId))),
    mark: (messageIds, marking) => {
      const known = new Set(boxOf(account).inbox.map(({ messageId }) => messageId));
      const changed = messageIds.filter((id) => known.has(id));
      marked.update((all) => [...all, ...changed.map((messageId) => ({ account, messageId, ...marking }))]);
      return Promise.resolve(ok({ changed, missing: messageIds.filter((id) => !known.has(id)) }));
    },
    attachment: (messageId, id) => {
      const file = boxOf(account)
        .files.get(messageId)
        ?.find((candidate) => candidate.id === id);
      return Promise.resolve(file ? ok(file) : fail(`That mail has no attachment ${id}.`));
    },
    file: (messageId, filing) => {
      move(account, messageId, filing);
      return Promise.resolve(ok(undefined));
    },
    fileInto: (messageId, folder) => Promise.resolve(ok({ origin: move(account, messageId, folder) })),
    hasWritten: (address) =>
      Promise.resolve(
        ok((sentMail.get().get(account) ?? []).some((mail) => mail.to.some((to) => has(to.address, address)))),
      ),
    // One-click when the list has it, or else the mail that leaves it, as the real source gives.
    unsubscribe: (mail) => {
      const letter = toLetter(mail.unsubscribe?.mailto ?? "");
      const hasPost = mail.unsubscribe?.post !== undefined;
      if (isUnsubscribeRefused.get() || (!hasPost && letter === undefined)) {
        return Promise.resolve(fail("This list only unsubscribes on its web page: https://mail.pizza.example/leave"));
      }
      if (!hasPost && letter !== undefined) return Promise.resolve(ok({ letter }));
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
      keepFiles(account, mail);
      const kept = { ...toMail(account, mail, boxOf(account).inbox.length + 1), folder };
      change(account, (box) => ({ ...box, inbox: [...box.inbox, kept] }));
    },
    folderOf: (account, messageId) => boxOf(account).inbox.find((mail) => mail.messageId === messageId)?.folder,
    arrive: ({ account, ...mail }) => {
      keepFiles(account, mail);
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
    deleteInMail: (messageId) => {
      deleted.update((all) => [...all, messageId]);
    },
    moved: () => moves.get(),
    marks: () => marked.get(),
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
    breakSenders: (broken) => {
      isSendersBroken.set(broken);
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
