import { createCell } from "#cell.ts";
import type { Draft, Mail, MailSource, SourceOptions } from "#mail/imap.ts";
import { fail, ok } from "#result.ts";

export type ArrivingMail = {
  readonly account: string;
  readonly message_id: string;
  readonly from: string;
  readonly to: readonly string[];
  readonly subject: string;
  readonly text: string;
};

export type FakeMail = {
  readonly create: (options: SourceOptions) => MailSource;
  readonly arrive: (mail: ArrivingMail) => void;
  readonly hold: (account: string, count: number) => void;
  readonly expectDrafts: (ids: readonly string[]) => void;
  readonly drafts: () => readonly Draft[];
  readonly send: (account: string, mail: Mail) => void;
  readonly breakReading: () => void;
};

type Box = { readonly inbox: readonly Mail[]; readonly watchers: ReadonlySet<(mail: Mail) => void> };

const toAddress = (text: string): Mail["from"] => {
  const named = /^(?<name>.*?)\s*<(?<address>[^>]+)>$/u.exec(text)?.groups;
  return named?.address === undefined ? { address: text } : { address: named.address, name: named.name ?? "" };
};

export const createFakeMail = (now: () => string): FakeMail => {
  const boxes = createCell<ReadonlyMap<string, Box>>(new Map());
  const draftIds = createCell<readonly string[]>([]);
  const saved = createCell<readonly Draft[]>([]);
  const sentMail = createCell<ReadonlyMap<string, readonly Mail[]>>(new Map());
  const isBroken = createCell(false);

  const boxOf = (account: string): Box => boxes.get().get(account) ?? { inbox: [], watchers: new Set() };

  const change = (account: string, update: (box: Box) => Box): void => {
    boxes.update((all) => new Map([...all, [account, update(boxOf(account))]]));
  };

  const toMail = (account: string, mail: Omit<ArrivingMail, "account">, uid: number): Mail => ({
    account,
    folder: "INBOX",
    uid,
    messageId: mail.message_id,
    references: [],
    from: toAddress(mail.from),
    to: mail.to.map((address) => toAddress(address)),
    cc: [],
    subject: mail.subject,
    date: now(),
    text: mail.text,
    flags: [],
  });

  const create = ({ account, user }: SourceOptions): MailSource => ({
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
    read: (messageId) => {
      const found = boxOf(account).inbox.find((mail) => mail.messageId === messageId);
      return Promise.resolve(found ? ok(found) : fail("That mail isn't in this account any more."));
    },
    search: () => Promise.resolve(ok([])),
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
    removeDraft: () => Promise.resolve(ok(undefined)),
    file: () => Promise.resolve(ok(undefined)),
    unsubscribe: () => Promise.resolve(ok("posted" as const)),
    sent: () => Promise.resolve(ok(sentMail.get().get(account) ?? [])),
    close: () => Promise.resolve(),
  });

  return {
    create,
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
    send: (account, mail) => {
      sentMail.update((all) => new Map([...all, [account, [...(all.get(account) ?? []), mail]]]));
    },
    breakReading: () => {
      isBroken.set(true);
    },
  };
};
