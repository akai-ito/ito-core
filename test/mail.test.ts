import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { createCell } from "#cell.ts";
import type { Values } from "#capabilities/manifest.ts";
import type { CardAnswer, CardHandler, DeskKeeper, NewCard, NewDone, Undoer } from "#desk/desk.ts";
import type { Mail, MailSource } from "#mail/imap.ts";
import { createMailbox, type Mailbox } from "#mail/mail.ts";
import type { CalendarItem, Card, DoneEntry, Message } from "#protocol/types.ts";
import { fail, ok, type Result } from "#result.ts";
import type { Tool } from "#tools/mcp.ts";
import { createWorkTools } from "#work/tools.ts";
import { createFakeMail, type FakeMail } from "./support/fake-mail.ts";
import { createVirtualClock } from "./support/virtual-clock.ts";

type Box = {
  readonly mailbox: Mailbox;
  readonly mail: FakeMail;
  readonly done: () => readonly DoneEntry[];
  readonly cards: () => readonly Card[];
  readonly prompts: () => readonly string[];
  // What the quick model was asked, such as a draft's rewrite.
  readonly asked: () => readonly string[];
  readonly undo: (entry: DoneEntry) => Promise<Result<undefined, string>>;
  readonly addDraftCard: (card: NewCard, at: string) => Card;
  readonly addCard: (card: NewCard) => Card;
  readonly runSentCheck: () => Promise<void>;
  // Answers a card as the Desk would, through the handler for its kind, and gives what takes its place.
  readonly answer: (card: Card, answer: CardAnswer) => Promise<NewCard | undefined>;
};

type Act = (prompt: string, tools: readonly Tool[]) => Promise<void>;

const icloud = { apple_id: "divy@icloud.com", app_password: "abcd-efgh-ijkl-mnop" };

const outlook = { address: "divy@outlook.example", token: "a-token" };

const onlyIcloud: Readonly<Record<string, Values>> = { icloud };

type BoxOptions = {
  readonly comingUp?: readonly CalendarItem[];
  readonly accounts?: Readonly<Record<string, Values>>;
  // The mail server as the mailbox sees it, such as one that tells of a mail before a move has finished.
  readonly server?: (source: MailSource, mail: FakeMail) => MailSource;
};

const booking = {
  account: "icloud",
  message_id: "confirm-1@hotel.example",
  from: "Hotel Orto <reservations@hotelorto.it>",
  to: ["divy@icloud.com"],
  subject: "Booking confirmed",
  text: "Your stay is confirmed.",
};

const ignore = (): void => undefined;

// A message Kumo posted, as the store would keep it.
const message = (text: string): Message => ({
  id: "m_1",
  role: "agent",
  kind: "post",
  text,
  at: "2026-11-01T09:00:00.000Z",
  position: 1,
});

const sent = (date: string, inReplyTo: string, text: string, fields: Partial<Mail> = {}): Mail => ({
  account: "icloud",
  folder: "Sent",
  uid: 1,
  messageId: `sent-${date}@icloud.com`,
  ...(inReplyTo !== "" && { inReplyTo }),
  references: [],
  from: { address: "divy@icloud.com" },
  to: [{ address: "reservations@hotelorto.it" }],
  cc: [],
  subject: "Re: Booking confirmed",
  date,
  text,
  flags: [],
  ...fields,
});

const nothing: Act = () => Promise.resolve();

const toolCalled = async (tools: readonly Tool[], name: string, input: unknown): Promise<void> => {
  const called = await tools.find((tool) => tool.name === name)?.call(input);
  if (called?.isError === true) throw new Error(called.text);
};

const clearNorthwind: Act = async (prompt, tools) => {
  const [, card = ""] = /Confirm the Northwind interviews.*\((k_\d+)\)/u.exec(prompt) ?? [];
  if (card !== "") await toolCalled(tools, "clear_card", { card, reason: "You confirmed them by mail" });
};

const openBox = (
  decision: string,
  works: readonly Result<string, string>[] = [],
  act: Act = nothing,
  { comingUp = [], accounts = onlyIcloud, server = (source) => source }: BoxOptions = {},
): Box => {
  const clock = createVirtualClock(Date.parse("2026-11-10T22:00:00.000Z"));
  const mail = createFakeMail(() => new Date(clock.now()).toISOString());
  const settings = createCell<ReadonlyMap<string, string>>(new Map());
  const done = createCell<readonly (DoneEntry & { readonly payload?: unknown })[]>([]);
  const cards = createCell<readonly Card[]>([]);
  const undoers = createCell<readonly Undoer[]>([]);
  const kinds = createCell<ReadonlyMap<string, CardHandler>>(new Map());
  const prompts = createCell<readonly string[]>([]);
  const asked = createCell<readonly string[]>([]);
  const results = createCell(works);
  const addCard = (card: NewCard, at = new Date(clock.now()).toISOString()): Card => {
    const added: Card = { ...card, id: `k_${String(cards.get().length + 1)}`, at };
    cards.update((current) => [...current, added]);
    return added;
  };
  const desk = {
    addCard: (card: NewCard) => addCard(card),
    cards: () => cards.get(),
    removeCard: (id: string) => {
      cards.update((current) => current.filter((card) => card.id !== id));
    },
    replaceCard: (id: string, card: NewCard) => {
      cards.update((current) => current.map((waiting) => (waiting.id === id ? { ...waiting, ...card } : waiting)));
    },
    handle: (kind: string, handler: CardHandler) => {
      kinds.update((current) => new Map([...current, [kind, handler]]));
    },
    onUndo: (undoer: Undoer) => {
      undoers.update((current) => [...current, undoer]);
    },
    addDone: ({ undo, ...entry }: NewDone) => {
      const added: DoneEntry = { ...entry, id: `d_${String(done.get().length + 1)}`, at: "", undo: undo !== undefined };
      done.update((current) => [...current, { ...added, payload: undo }]);
      return added;
    },
  } as unknown as DeskKeeper;
  const workTools = createWorkTools({ post: (text) => message(text), desk });
  const mailbox = createMailbox({
    host: {
      find: (id) => {
        const values = accounts[id];
        return values && { id, state: "on", values, manifest: undefined as never };
      },
      subscribe: () => ignore,
    },
    store: {
      setting: (key) => settings.get().get(key),
      setSetting: (key, value) => {
        settings.update((current) => new Map([...current, [key, value]]));
      },
    },
    desk,
    clock,
    fetch: () => Promise.reject(new Error("No network in this test.")),
    complete: (prompt) => {
      asked.update((current) => [...current, prompt]);
      return Promise.resolve(ok({ decision, reason: "A test", confidence: 0.9 }));
    },
    quickChoice: () => Promise.resolve(undefined),
    work: async (prompt) => {
      prompts.update((current) => [...current, prompt]);
      const [next = ok("Done."), ...rest] = results.get();
      results.set(rest);
      await act(prompt, workTools);
      return next;
    },
    info: ignore,
    comingUp: () => comingUp,
    createSource: (options) => server(mail.create(options), mail),
    sentPollMs: 60_000,
  });
  return {
    mailbox,
    mail,
    done: () => done.get(),
    cards: () => cards.get(),
    prompts: () => prompts.get(),
    asked: () => asked.get(),
    undo: async (entry) => {
      const payload = done.get().find(({ id }) => id === entry.id)?.payload;
      const answered = await Promise.all(undoers.get().map((undoer) => undoer(entry, payload)));
      return answered.find((result) => !result.ok) ?? ok(undefined);
    },
    addDraftCard: (card, at) => addCard(card, at),
    addCard: (card) => addCard(card),
    runSentCheck: async () => {
      clock.runNext(clock.now() + 60_000);
      await delay(50);
    },
    answer: async (card, answer) => {
      const handler = kinds.get().get(card.kind);
      if (!handler) throw new Error(`Nothing handles a ${card.kind} card.`);
      return handler(card, answer);
    },
  };
};

const settled = async (check: () => void): Promise<void> => {
  await vi.waitFor(check, { timeout: 2000, interval: 10 });
};

describe("the mailbox", () => {
  it("says so in Done when it couldn't look at a mail, rather than dropping it", async () => {
    const box = openBox("work", [fail("Codex isn't signed in.")]);
    box.mail.arrive(booking);

    await settled(() => {
      expect(box.done()).toMatchObject([
        { text: `Couldn't look at "Booking confirmed" from Hotel Orto; it's still in your inbox`, quiet: false },
      ]);
    });
    await box.mailbox.close();
  });

  it("doesn't bin a mail again when an undo moves it back to the inbox", async () => {
    const box = openBox("notice");
    const block = box.mailbox.tools.find(({ name }) => name === "block");
    await block?.call({ sender: "reservations@hotelorto.it" });
    box.mail.arrive(booking);
    await settled(() => {
      expect(box.done()).toHaveLength(2);
    });
    const binned = box.done()[1];
    if (!binned) throw new Error("Nothing was binned.");

    const undone = await box.undo(binned);
    box.mail.arrive(booking);
    box.mail.arrive({ ...booking, message_id: "confirm-2@hotel.example" });

    expect(undone).toEqual({ ok: true, value: undefined });
    await settled(() => {
      expect(box.done().flatMap(({ mail }) => mail?.message_id ?? [])).toEqual([
        "confirm-1@hotel.example",
        "confirm-2@hotel.example",
      ]);
    });
    await box.mailbox.close();
  });

  it("fails the catch-up when no account could be read, so getting started can try again", async () => {
    const box = openBox("notice");
    box.mail.breakReading();

    const caughtUp = await box.mailbox.catchUp(ignore);

    expect(caughtUp).toEqual({ ok: false, failure: "The mail server refused the sign-in." });
    expect(box.prompts()).toEqual([]);
    await box.mailbox.close();
  });

  it("matches a sent mail to its draft only by the thread it answers, and only once the draft existed", async () => {
    const box = openBox("notice");
    const draft = {
      account: "icloud",
      from: "divy@icloud.com",
      to: ["reservations@hotelorto.it"],
      subject: "Re: Booking confirmed",
      body: "Could you leave the keys?",
      message_id: "draft-1@icloud.com",
      in_reply_to: "confirm-1@hotel.example",
    };
    const card = box.addDraftCard(
      { kind: "draft", title: "Note to Hotel Orto", options: [{ label: "Drop it" }], allows_text: true, draft },
      "2026-11-10T21:00:00.000Z",
    );
    box.mail.send("icloud", sent("2026-11-10T08:00:00.000Z", "confirm-1@hotel.example", "An earlier reply"));
    box.mail.send("icloud", sent("2026-11-10T21:30:00.000Z", "other@hotel.example", "Another thread"));

    await box.runSentCheck();
    expect(box.cards().map(({ id }) => id)).toEqual([card.id]);

    box.mail.send("icloud", sent("2026-11-10T22:30:00.000Z", "confirm-1@hotel.example", "Could you leave the keys?"));
    await box.runSentCheck();
    await settled(() => {
      expect(box.cards()).toEqual([]);
    });
    expect(box.prompts().map((prompt) => prompt.match(/Message-ID: \S+/gu))).toEqual([
      ["Message-ID: sent-2026-11-10T08:00:00.000Z@icloud.com", "Message-ID: sent-2026-11-10T21:30:00.000Z@icloud.com"],
      ["Message-ID: sent-2026-11-10T22:30:00.000Z@icloud.com"],
    ]);
    await box.mailbox.close();
  });

  it("clears a draft's card when Apple Mail sends it under headers of its own", async () => {
    const box = openBox("work");
    const draftTool = box.mailbox.tools.find(({ name }) => name === "draft");
    box.mail.arrive({
      account: "icloud",
      message_id: "interview-11-11@northwind.example",
      from: "Owen Hartley <Owen.Hartley@northwind.example>",
      to: ["divy@icloud.com"],
      subject: "Divy Bramhecha - Northwind Interview Confirmation 11/11",
      text: "Could you confirm the 11 November interviews?",
    });
    box.mail.arrive({
      account: "icloud",
      message_id: "second-notice@quillfielddental.example",
      from: "Quillfield Dental <reception@mail.quillfielddental.example>",
      to: ["divy@icloud.com"],
      subject: "Second Notice - Outstanding Balance",
      text: "Your balance is outstanding.",
    });
    await draftTool?.call({ reply_to: "interview-11-11@northwind.example", body: "Hi Owen, confirmed." });
    await draftTool?.call({ reply_to: "second-notice@quillfielddental.example", body: "Could I have it itemised?" });
    expect(box.cards().map(({ draft }) => draft?.in_reply_to)).toEqual([
      "interview-11-11@northwind.example",
      "second-notice@quillfielddental.example",
    ]);

    box.mail.send(
      "icloud",
      sent("2026-11-10T22:30:00.000Z", "", "Hi Owen, confirmed.", {
        messageId: "apple-1@icloud.com",
        to: [{ address: "Owen.Hartley@northwind.example", name: "Owen Hartley" }],
        subject: "Re: Divy Bramhecha - Northwind Interview Confirmation 11/11",
        references: ["interview-11-11@northwind.example"],
      }),
    );
    box.mail.send(
      "icloud",
      sent("2026-11-10T22:31:00.000Z", "", "Could I have it itemised?", {
        messageId: "apple-2@icloud.com",
        to: [{ address: "RECEPTION@mail.quillfielddental.example" }],
        subject: "RE:  Second Notice - Outstanding Balance",
      }),
    );
    await box.runSentCheck();

    await settled(() => {
      expect(box.cards()).toEqual([]);
    });
    await box.mailbox.close();
  });

  it("brings what his own reply answers up to date, from any mail app, once", async () => {
    const block: CalendarItem = {
      id: "e_1",
      uid: "admin-1@kumo",
      title: "Admin: Northwind reply and dental invoice",
      start: "2026-11-11T18:00:00.000Z",
      end: "2026-11-11T18:20:00.000Z",
      all_day: false,
      calendar: { name: "Kumo", kumo: true },
    };
    const theirs: CalendarItem = {
      ...block,
      id: "e_2",
      uid: "dinner@home",
      title: "Dinner",
      calendar: { name: "Home", kumo: false },
    };
    const box = openBox("quiet", [], clearNorthwind, { comingUp: [block, theirs] });
    const card = box.addCard({
      kind: "times",
      title: "Confirm the Northwind interviews",
      options: [{ label: "Draft it", acts: true }],
      allows_text: true,
      times: {
        purpose: "Interviews with Clara at Northwind",
        slots: [{ start: "2026-11-12T09:00:00.000Z", end: "2026-11-12T10:00:00.000Z" }],
      },
    });
    box.mail.send(
      "icloud",
      sent("2026-11-10T21:40:00.000Z", "invite-1@northwind.example", "Thursday at 9 works, thank you!", {
        to: [{ address: "clara@northwind.example" }],
        subject: "Re: Interviews",
      }),
    );

    await box.runSentCheck();
    await settled(() => {
      expect(box.cards()).toEqual([]);
    });
    await box.runSentCheck();

    expect(box.prompts()).toHaveLength(1);
    expect(box.prompts()[0]).toContain("Thursday at 9 works, thank you!");
    expect(box.prompts()[0]).toContain(
      `- Confirm the Northwind interviews: Interviews with Clara at Northwind (${card.id})`,
    );
    expect(box.prompts()[0]).toContain(
      "- Admin: Northwind reply and dental invoice, 2026-11-11T18:00:00.000Z to 2026-11-11T18:20:00.000Z (admin-1@kumo)",
    );
    expect(box.prompts()[0]).not.toContain("Dinner");
    expect(box.done()).toMatchObject([
      { text: "Took “Confirm the Northwind interviews” off Waiting on you", reason: "You confirmed them by mail" },
    ]);
    await box.mailbox.close();
  });

  it("reads Sent again after a dropped read, so no sent mail is skipped", async () => {
    const box = openBox("quiet");
    box.mail.send("icloud", sent("2026-11-10T21:40:00.000Z", "invoice-7@dental.example", "Paid this morning."));
    box.mail.dropSent(1);

    await box.runSentCheck();
    expect(box.prompts()).toEqual([]);

    await box.runSentCheck();
    await settled(() => {
      expect(box.prompts()).toHaveLength(1);
    });
    expect(box.prompts()[0]).toContain("Paid this morning.");
    await box.mailbox.close();
  });

  it("says so in Done when Kumo couldn't bring things up to date with a sent mail", async () => {
    const box = openBox("quiet", [fail("Codex isn't signed in.")]);
    box.mail.send("icloud", sent("2026-11-10T21:40:00.000Z", "invoice-7@dental.example", "Paid this morning."));

    await box.runSentCheck();
    await settled(() => {
      expect(box.done()).toMatchObject([
        {
          text: `Couldn't bring things up to date with your mail "Re: Booking confirmed"`,
          reason: "Codex isn't signed in.",
          quiet: false,
        },
      ]);
    });
    await box.mailbox.close();
  });

  it("addresses a reply where the mail asks answers to go, and a reply to their own mail to whom it went", async () => {
    const box = openBox("work");
    const draftTool = box.mailbox.tools.find(({ name }) => name === "draft");
    const read = box.mailbox.tools.find(({ name }) => name === "mail_read");
    box.mail.keep("INBOX", {
      account: "icloud",
      message_id: "role-2@hire.example",
      from: "Northwind Hiring <no-reply@hire.example>",
      reply_to: "Clara Voss <clara.voss@northwind.example>",
      to: ["divy@icloud.com"],
      subject: "Next steps",
      text: "Could you share times for a call?",
    });
    box.mail.keep("Sent Messages", {
      account: "icloud",
      message_id: "nudge-1@icloud.com",
      from: "Divy <divy@icloud.com>",
      to: ["Tess Harlow <tess.harlow@halcyon.example>"],
      subject: "The Halcyon deck",
      text: "Could you send the deck?",
    });

    const shown = await read?.call({ message_id: "role-2@hire.example" });
    await draftTool?.call({ reply_to: "role-2@hire.example", body: "Thursday at 10 works." });
    await draftTool?.call({ reply_to: "nudge-1@icloud.com", body: "Any news on the deck?" });

    expect(shown?.text).toContain("Reply-To: clara.voss@northwind.example\n");
    expect(box.mail.drafts().map(({ to }) => to)).toEqual([
      [{ address: "clara.voss@northwind.example", name: "Clara Voss" }],
      [{ address: "tess.harlow@halcyon.example", name: "Tess Harlow" }],
    ]);
    expect(box.cards().map(({ title, draft }) => [title, draft?.to])).toEqual([
      ["Draft to Clara Voss", ["clara.voss@northwind.example"]],
      ["Draft to Tess Harlow", ["tess.harlow@halcyon.example"]],
    ]);
    await box.mailbox.close();
  });

  it("replaces a draft in its own account, whichever account they have first", async () => {
    const box = openBox("work", [], nothing, { accounts: { icloud, outlook } });
    const draftTool = box.mailbox.tools.find(({ name }) => name === "draft");
    box.mail.keep("INBOX", { ...booking, account: "outlook", to: ["divy@outlook.example"] });
    await draftTool?.call({ account: "outlook", reply_to: booking.message_id, body: "Could you leave the keys?" });
    const [card] = box.cards();

    const redrafted = await draftTool?.call({ replaces: card?.id, body: "Could you leave the keys at the desk?" });

    expect(redrafted?.isError).toBeUndefined();
    expect(redrafted?.text).toContain("in place of the earlier one");
    expect(box.cards()).toMatchObject([
      { id: card?.id, draft: { account: "outlook", body: "Could you leave the keys at the desk?" } },
    ]);
    expect(box.mail.drafts().map(({ from }) => from.address)).toEqual(["divy@outlook.example", "divy@outlook.example"]);
    await box.mailbox.close();
  });

  it("never reads a mail as new when Kumo moves it back to the inbox", async () => {
    // The server tells of the mail back in the inbox before the move has finished, as IMAP may.
    const box = openBox("notice", [], nothing, {
      server: (source, mail) => ({
        ...source,
        file: (messageId, filing) => {
          if (filing === "inbox") mail.arrive(booking);
          return source.file(messageId, filing);
        },
      }),
    });
    box.mail.keep("Archive", booking);

    const moved = await box.mailbox.tools
      .find(({ name }) => name === "file_mail")
      ?.call({ message_id: booking.message_id, to: "inbox" });
    await delay(50);

    expect(moved?.text).toBe("Filed it: inbox.");
    expect(box.done()).toEqual([]);
    await box.mailbox.close();
  });

  it("says so in Done when a redraft they asked for or Drop it fails, and keeps the draft as it was", async () => {
    const box = openBox("work");
    const draftTool = box.mailbox.tools.find(({ name }) => name === "draft");
    box.mail.keep("INBOX", booking);
    await draftTool?.call({ reply_to: booking.message_id, body: "Could you leave the keys?" });
    const [card] = box.cards();
    if (!card) throw new Error("No draft was made.");
    box.mail.refuseDraftRemoval();

    // The model gives back no rewrite.
    const redrafted = await box.answer(card, { text: "Make it warmer" });
    await box.answer(card, { option: "Drop it" });

    expect(redrafted).toMatchObject({ title: card.title, draft: { body: "Could you leave the keys?" } });
    expect(box.done()).toMatchObject([
      {
        text: "Couldn't redraft “Draft to Hotel Orto”; it's back on your Desk as it was",
        reason: "The rewrite came back empty.",
      },
      {
        text: "Couldn't take “Draft to Hotel Orto” out of your Drafts",
        reason: "Mail couldn't finish removing the draft: Connection not available",
      },
    ]);
    await box.mailbox.close();
  });

  it("asks for a reply's rewrite as a reply's, and a new mail's as a new mail's", async () => {
    const box = openBox("work");
    const draftTool = box.mailbox.tools.find(({ name }) => name === "draft");
    box.mail.keep("INBOX", booking);
    await draftTool?.call({ reply_to: booking.message_id, body: "Could you leave the keys?" });
    await draftTool?.call({ to: ["leo@halcyon.example"], subject: "Sunday", body: "Still on for Sunday?" });
    const [reply, fresh] = box.cards();
    if (!reply || !fresh) throw new Error("No drafts were made.");

    await box.answer(reply, { text: "Make it warmer" });
    await box.answer(fresh, { text: "Make it shorter" });

    const rewrites = box.asked().filter((prompt) => prompt.startsWith("Rewrite this"));
    expect(rewrites.map((prompt) => prompt.split(" as asked", 1)[0])).toEqual([
      "Rewrite this draft reply",
      "Rewrite this draft of a new mail",
    ]);
    await box.mailbox.close();
  });

  it("shows the mail a mail answers in the style of its other headers", async () => {
    const box = openBox("work");
    box.mail.keep("INBOX", { ...booking, in_reply_to: "ask-1@icloud.com" });

    const shown = await box.mailbox.tools
      .find(({ name }) => name === "mail_read")
      ?.call({ message_id: booking.message_id });

    expect(shown?.text).toContain("\nIn-Reply-To: ask-1@icloud.com\n");
    await box.mailbox.close();
  });

  it("keeps the addresses the account check learned, and drafts nothing while none can be read", async () => {
    const box = openBox("work");
    const draftTool = box.mailbox.tools.find(({ name }) => name === "draft");
    const fromAlias = { address: "divy@halcyon.example", name: "Divy Bramhecha" };
    box.mail.send("icloud", sent("2026-11-01T09:00:00.000Z", "", "Hello", { from: fromAlias }));
    const toTess = { to: ["tess.harlow@halcyon.example"], subject: "Hello", body: "Free on Friday?", signature: false };
    box.mail.breakSenders(true);

    const unread = await draftTool?.call(toTess);
    box.mail.breakSenders(false);
    const checked = await box.mailbox.check("icloud", icloud);
    box.mail.breakSenders(true);
    const drafted = await draftTool?.call(toTess);

    expect(unread).toEqual({
      text:
        "Their addresses couldn't be read from their sent mail: Mail couldn't finish reading sent mail: Connection " +
        "not available",
      isError: true,
    });
    expect(checked).toEqual({ summary: "Connected: 4 mail folders." });
    expect(drafted?.isError).toBeUndefined();
    expect(box.mail.drafts().map(({ from }) => from)).toEqual([fromAlias]);
    await box.mailbox.close();
  });

  it("drafts nothing when their signature can't be read, rather than leave it off unsaid", async () => {
    const box = openBox("work");
    const draftTool = box.mailbox.tools.find(({ name }) => name === "draft");
    box.mail.keep("INBOX", booking);
    box.mail.breakSentBodies(true);

    const signed = await draftTool?.call({ reply_to: booking.message_id, body: "Could you leave the keys?" });
    const unsigned = await draftTool?.call({
      reply_to: booking.message_id,
      body: "Could you leave the keys?",
      signature: false,
    });

    expect(signed).toEqual({
      text:
        "Their signature couldn't be read from their sent mail: Mail couldn't finish reading sent mail: Connection " +
        "not available. Try again, or give --no-signature if they'd rather it went unsigned.",
      isError: true,
    });
    expect(unsigned?.isError).toBeUndefined();
    expect(box.mail.drafts()).toHaveLength(1);
    await box.mailbox.close();
  });
});
