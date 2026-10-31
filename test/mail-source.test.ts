import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { simpleParser } from "mailparser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCell } from "#cell.ts";
import { backoffMs, createMailSource, toUidSet, type MailSource } from "#mail/imap.ts";
import {
  groupThreads,
  parseMail,
  threadKey,
  threadOf,
  toDraftMime,
  toMail,
  toMessageIds,
  toUnsubscribe,
  trimQuoted,
  type Draft,
  type Mail,
  type MailMeta,
} from "#mail/message.ts";
import { providers } from "#mail/providers.ts";
import { postOneClick, toLetter, unsubscribeFrom, type Fetch } from "#mail/unsubscribe.ts";

type Connection = { readonly directNotifications?: boolean; readonly socket?: { readonly destroy: () => void } };

type Hoodiecrow = {
  readonly listen: (port: number, host: string, callback: () => void) => void;
  readonly close: (callback: () => void) => void;
  readonly address: () => AddressInfo;
  readonly appendMessage: (folder: string, flags: readonly string[], receivedAt: Date, raw: string) => unknown;
  readonly connections: ReadonlySet<Connection>;
};

const createHoodiecrow = createRequire(import.meta.url)("hoodiecrow-imap") as (
  options: Readonly<Record<string, unknown>>,
) => Hoodiecrow;

const fixture = (name: string): string =>
  readFileSync(path.join(import.meta.dirname, "support", "mail", `${name}.eml`), "utf8");

const wire = (raw: string): string => raw.replaceAll(/\r?\n/g, "\r\n");

const meta: MailMeta = { account: "icloud", folder: "INBOX", uid: 7, flags: ["\\Seen"] };

const parsed = (name: string): Promise<Mail> => parseMail(fixture(name), meta);

const ids = {
  booking: "confirm.4471-2290.20261028091400@stays.example",
  newsletter: "20261023113000.77ab.weekly@mailer.fieldnotes.example",
  start: "CAF3x9k2.lena.start.1@mail.studio.example",
  question: "a81f2c90-1b7e-4c5e-9d1a-2f3e4d5c6b7a@example.com",
  reply: "CAF3x9k2.lena.reply.3@mail.studio.example",
};

const replyDraft: Draft = {
  from: { address: "sam@example.com", name: "Sam Rivera" },
  to: [{ address: "lena@studio.example", name: "Lena Okafor" }],
  cc: [{ address: "theo@studio.example", name: "Theo Park" }],
  subject: "Re: Café plans – Thursday",
  body: "Thursday it is. Café Lumière at 10:00 — see you there.\n\nSam",
  inReplyTo: ids.reply,
  references: [ids.start, ids.question],
};

const offline = (fetcher: typeof fetch): MailSource =>
  createMailSource({
    account: "icloud",
    user: "sam@example.com",
    auth: { password: "unused" },
    imap: { host: "127.0.0.1", port: 9, secure: false },
    smtp: { host: "127.0.0.1", port: 9, secure: false },
    fetch: fetcher,
  });

const stored = (name: string, receivedAt: string, flags: readonly string[] = []) => ({
  raw: wire(fixture(name)),
  internaldate: new Date(receivedAt),
  flags,
});

const arrival = (count: number): string =>
  wire(
    [
      "From: Lena Okafor <lena@studio.example>",
      "To: Sam Rivera <sam@example.com>",
      `Subject: Note ${String(count)}`,
      "Date: Thu, 30 Oct 2026 10:00:00 +0000",
      `Message-ID: <arrival-${String(count)}@studio.example>`,
      "",
      `Note number ${String(count)}.`,
      "",
    ].join("\n"),
  );

const refuseToMail = (): Promise<never> => Promise.reject(new Error("Nothing should be mailed."));

const gone = { ok: false, failure: "That mail isn't in this account any more." };

const mailWith = (fields: Partial<Mail> & Pick<Mail, "messageId" | "date">): Mail => ({
  account: "gmail",
  folder: "INBOX",
  uid: 1,
  references: [],
  from: { address: "someone@example.com" },
  to: [],
  cc: [],
  subject: "",
  text: "",
  flags: [],
  ...fields,
});

describe("reading a mail", () => {
  it("turns a booking confirmation into plain words", async () => {
    const mail = toMail(await simpleParser(fixture("booking-confirmation")), meta);
    expect(mail).toMatchObject({
      account: "icloud",
      folder: "INBOX",
      uid: 7,
      messageId: ids.booking,
      references: [],
      from: { address: "noreply@stays.example", name: "Stays" },
      to: [{ address: "sam@example.com", name: "Sam Rivera" }],
      cc: [],
      subject: "Your booking is confirmed – Hôtel du Lac, Annecy",
      date: "2026-10-28T09:14:00.000Z",
      flags: ["\\Seen"],
    });
    expect(mail.text).toContain("Your booking at Hôtel du Lac is confirmed.");
    expect(mail.text).toContain("Total: €312.00 (paid)");
    expect(mail.text).not.toContain("<");
    expect(mail.inReplyTo).toBeUndefined();
    expect(mail.unsubscribe).toBeUndefined();
  });

  it("reads a newsletter's HTML as text and finds its one-click unsubscribe", async () => {
    const mail = await parsed("newsletter");
    expect(mail.messageId).toBe(ids.newsletter);
    expect(mail.date).toBe("2026-10-23T11:30:00.000Z");
    expect(mail.to).toEqual([{ address: "sam@example.com" }]);
    expect(mail.text).toContain("Three walks that are best in late October");
    expect(mail.text).not.toContain("color: #333333");
    expect(mail.unsubscribe).toEqual({
      post: "https://news.fieldnotes.example/u/77ab?list=weekly&sig=Zm9v",
      url: "https://news.fieldnotes.example/u/77ab?list=weekly&sig=Zm9v",
      mailto: "mailto:leave-77ab@news.fieldnotes.example?subject=unsubscribe%2077ab",
    });
  });

  it("keeps a reply's references and leaves out the quoted history", async () => {
    const mail = await parsed("reply-with-references");
    expect(mail).toMatchObject({
      messageId: ids.reply,
      inReplyTo: ids.question,
      references: [ids.start, ids.question],
      cc: [{ address: "theo@studio.example", name: "Theo Park" }],
      date: "2026-10-29T15:02:11.000Z",
    });
    expect(mail.text).toBe(
      "Thursday works for us. Theo can bring the projector, and I'll book the\nroom at Café Lumière for 10:00.\n\nLena",
    );
  });

  it("gives a mail without a Message-ID an id that still finds it", async () => {
    const mail = await parseMail("Subject: Hello\r\nFrom: a@example.com\r\n\r\nHi", {
      ...meta,
      folder: "Sent Messages",
      uid: 42,
      receivedAt: "2026-10-30T08:00:00.000Z",
    });
    expect(mail.messageId).toBe("42.Sent%20Messages@icloud.invalid");
    expect(mail.date).toBe("2026-10-30T08:00:00.000Z");
  });
});

describe("message ids", () => {
  it("reads bracketed, bare and repeated ids", () => {
    expect(toMessageIds("<a@x.example>\r\n <b@y.example> <a@x.example>")).toEqual(["a@x.example", "b@y.example"]);
    expect(toMessageIds(["<a@x.example>", "<c@z.example>"])).toEqual(["a@x.example", "c@z.example"]);
    expect(toMessageIds("bare@x.example")).toEqual(["bare@x.example"]);
    expect(toMessageIds(undefined)).toEqual([]);
  });
});

describe("unsubscribe headers", () => {
  it("offers one-click only for an https link with List-Unsubscribe-Post", () => {
    expect(
      toUnsubscribe({
        "list-unsubscribe": "<https://lists.example/u/1>, <mailto:u@lists.example>",
        "list-unsubscribe-post": "List-Unsubscribe=One-Click",
      }),
    ).toEqual({
      post: "https://lists.example/u/1",
      url: "https://lists.example/u/1",
      mailto: "mailto:u@lists.example",
    });
    expect(toUnsubscribe({ "list-unsubscribe": "<https://lists.example/u/1>" })).toEqual({
      url: "https://lists.example/u/1",
    });
    expect(
      toUnsubscribe({
        "list-unsubscribe": "<http://lists.example/u/1>",
        "list-unsubscribe-post": "List-Unsubscribe=One-Click",
      }),
    ).toEqual({ url: "http://lists.example/u/1" });
    expect(
      toUnsubscribe({
        "list-unsubscribe": "<mailto:u@lists.example>",
        "list-unsubscribe-post": "List-Unsubscribe=One-Click",
      }),
    ).toEqual({ mailto: "mailto:u@lists.example" });
  });

  it("joins a link folded inside its brackets and reads unbracketed lists", () => {
    expect(toUnsubscribe({ "list-unsubscribe": "<https://lists.example/u/\r\n 1?x=2>" })).toEqual({
      url: "https://lists.example/u/1?x=2",
    });
    expect(toUnsubscribe({ "list-unsubscribe": "mailto:u@lists.example, https://lists.example/u" })).toEqual({
      url: "https://lists.example/u",
      mailto: "mailto:u@lists.example",
    });
    expect(toUnsubscribe({})).toBeUndefined();
    expect(toUnsubscribe({ "list-unsubscribe": "<ftp://lists.example/u>" })).toBeUndefined();
  });
});

describe("quoted history", () => {
  it("cuts Outlook's header block and the line above it", () => {
    const text = [
      "Yes, send it over.",
      "",
      "________________________________",
      "From: Lena Okafor <lena@studio.example>",
      "Sent: Wednesday, October 29, 2026 4:02 PM",
      "To: Sam Rivera <sam@example.com>",
      "Subject: Re: Draft schedule",
      "",
      "Thursday works for us.",
    ].join("\r\n");
    expect(trimQuoted(text)).toBe("Yes, send it over.");
  });

  it("cuts an Original Message marker and trailing quotes, but keeps forwards and inline replies", () => {
    expect(trimQuoted("Noted.\n\n-----Original Message-----\nFrom: a@example.com\nHello")).toBe("Noted.");
    expect(trimQuoted("Agreed.\n\n> earlier words\n> more")).toBe("Agreed.");
    const forward = "FYI\n\n---------- Forwarded message ---------\nFrom: a@example.com\nDate: Tue\n\nBody";
    expect(trimQuoted(forward)).toBe(forward);
    const flight = "Your flight is booked.\n\nFrom: London Heathrow (LHR)\nTo: Lisbon (LIS)\nDate: 14 Nov 2026";
    expect(trimQuoted(flight)).toBe(flight);
    const inline = "> Can you do Thursday?\nYes.\n> And bring the projector?\nTheo will.";
    expect(trimQuoted(inline)).toBe(inline);
    expect(trimQuoted("> only quoted words")).toBe("> only quoted words");
  });
});

describe("drafts", () => {
  it("builds a UTF-8 reply with In-Reply-To and References ending in the parent", async () => {
    const mime = await toDraftMime(replyDraft, "draft-1@example.com", new Date("2026-10-30T09:00:00Z"));
    const raw = mime.toString();
    expect(raw).toContain("\r\n");
    expect(raw).not.toMatch(/[^\r]\n/);
    expect(raw).toContain("In-Reply-To: <CAF3x9k2.lena.reply.3@mail.studio.example>");
    expect(raw).toContain("Message-ID: <draft-1@example.com>");
    expect(raw).toContain("Content-Type: text/plain; charset=utf-8");
    const back = await parseMail(mime, { ...meta, folder: "Drafts", flags: ["\\Draft", "\\Seen"] });
    expect(back).toMatchObject({
      messageId: "draft-1@example.com",
      inReplyTo: ids.reply,
      references: [ids.start, ids.question, ids.reply],
      from: replyDraft.from,
      to: replyDraft.to,
      cc: replyDraft.cc,
      subject: replyDraft.subject,
      date: "2026-10-30T09:00:00.000Z",
      text: replyDraft.body,
    });
  });

  it("leaves reply headers out of a new mail", async () => {
    const mime = await toDraftMime(
      { from: { address: "sam@example.com" }, to: [{ address: "lena@studio.example" }], subject: "Hi", body: "Hello" },
      "draft-2@example.com",
      new Date("2026-10-30T09:00:00Z"),
    );
    const raw = mime.toString();
    expect(raw).not.toContain("In-Reply-To");
    expect(raw).not.toContain("References");
    expect(raw).not.toMatch(/^Cc:/m);
  });
});

describe("threads", () => {
  const start = mailWith({ messageId: "s@x", date: "2026-10-28T09:00:00.000Z" });
  const question = mailWith({
    messageId: "q@x",
    inReplyTo: "s@x",
    references: ["s@x"],
    date: "2026-10-29T09:00:00.000Z",
  });
  const reply = mailWith({
    messageId: "r@x",
    inReplyTo: "q@x",
    references: ["s@x", "q@x"],
    date: "2026-10-30T09:00:00.000Z",
  });
  const stray = mailWith({ messageId: "other@x", date: "2026-10-29T12:00:00.000Z" });

  it("keys a thread by its first reference", () => {
    expect(threadKey(reply)).toBe("s@x");
    expect(threadKey(mailWith({ messageId: "q@x", inReplyTo: "s@x", date: "2026-10-29T09:00:00.000Z" }))).toBe("s@x");
    expect(threadKey(start)).toBe("s@x");
  });

  it("groups mails by their references, oldest first, without repeats", () => {
    const groups = groupThreads([reply, stray, start, question, { ...reply, folder: "Archive" }]);
    expect(groups.map((group) => group.map((mail) => mail.messageId))).toEqual([["s@x", "q@x", "r@x"], ["other@x"]]);
    expect(threadOf("q@x", [reply, stray, start, question]).map((mail) => mail.messageId)).toEqual([
      "s@x",
      "q@x",
      "r@x",
    ]);
  });

  it("joins two branches once a mail refers to both", () => {
    const left = mailWith({ messageId: "l@x", inReplyTo: "s@x", references: ["s@x"], date: "2026-10-29T00:00:00Z" });
    const lone = mailWith({ messageId: "n@x", inReplyTo: "m@x", date: "2026-10-29T01:00:00Z" });
    const bridge = mailWith({ messageId: "b@x", references: ["l@x", "m@x"], date: "2026-10-29T02:00:00Z" });
    expect(groupThreads([left, lone, bridge])).toHaveLength(1);
  });
});

describe("unsubscribing", () => {
  type Call = { readonly url: string; readonly init: RequestInit | undefined };

  const recorder = (status: number) => {
    const calls = createCell<readonly Call[]>([]);
    const fetcher: typeof fetch = (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      calls.update((current) => [...current, { url, init }]);
      return Promise.resolve(new Response(null, { status }));
    };
    return { calls, fetcher };
  };

  it("posts RFC 8058 one-click and never GETs", async () => {
    const { calls, fetcher } = recorder(200);
    const mail = await parsed("newsletter");
    expect(await offline(fetcher).unsubscribe(mail)).toEqual({ ok: true, value: "posted" });
    expect(calls.get()).toHaveLength(1);
    const [call] = calls.get();
    expect(call?.url).toBe("https://news.fieldnotes.example/u/77ab?list=weekly&sig=Zm9v");
    expect(call?.init).toMatchObject({
      method: "POST",
      body: "List-Unsubscribe=One-Click",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      redirect: "manual",
    });
    expect(calls.get().every(({ init }) => init?.method === "POST")).toBe(true);
  });

  it("doesn't open a list's web page when there's no one-click", async () => {
    const { calls, fetcher } = recorder(200);
    const outcome = await offline(fetcher).unsubscribe(
      mailWith({ messageId: "n@x", date: "2026-10-30T00:00:00Z", unsubscribe: { url: "https://lists.example/u/1" } }),
    );
    expect(outcome).toEqual({
      ok: false,
      failure: "This list only unsubscribes on its web page: https://lists.example/u/1",
    });
    expect(calls.get()).toEqual([]);
  });

  it("mails the list when the one-click POST is refused", async () => {
    const { calls, fetcher } = recorder(500);
    const letters = createCell<readonly unknown[]>([]);
    const outcome = await unsubscribeFrom(await parsed("newsletter"), {
      fetch: fetcher,
      from: "sam@example.com",
      send: (letter) => {
        letters.update((current) => [...current, letter]);
        return Promise.resolve({ ok: true, value: undefined });
      },
    });
    expect(outcome).toEqual({ ok: true, value: "mailed" });
    expect(calls.get().map(({ init }) => init?.method)).toEqual(["POST"]);
    expect(letters.get()).toEqual([
      {
        from: "sam@example.com",
        to: "leave-77ab@news.fieldnotes.example",
        subject: "unsubscribe 77ab",
        text: "unsubscribe",
      },
    ]);
  });

  it("says why when there's nothing to unsubscribe from or the link isn't https", async () => {
    const { calls, fetcher } = recorder(200);
    const narrowed: Fetch = fetcher;
    expect(await unsubscribeFrom({}, { fetch: narrowed, from: "sam@example.com", send: refuseToMail })).toEqual({
      ok: false,
      failure: "This mail has no unsubscribe link.",
    });
    expect(await postOneClick(narrowed, "http://lists.example/u")).toEqual({
      ok: false,
      failure: "One-click unsubscribing needs an https link.",
    });
    expect(calls.get()).toEqual([]);
  });

  it("reads mailto links", () => {
    expect(toLetter("mailto:list@lists.example?subject=Remove%20me&body=please+stop", "sam@example.com")).toEqual({
      from: "sam@example.com",
      to: "list@lists.example",
      subject: "Remove me",
      text: "please+stop",
    });
    expect(toLetter("MAILTO:list@lists.example?", "sam@example.com")).toMatchObject({ subject: "unsubscribe" });
    expect(toLetter("mailto:?subject=x", "sam@example.com")).toBeUndefined();
    expect(toLetter("https://lists.example", "sam@example.com")).toBeUndefined();
  });
});

describe("plumbing helpers", () => {
  it("backs off up to five minutes and packs UIDs into ranges", () => {
    expect([1, 2, 3, 20].map(backoffMs)).toEqual([1000, 2000, 4000, 300_000]);
    expect(toUidSet([9, 1, 2, 3, 5, 10, 2])).toBe("1:3,5,9:10");
    expect(toUidSet([])).toBe("");
  });

  it("knows the three providers", () => {
    expect(providers.icloud).toEqual({
      imap: { host: "imap.mail.me.com", port: 993, secure: true },
      smtp: { host: "smtp.mail.me.com", port: 587, secure: false },
    });
    expect(providers.outlook.smtp).toEqual({ host: "smtp-mail.outlook.com", port: 587, secure: false });
    expect(providers.gmail.imap.host).toBe("imap.gmail.com");
  });
});

describe("over IMAP", () => {
  const server = createCell<Hoodiecrow | undefined>(undefined);
  const opened = createCell<MailSource | undefined>(undefined);

  const running = (): Hoodiecrow => {
    const current = server.get();
    if (current === undefined) throw new Error("The IMAP server isn't running.");
    return current;
  };

  const connect = (password = "app-password"): MailSource => {
    const source = createMailSource({
      account: "icloud",
      user: "sam@example.com",
      auth: { password },
      imap: { host: "127.0.0.1", port: running().address().port, secure: false },
    });
    opened.set(source);
    return source;
  };

  beforeEach(async () => {
    const hoodiecrow = createHoodiecrow({
      plugins: ["IDLE", "MOVE", "SPECIAL-USE", "UIDPLUS", "ID", "NAMESPACE", "OBJECTID"],
      users: { "sam@example.com": { password: "app-password" } },
      storage: {
        INBOX: {
          messages: [
            stored("newsletter", "2026-10-23T11:30:04Z"),
            stored("booking-confirmation", "2026-10-28T09:14:02Z"),
            stored("reply-with-references", "2026-10-29T15:02:13Z"),
          ],
        },
        "": {
          separator: "/",
          folders: {
            Archive: { "special-use": "\\Archive", messages: [stored("workshop-start", "2026-10-28T09:15:44Z")] },
            Drafts: { "special-use": "\\Drafts" },
            "Sent Messages": {
              "special-use": "\\Sent",
              messages: [stored("workshop-question", "2026-10-29T14:40:06Z", ["\\Seen"])],
            },
            "Deleted Messages": { "special-use": "\\Trash" },
          },
        },
      },
    });
    await new Promise<void>((resolve) => {
      hoodiecrow.listen(0, "127.0.0.1", resolve);
    });
    server.set(hoodiecrow);
  });

  afterEach(async () => {
    await opened.get()?.close();
    opened.set(undefined);
    const hoodiecrow = server.get();
    server.set(undefined);
    if (hoodiecrow !== undefined) {
      await new Promise<void>((resolve) => {
        hoodiecrow.close(resolve);
      });
    }
  });

  it("logs in, counts the folders and learns the addresses used to send", async () => {
    expect(await connect().check()).toEqual({ ok: true, value: { addresses: ["sam@example.com"], folders: 5 } });
  });

  it("explains a refused sign-in in plain words", async () => {
    const checked = await connect("wrong").check();
    expect(checked.ok).toBe(false);
    expect(checked.ok ? "" : checked.failure).toContain("127.0.0.1 didn't accept the sign-in for sam@example.com.");
    expect(checked.ok ? "" : checked.failure).toContain("app-specific password");
  });

  it("catches up on the inbox and the archive since a date", async () => {
    const recent = await connect().recent("2026-10-25T00:00:00.000Z");
    expect(recent.ok ? recent.value.map(({ messageId, folder }) => [folder, messageId]) : recent.failure).toEqual([
      ["INBOX", ids.booking],
      ["Archive", ids.start],
      ["INBOX", ids.reply],
    ]);
  });

  it("reads, files and flags a mail by its Message-ID", async () => {
    const source = connect();
    const folderOf = async (): Promise<string> => {
      const read = await source.read(ids.booking);
      return read.ok ? read.value.folder : read.failure;
    };
    expect(await folderOf()).toBe("INBOX");
    expect(await source.file(ids.booking, "archive")).toEqual({ ok: true, value: undefined });
    expect(await folderOf()).toBe("Archive");
    expect(await source.file(ids.booking, "flag")).toEqual({ ok: true, value: undefined });
    const flagged = await source.read(ids.booking);
    expect(flagged.ok && flagged.value.flags).toContain("\\Flagged");
    expect(await source.file(ids.booking, "unflag")).toEqual({ ok: true, value: undefined });
    const unflagged = await source.read(ids.booking);
    expect(unflagged.ok && unflagged.value.flags).not.toContain("\\Flagged");
    expect(await source.file(ids.booking, "inbox")).toEqual({ ok: true, value: undefined });
    expect(await folderOf()).toBe("INBOX");
    expect(await source.file(ids.booking, "bin")).toEqual({ ok: true, value: undefined });
    expect(await folderOf()).toBe("Deleted Messages");
    expect(await source.file("missing@example.com", "archive")).toEqual(gone);
  });

  it("saves a draft reply, replaces it and removes it", async () => {
    const source = connect();
    const first = await source.draft(replyDraft);
    if (!first.ok) throw new Error(first.failure);
    expect(first.value.messageId).toMatch(/^[\da-f-]{36}@example\.com$/);
    const saved = await source.read(first.value.messageId);
    expect(saved.ok && saved.value).toMatchObject({
      folder: "Drafts",
      inReplyTo: ids.reply,
      references: [ids.start, ids.question, ids.reply],
      subject: replyDraft.subject,
      text: replyDraft.body,
    });
    expect(saved.ok && saved.value.flags).toEqual(expect.arrayContaining(["\\Draft", "\\Seen"]));

    const second = await source.draft({
      ...replyDraft,
      body: "Thursday at 10:30 instead.",
      replaces: first.value.messageId,
    });
    if (!second.ok) throw new Error(second.failure);
    expect(await source.read(first.value.messageId)).toEqual(gone);
    const replaced = await source.read(second.value.messageId);
    expect(replaced.ok && replaced.value.text).toBe("Thursday at 10:30 instead.");

    expect(await source.removeDraft(second.value.messageId)).toEqual({ ok: true, value: undefined });
    expect(await source.read(second.value.messageId)).toEqual(gone);
    expect(await source.removeDraft(ids.booking)).toEqual({
      ok: false,
      failure: "That draft isn't in the Drafts folder any more.",
    });
    expect(await source.read(ids.booking)).toMatchObject({ ok: true, value: { folder: "INBOX" } });
  });

  it("follows a conversation across the inbox, the archive and Sent", async () => {
    const thread = await connect().thread(ids.reply);
    expect(thread.ok ? thread.value.map(({ messageId, folder }) => [folder, messageId]) : thread.failure).toEqual([
      ["Archive", ids.start],
      ["Sent Messages", ids.question],
      ["INBOX", ids.reply],
    ]);
  });

  it("searches by sender, subject and words, newest first", async () => {
    const source = connect();
    const bySender = await source.search({ from: "lena@studio.example" });
    expect(bySender.ok ? bySender.value.map(({ messageId }) => messageId) : bySender.failure).toEqual([
      ids.reply,
      ids.start,
    ]);
    const bySubject = await source.search({ subject: "autumn trails" });
    expect(bySubject.ok ? bySubject.value.map(({ messageId }) => messageId) : bySubject.failure).toEqual([
      ids.newsletter,
    ]);
    const byWords = await source.search({ text: "projector", since: "2026-10-29" });
    expect(byWords.ok ? byWords.value.map(({ messageId }) => messageId) : byWords.failure).toEqual([ids.reply]);
    expect(await source.search({})).toEqual({
      ok: false,
      failure: "Say what to look for: a sender, a subject, words or a date.",
    });
    expect(await source.search({ since: "someday" })).toEqual({ ok: false, failure: '"someday" isn\'t a date.' });
  });

  it("reads the Sent folder", async () => {
    const sent = await connect().sent("2026-10-01");
    expect(sent.ok ? sent.value.map(({ messageId, folder }) => [folder, messageId]) : sent.failure).toEqual([
      ["Sent Messages", ids.question],
    ]);
  });

  it("hears new mail while IDLE, and what arrived while it was disconnected", async () => {
    const source = connect();
    const arrived = createCell<readonly string[]>([]);
    const idling = (): boolean => [...running().connections].some((connection) => connection.directNotifications);
    const stop = source.watch((mail) => {
      arrived.update((current) => [...current, mail.messageId]);
    });
    await vi.waitFor(() => {
      expect(idling()).toBe(true);
    });
    running().appendMessage("INBOX", [], new Date(), arrival(1));
    await vi.waitFor(() => {
      expect(arrived.get()).toEqual(["arrival-1@studio.example"]);
    });

    for (const connection of running().connections) connection.socket?.destroy();
    running().appendMessage("INBOX", [], new Date(), arrival(2));
    await vi.waitFor(
      () => {
        expect(arrived.get()).toEqual(["arrival-1@studio.example", "arrival-2@studio.example"]);
      },
      { timeout: 10_000 },
    );
    stop();
    running().appendMessage("INBOX", [], new Date(), arrival(3));
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(arrived.get()).toHaveLength(2);
  });
});
