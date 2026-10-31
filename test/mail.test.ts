import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { createCell } from "#cell.ts";
import type { DeskKeeper, NewCard, NewDone, Undoer } from "#desk/desk.ts";
import type { Mail } from "#mail/imap.ts";
import { createMailbox, type Mailbox } from "#mail/mail.ts";
import type { Card, DoneEntry } from "#protocol/types.ts";
import { fail, ok, type Result } from "#result.ts";
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
  readonly runSentCheck: () => Promise<void>;
};

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

const sent = (date: string, inReplyTo: string, text: string): Mail => ({
  account: "icloud",
  folder: "Sent",
  uid: 1,
  messageId: `sent-${date}@icloud.com`,
  inReplyTo,
  references: [],
  from: { address: "divy@icloud.com" },
  to: [{ address: "reservations@hotelorto.it" }],
  cc: [],
  subject: "Re: Booking confirmed",
  date,
  text,
  flags: [],
});

const openBox = (decision: string, works: readonly Result<string, string>[] = []): Box => {
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
    work: (prompt) => {
      prompts.update((current) => [...current, prompt]);
      const [next = ok("Done."), ...rest] = results.get();
      results.set(rest);
      return Promise.resolve(next);
    },
    info: ignore,
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
    const box = openBox("quiet");
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
    const box = openBox("quiet");
    box.mail.breakReading();

    const caughtUp = await box.mailbox.catchUp(ignore);

    expect(caughtUp).toEqual({ ok: false, failure: "The mail server refused the sign-in." });
    expect(box.prompts()).toEqual([]);
    await box.mailbox.close();
  });

  it("matches a sent mail to its draft only by the thread it answers, and only once the draft existed", async () => {
    const box = openBox("quiet");
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
    expect(box.prompts()).toEqual([]);
    await box.mailbox.close();
  });
});
