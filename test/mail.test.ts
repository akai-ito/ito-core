import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { createCell } from "#cell.ts";
import type { DeskKeeper, NewCard, NewDone, Undoer } from "#desk/desk.ts";
import type { Mail } from "#mail/imap.ts";
import { createMailbox, type Mailbox } from "#mail/mail.ts";
import type { CalendarItem, Card, DoneEntry } from "#protocol/types.ts";
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
  readonly undo: (entry: DoneEntry) => Promise<Result<undefined, string>>;
  readonly addDraftCard: (card: NewCard, at: string) => Card;
  readonly addCard: (card: NewCard) => Card;
  readonly runSentCheck: () => Promise<void>;
};

type Act = (prompt: string, tools: readonly Tool[]) => Promise<void>;

const icloud = { apple_id: "divy@icloud.com", app_password: "abcd-efgh-ijkl-mnop" };

const booking = {
  account: "icloud",
  message_id: "confirm-1@hotel.example",
  from: "Hotel Orto <reservations@hotelorto.it>",
  to: ["divy@icloud.com"],
  subject: "Booking confirmed",
  text: "Your stay is confirmed.",
};

const ignore = (): void => undefined;

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

const clearCitadel: Act = async (prompt, tools) => {
  const [, card = ""] = /Confirm the Citadel interviews.*\((k_\d+)\)/u.exec(prompt) ?? [];
  if (card !== "") await toolCalled(tools, "clear_card", { card, reason: "You confirmed them by mail" });
};

const openBox = (
  decision: string,
  works: readonly Result<string, string>[] = [],
  act: Act = nothing,
  comingUp: readonly CalendarItem[] = [],
): Box => {
  const clock = createVirtualClock(Date.parse("2026-11-10T22:00:00.000Z"));
  const mail = createFakeMail(() => new Date(clock.now()).toISOString());
  const settings = createCell<ReadonlyMap<string, string>>(new Map());
  const done = createCell<readonly (DoneEntry & { readonly payload?: unknown })[]>([]);
  const cards = createCell<readonly Card[]>([]);
  const undoers = createCell<readonly Undoer[]>([]);
  const prompts = createCell<readonly string[]>([]);
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
    handle: ignore,
    onUndo: (undoer: Undoer) => {
      undoers.update((current) => [...current, undoer]);
    },
    addDone: ({ undo, ...entry }: NewDone) => {
      const added: DoneEntry = { ...entry, id: `d_${String(done.get().length + 1)}`, at: "", undo: undo !== undefined };
      done.update((current) => [...current, { ...added, payload: undo }]);
      return added;
    },
  } as unknown as DeskKeeper;
  const workTools = createWorkTools({ store: { postMessage: () => ({}) as never }, desk });
  const mailbox = createMailbox({
    host: {
      find: (id) => (id === "icloud" ? { id, state: "on", values: icloud, manifest: undefined as never } : undefined),
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
    complete: () => Promise.resolve(ok({ decision, reason: "A test", confidence: 0.9 })),
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
    createSource: mail.create,
    sentPollMs: 60_000,
  });
  return {
    mailbox,
    mail,
    done: () => done.get(),
    cards: () => cards.get(),
    prompts: () => prompts.get(),
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
      message_id: "interview-11-11@citadel.example",
      from: "Grayson McIntyre <Grayson.McIntyre@citadel.com>",
      to: ["divy@icloud.com"],
      subject: "Divy Bramhecha - Citadel Interview Confirmation 11/11",
      text: "Could you confirm the 11 November interviews?",
    });
    box.mail.arrive({
      account: "icloud",
      message_id: "second-notice@banningdental.example",
      from: "Banning Dental <blackfriars@mail.banningdental.co.uk>",
      to: ["divy@icloud.com"],
      subject: "Second Notice - Outstanding Balance",
      text: "Your balance is outstanding.",
    });
    await draftTool?.call({ reply_to: "interview-11-11@citadel.example", body: "Hi Grayson, confirmed." });
    await draftTool?.call({ reply_to: "second-notice@banningdental.example", body: "Could I have it itemised?" });
    expect(box.cards().map(({ draft }) => draft?.in_reply_to)).toEqual([
      "interview-11-11@citadel.example",
      "second-notice@banningdental.example",
    ]);

    box.mail.send(
      "icloud",
      sent("2026-11-10T22:30:00.000Z", "", "Hi Grayson, confirmed.", {
        messageId: "apple-1@icloud.com",
        to: [{ address: "Grayson.McIntyre@citadel.com", name: "Grayson McIntyre" }],
        subject: "Re: Divy Bramhecha - Citadel Interview Confirmation 11/11",
        references: ["interview-11-11@citadel.example"],
      }),
    );
    box.mail.send(
      "icloud",
      sent("2026-11-10T22:31:00.000Z", "", "Could I have it itemised?", {
        messageId: "apple-2@icloud.com",
        to: [{ address: "BLACKFRIARS@mail.banningdental.co.uk" }],
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
      title: "Admin: Citadel reply and dental invoice",
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
    const box = openBox("quiet", [], clearCitadel, [block, theirs]);
    const card = box.addCard({
      kind: "times",
      title: "Confirm the Citadel interviews",
      options: [{ label: "Draft it", acts: true }],
      allows_text: true,
      times: {
        purpose: "Interviews with Sarah at Citadel",
        slots: [{ start: "2026-11-12T09:00:00.000Z", end: "2026-11-12T10:00:00.000Z" }],
      },
    });
    box.mail.send(
      "icloud",
      sent("2026-11-10T21:40:00.000Z", "invite-1@citadel.example", "Thursday at 9 works, thank you!", {
        to: [{ address: "sarah@citadel.example" }],
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
      `- Confirm the Citadel interviews: Interviews with Sarah at Citadel (${card.id})`,
    );
    expect(box.prompts()[0]).toContain(
      "- Admin: Citadel reply and dental invoice, 2026-11-11T18:00:00.000Z to 2026-11-11T18:20:00.000Z (admin-1@kumo)",
    );
    expect(box.prompts()[0]).not.toContain("Dinner");
    expect(box.done()).toMatchObject([
      { text: "Took “Confirm the Citadel interviews” off Waiting on you", reason: "You confirmed them by mail" },
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
});
