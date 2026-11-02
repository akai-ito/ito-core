import { describe, expect, it, vi } from "vitest";
import { createCell } from "#cell.ts";
import type { CardAnswer, CardHandler, DeskKeeper, NewCard, NewDone, Undoer } from "#desk/desk.ts";
import type { JsonSchema } from "#engine/engine.ts";
import type { Mail } from "#mail/imap.ts";
import { createMailbox, type Mailbox } from "#mail/mail.ts";
import { createStakesChoice } from "#engine/quick-model.ts";
import { demoModels } from "#engine/scripted/models.ts";
import type { Card, DoneEntry, ModelChoice } from "#protocol/types.ts";
import { fail, ok } from "#result.ts";
import type { ToolResult } from "#tools/mcp.ts";
import { createFakeMail, type ArrivingMail, type FakeMail } from "./support/fake-mail.ts";
import { createVirtualClock, type VirtualClock } from "./support/virtual-clock.ts";

// The inbox holds only what needs them: the attention pass bins noise, files what's worth keeping into their
// folders, and hands the rest to Kumo.

type Judged = {
  readonly decision: string;
  readonly stakes?: string;
  readonly folder?: string;
  readonly confidence?: number;
};

type Answers = {
  readonly folders?: readonly string[];
  readonly renamed?: readonly { readonly name: string; readonly from: readonly string[] }[];
};

type Inbox = {
  readonly mailbox: Mailbox;
  readonly mail: FakeMail;
  readonly done: () => readonly DoneEntry[];
  readonly cards: () => readonly Card[];
  readonly work: () => readonly string[];
  readonly choices: () => readonly (ModelChoice | undefined)[];
  readonly asked: () => readonly string[];
  readonly answer: (title: string, answer: CardAnswer) => Promise<void>;
  // Takes a card off the Desk without an answer, as clearing it does.
  readonly clear: (title: string) => void;
  readonly clock: VirtualClock;
  readonly undo: (entry: DoneEntry) => Promise<void>;
  readonly setting: (key: string) => string | undefined;
};

const icloud = { apple_id: "sam@icloud.com", app_password: "abcd-efgh-ijkl-mnop" };

const promo: ArrivingMail = {
  account: "icloud",
  message_id: "deal-1@pizza.example",
  from: "Pizza Place <deals@mail.pizza.example>",
  to: ["sam@icloud.com"],
  subject: "Two for one tonight",
  text: "Order now.",
  unsubscribe: "https://mail.pizza.example/unsubscribe/1",
};

const receipt: ArrivingMail = {
  account: "icloud",
  message_id: "receipt-7@rides.example",
  from: "Rides <receipts@rides.example>",
  to: ["sam@icloud.com"],
  subject: "Your Tuesday ride",
  text: "£12.40, paid.",
};

const newsletter: ArrivingMail = {
  account: "icloud",
  message_id: "issue-88@weekly.example",
  from: "The Weekly <editor@weekly.example>",
  to: ["sam@icloud.com"],
  subject: "Issue 88: seed rounds",
  text: "This week in startups.",
  unsubscribe: "https://weekly.example/unsubscribe",
};

const ignore = (): void => undefined;

const nothingChosen = (): ModelChoice | undefined => undefined;

// They once wrote to the pizza shop's help desk, at the same site its promotions come from.
const toHelpDesk: Mail = {
  account: "icloud",
  folder: "Sent",
  uid: 1,
  messageId: "sent-to-help@icloud.com",
  references: [],
  from: { address: "sam@icloud.com" },
  to: [{ address: "help@pizza.example" }],
  cc: [],
  subject: "A question about my order",
  date: "2026-10-01T10:00:00.000Z",
  text: "Hello",
  flags: [],
};

const fieldsOf = (schema: JsonSchema): readonly string[] =>
  Object.keys((schema.properties as Readonly<Record<string, unknown>> | undefined) ?? {});

const openInbox = (
  judged: Judged,
  answers: Answers = {},
  saved: readonly (readonly [string, string])[] = [],
  waiting: readonly Card[] = [],
): Inbox => {
  const clock = createVirtualClock(Date.parse("2026-11-10T22:00:00.000Z"));
  const mail = createFakeMail(() => new Date(clock.now()).toISOString());
  const settings = createCell<ReadonlyMap<string, string>>(new Map(saved));
  const done = createCell<readonly (DoneEntry & { readonly payload?: unknown })[]>([]);
  const cards = createCell<readonly Card[]>(waiting);
  const handlers = createCell<ReadonlyMap<string, CardHandler>>(new Map());
  const undoers = createCell<readonly Undoer[]>([]);
  const prompts = createCell<readonly string[]>([]);
  const choices = createCell<readonly (ModelChoice | undefined)[]>([]);
  const asked = createCell<readonly string[]>([]);
  const desk = {
    addCard: (card: NewCard) => {
      const added: Card = { ...card, id: `k_${String(cards.get().length + 1)}`, at: "2026-11-10T22:00:00.000Z" };
      cards.update((current) => [...current, added]);
      return added;
    },
    cards: () => cards.get(),
    removeCard: (id: string) => {
      cards.update((current) => current.filter((card) => card.id !== id));
    },
    handle: ignore,
    handleCard: (id: string, handler: CardHandler) => {
      handlers.update((current) => new Map([...current, [id, handler]]));
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
    complete: (prompt, schema) => {
      asked.update((current) => [...current, prompt]);
      if (fieldsOf(schema).includes("decision")) {
        return Promise.resolve(ok({ stakes: "low", folder: "", reason: "A test", confidence: 0.9, ...judged }));
      }
      const isRename = prompt.includes("They replied:");
      return Promise.resolve(ok({ folders: isRename ? (answers.renamed ?? []) : (answers.folders ?? []) }));
    },
    quickChoice: () => Promise.resolve(undefined),
    work: (prompt, choice) => {
      prompts.update((current) => [...current, prompt]);
      choices.update((current) => [...current, choice]);
      return Promise.resolve(ok("Done."));
    },
    stakesChoice: (stakes) => Promise.resolve({ model: stakes === "high" ? "thorough" : "light", effort: stakes }),
    matters: () => ["Job search (pursuit)"],
    info: ignore,
    createSource: mail.create,
    sentPollMs: 60_000,
  });
  return {
    mailbox,
    mail,
    done: () => done.get(),
    cards: () => cards.get(),
    work: () => prompts.get(),
    choices: () => choices.get(),
    asked: () => asked.get(),
    answer: async (title, answer) => {
      const card = cards.get().find((candidate) => candidate.title === title);
      const handler = card && handlers.get().get(card.id);
      if (!card || !handler) throw new Error(`No card "${title}" with a handler.`);
      cards.update((current) => current.filter(({ id }) => id !== card.id));
      await handler(card, answer);
    },
    clear: (title) => {
      cards.update((current) => current.filter((card) => card.title !== title));
    },
    clock,
    undo: async (entry) => {
      const payload = done.get().find(({ id }) => id === entry.id)?.payload;
      await Promise.all(undoers.get().map((undoer) => undoer(entry, payload)));
    },
    setting: (key) => settings.get().get(key),
  };
};

const settled = async (check: () => void): Promise<void> => {
  await vi.waitFor(check, { timeout: 2000, interval: 10 });
};

const chosen: readonly (readonly [string, string])[] = [
  ["mail_folders", JSON.stringify(["Bookings & travel", "Money & receipts", "Newsletters"])],
];

describe("an inbox of only what needs you", () => {
  it("bins a promotion, and unsubscribes from a sender they've never written to", async () => {
    const box = openInbox({ decision: "promotion" });
    box.mail.arrive(promo);

    await settled(() => {
      expect(box.done().map(({ text }) => text)).toEqual([
        'Binned "Two for one tonight" from Pizza Place',
        "Unsubscribed from Pizza Place",
      ]);
    });
    expect(box.mail.moved()).toEqual([{ account: "icloud", messageId: promo.message_id, to: "bin" }]);
    expect(box.mail.unsubscribed()).toEqual([promo.message_id]);
    expect(box.done()).toMatchObject([
      { reason: "A test", undo: true },
      { reason: "Promotions from a sender you've never written to", undo: false },
    ]);
    expect(box.work()).toEqual([]);

    box.mail.arrive({ ...promo, message_id: "deal-2@pizza.example" });
    await settled(() => {
      expect(box.done()).toHaveLength(3);
    });
    expect(box.mail.unsubscribed()).toEqual([promo.message_id]);
    await box.mailbox.close();
  });

  it("asks quietly before unsubscribing from a sender they've written to, and does it when they say so", async () => {
    const box = openInbox({ decision: "promotion" });
    box.mail.send("icloud", toHelpDesk);
    box.mail.arrive(promo);

    await settled(() => {
      expect(box.cards()).toMatchObject([
        {
          kind: "question",
          title: "Unsubscribe from Pizza Place?",
          options: [{ label: "Unsubscribe" }, { label: "Stay subscribed" }],
          question: {
            text: "Their promotions go to the bin. You've written to pizza.example before, so I'm asking first.",
          },
        },
      ]);
    });
    expect(box.mail.unsubscribed()).toEqual([]);
    box.mail.arrive({ ...promo, message_id: "deal-2@pizza.example" });
    await settled(() => {
      expect(box.done()).toHaveLength(2);
    });
    expect(box.cards()).toHaveLength(1);

    await box.answer("Unsubscribe from Pizza Place?", { option: "Unsubscribe" });

    expect(box.mail.unsubscribed()).toEqual([promo.message_id]);
    expect(box.done().at(-1)).toMatchObject({ text: "Unsubscribed from Pizza Place", reason: "You asked" });
    await box.mailbox.close();
  });

  it("says so in Done when unsubscribing they asked for fails", async () => {
    const box = openInbox({ decision: "promotion" });
    box.mail.send("icloud", toHelpDesk);
    box.mail.arrive(promo);
    await settled(() => {
      expect(box.cards()).toHaveLength(1);
    });
    box.mail.refuseUnsubscribes();

    await box.answer("Unsubscribe from Pizza Place?", { option: "Unsubscribe" });

    expect(box.done().at(-1)).toMatchObject({
      text: "Couldn't unsubscribe from deals@mail.pizza.example",
      reason: "This list only unsubscribes on its web page: https://mail.pizza.example/leave",
      quiet: false,
    });
    await box.mailbox.close();
  });

  it("drafts the mail that leaves a list which only takes mail, onto the Desk for them to send, once", async () => {
    const box = openInbox({ decision: "promotion" });
    const logo: ArrivingMail = {
      ...promo,
      message_id: "logo-1@smashinglogo.example",
      from: "Smashing Logo <news@smashinglogo.example>",
      unsubscribe: undefined,
      unsubscribe_mailto: "mailto:leave@smashinglogo.example?subject=Unsubscribe",
    };
    box.mail.arrive(logo);

    await settled(() => {
      expect(box.cards()).toHaveLength(1);
    });
    box.mail.arrive({ ...logo, message_id: "logo-2@smashinglogo.example" });
    await settled(() => {
      expect(box.done()).toHaveLength(2);
    });

    expect(box.cards()).toMatchObject([
      {
        kind: "draft",
        title: "Unsubscribe from Smashing Logo",
        options: [{ label: "Drop it" }],
        allows_text: false,
        draft: {
          account: "icloud",
          from: "sam@icloud.com",
          to: ["leave@smashinglogo.example"],
          subject: "Unsubscribe",
          body: "unsubscribe",
        },
      },
    ]);
    expect(box.mail.drafts()).toEqual([
      {
        from: { address: "sam@icloud.com" },
        to: [{ address: "leave@smashinglogo.example" }],
        subject: "Unsubscribe",
        body: "unsubscribe",
      },
    ]);
    expect(box.done().map(({ text }) => text)).toEqual([
      'Binned "Two for one tonight" from Smashing Logo',
      'Binned "Two for one tonight" from Smashing Logo',
    ]);
    await box.mailbox.close();
  });

  it("says once in Done when a list can't be left, and doesn't try again on its next promotion", async () => {
    const box = openInbox({ decision: "promotion" });
    box.mail.refuseUnsubscribes();
    box.mail.arrive(promo);
    await settled(() => {
      expect(box.done()).toHaveLength(2);
    });
    box.mail.arrive({ ...promo, message_id: "deal-2@pizza.example" });

    await settled(() => {
      expect(box.done()).toHaveLength(3);
    });
    expect(box.done()).toMatchObject([
      { text: 'Binned "Two for one tonight" from Pizza Place' },
      {
        text: "Couldn't unsubscribe from Pizza Place",
        reason: "This list only unsubscribes on its web page: https://mail.pizza.example/leave",
        mail: { message_id: promo.message_id },
        quiet: false,
      },
      { text: 'Binned "Two for one tonight" from Pizza Place' },
    ]);
    expect(JSON.parse(box.setting("mail_unsubscribe_failed") ?? "[]")).toEqual(["deals@mail.pizza.example"]);
    await box.mailbox.close();
  });

  it("asks again 30 days after an unsubscribe question was cleared without an answer", async () => {
    const box = openInbox({ decision: "promotion" });
    const title = "Unsubscribe from Pizza Place?";
    box.mail.send("icloud", toHelpDesk);
    box.mail.arrive(promo);
    await settled(() => {
      expect(box.cards().map((card) => card.title)).toEqual([title]);
    });
    box.clear(title);

    box.mail.arrive({ ...promo, message_id: "deal-2@pizza.example" });
    await settled(() => {
      expect(box.done()).toHaveLength(2);
    });
    expect(box.cards()).toEqual([]);

    box.clock.moveTo(box.clock.now() + 30 * 24 * 60 * 60 * 1000);
    box.mail.arrive({ ...promo, message_id: "deal-3@pizza.example" });
    await settled(() => {
      expect(box.cards().map((card) => card.title)).toEqual([title]);
    });
    expect(JSON.parse(box.setting("mail_unsubscribe_asks") ?? "[]")).toMatchObject([
      { message_id: "deal-3@pizza.example", at: "2026-12-10T22:00:00.000Z" },
    ]);
    await box.mailbox.close();
  });

  it("stays subscribed when they say so, and doesn't ask about that sender again", async () => {
    const box = openInbox({ decision: "promotion" });
    box.mail.send("icloud", toHelpDesk);
    box.mail.arrive(promo);
    await settled(() => {
      expect(box.cards()).toHaveLength(1);
    });

    await box.answer("Unsubscribe from Pizza Place?", { option: "Stay subscribed" });
    box.mail.arrive({ ...promo, message_id: "deal-2@pizza.example" });

    await settled(() => {
      expect(box.done()).toHaveLength(2);
    });
    expect(box.cards()).toEqual([]);
    expect(box.mail.unsubscribed()).toEqual([]);
    await box.mailbox.close();
  });

  it("files a record into one of their folders, with an undo that brings it back", async () => {
    const box = openInbox({ decision: "record", folder: "money & receipts" }, {}, chosen);
    box.mail.arrive(receipt);

    await settled(() => {
      expect(box.done()).toMatchObject([
        { text: 'Filed "Your Tuesday ride" from Rides into Money & receipts', reason: "A test", undo: true },
      ]);
    });
    expect(box.mail.moved()).toEqual([{ account: "icloud", messageId: receipt.message_id, to: "Money & receipts" }]);
    expect(box.asked()[0]).toContain("Their folders: Bookings & travel, Money & receipts and Newsletters.");

    const [filed] = box.done();
    if (filed) await box.undo(filed);
    box.mail.arrive(receipt);

    expect(box.mail.moved().at(-1)).toEqual({ account: "icloud", messageId: receipt.message_id, to: "inbox" });
    await settled(() => {
      expect(box.done()).toHaveLength(1);
    });
    await box.mailbox.close();
  });

  it("files a newsletter into Newsletters and never unsubscribes from it", async () => {
    const box = openInbox({ decision: "newsletter" }, {}, chosen);
    box.mail.arrive(newsletter);

    await settled(() => {
      expect(box.done().map(({ text }) => text)).toEqual([
        'Filed "Issue 88: seed rounds" from The Weekly into Newsletters',
      ]);
    });
    expect(box.asked()[0]).toContain("such as an editorial newsletter. It goes into Newsletters.");
    expect(box.mail.unsubscribed()).toEqual([]);
    await box.mailbox.close();
  });

  it("archives a record no folder of theirs fits, rather than make a new one", async () => {
    const box = openInbox({ decision: "record", folder: "Health" }, {}, chosen);
    box.mail.arrive(receipt);

    await settled(() => {
      expect(box.done().map(({ text }) => text)).toEqual(['Archived "Your Tuesday ride" from Rides']);
    });
    expect(box.mail.moved()).toEqual([{ account: "icloud", messageId: receipt.message_id, to: "archive" }]);
    await box.mailbox.close();
  });

  it("hands Kumo a mail the attention pass isn't sure is noise, rather than bin it", async () => {
    const box = openInbox({ decision: "promotion", confidence: 0.4 });
    box.mail.arrive(promo);

    await settled(() => {
      expect(box.work()).toHaveLength(1);
    });
    expect(box.work()[0]).toContain("you judged it promotion");
    expect(box.mail.moved()).toEqual([]);
    await box.mailbox.close();
  });

  it("tells Kumo to file what's handled into their folders, and keep what still needs them", async () => {
    const box = openInbox({ decision: "work" }, {}, chosen);
    box.mail.arrive(receipt);

    await settled(() => {
      expect(box.work()).toHaveLength(1);
    });
    expect(box.work()[0]).toContain("file it with file_mail into one of their folders");
    expect(box.work()[0]).toContain("Their folders: Bookings & travel, Money & receipts and Newsletters.");
    await box.mailbox.close();
  });
});

describe("their mail folders", () => {
  it("files a mail from the conversation into a folder of theirs, and makes a new one only when asked", async () => {
    const box = openInbox({ decision: "work" }, {}, chosen);
    box.mail.arrive(receipt);
    await settled(() => {
      expect(box.work()).toHaveLength(1);
    });
    const file = box.mailbox.tools.find(({ name }) => name === "file_mail");
    const filing = { message_id: receipt.message_id, to: "folder", folder: "Health" };

    const wrong = await file?.call(filing);
    const added = await file?.call({ ...filing, new_folder: true, reason: "They asked for a Health folder" });

    expect(wrong).toEqual({
      text: "They have no folder called Health. Their folders: Bookings & travel, Money & receipts and Newsletters.",
      isError: true,
    });
    expect(added).toEqual({
      text: "Filed it into Health.",
      step: {
        title: "Filed “Your Tuesday ride” from Rides into Health",
        tally: "into Health",
        note: "They asked for a Health folder",
      },
    });
    expect(box.setting("mail_folders")).toBe(
      JSON.stringify(["Bookings & travel", "Money & receipts", "Newsletters", "Health"]),
    );
    expect(box.done().map(({ text }) => text)).toEqual([
      "Added a mail folder: Health",
      'Filed "Your Tuesday ride" from Rides into Health',
    ]);
    await box.mailbox.close();
  });

  it("proposes folders when a mail first needs one, and files what waited once they're chosen", async () => {
    const box = openInbox({ decision: "record", folder: "Receipts" }, { folders: ["Receipts", "Newsletters"] });
    box.mail.arrive(receipt);

    await settled(() => {
      expect(box.cards()).toMatchObject([
        {
          kind: "question",
          title: "Folders for your mail",
          options: [{ label: "Use these" }],
          allows_text: true,
          question: {
            text:
              "I'll keep your inbox to what needs you. Mail worth keeping that needs nothing from you goes into " +
              "Receipts and Newsletters. Use these, or reply with what you'd call them.",
          },
        },
      ]);
    });
    expect(box.mail.moved()).toEqual([]);
    expect(box.asked()[1]).toContain("Rides · Your Tuesday ride");

    await box.answer("Folders for your mail", { option: "Use these" });

    expect(box.setting("mail_folders")).toBe(JSON.stringify(["Receipts", "Newsletters"]));
    expect(box.mail.moved()).toEqual([{ account: "icloud", messageId: receipt.message_id, to: "Receipts" }]);
    expect(box.done().map(({ text }) => text)).toEqual([
      "Your mail folders: Receipts and Newsletters",
      'Filed "Your Tuesday ride" from Rides into Receipts',
    ]);
    await box.mailbox.close();
  });

  it("takes the names they reply with, and files what waited into the folder that took its place", async () => {
    const box = openInbox(
      { decision: "record", folder: "Receipts" },
      {
        folders: ["Receipts", "Newsletters"],
        renamed: [
          { name: "Money", from: ["Receipts"] },
          { name: "Reading", from: ["Newsletters"] },
        ],
      },
    );
    box.mail.arrive(receipt);
    await settled(() => {
      expect(box.cards()).toHaveLength(1);
    });

    await box.answer("Folders for your mail", { text: "Call receipts Money, and newsletters Reading" });

    expect(box.asked().at(-1)).toContain("They replied: Call receipts Money, and newsletters Reading");
    expect(box.setting("mail_folders")).toBe(JSON.stringify(["Money", "Reading"]));
    expect(box.mail.moved()).toEqual([{ account: "icloud", messageId: receipt.message_id, to: "Money" }]);
    await box.mailbox.close();
  });

  it("proposes folders at the end of the catch-up, from what it read", async () => {
    const box = openInbox({ decision: "work" }, { folders: ["Bookings & travel", "Newsletters"] });
    box.mail.hold("icloud", 3);

    expect(await box.mailbox.catchUp(ignore)).toEqual({ ok: true, value: undefined });

    expect(box.asked().find((prompt) => prompt.includes("Propose the folders"))).toContain("News · Issue 2");
    expect(box.cards().map(({ title }) => title)).toEqual(["Folders for your mail"]);
    await box.mailbox.close();
  });

  it("still takes an answer to its proposal and its unsubscribe question after a restart", async () => {
    const first = openInbox({ decision: "record", folder: "Receipts" }, { folders: ["Receipts", "Newsletters"] });
    first.mail.send("icloud", toHelpDesk);
    first.mail.arrive(receipt);
    await settled(() => {
      expect(first.cards()).toHaveLength(1);
    });
    await first.mailbox.close();
    const remembered = ["mail_folders_proposal", "mail_folders_waiting"].map(
      (key) => [key, first.setting(key) ?? ""] as const,
    );
    const ask = {
      id: "k_2",
      at: "2026-11-10T22:00:00.000Z",
      kind: "question" as const,
      title: "Unsubscribe from Pizza Place?",
      options: [{ label: "Unsubscribe" }, { label: "Stay subscribed" }],
      allows_text: false,
      question: { text: "Unsubscribe?" },
    };
    const asked = JSON.stringify([
      { card: "k_2", account: "icloud", message_id: promo.message_id, sender: "deals@mail.pizza.example" },
    ]);

    const again = openInbox(
      { decision: "record" },
      {},
      [...remembered, ["mail_unsubscribe_asks", asked]],
      [...first.cards(), ask],
    );
    // An ask kept before asks were dated counts from now.
    expect(JSON.parse(again.setting("mail_unsubscribe_asks") ?? "[]")).toMatchObject([
      { card: "k_2", at: "2026-11-10T22:00:00.000Z" },
    ]);
    again.mail.arrive(promo);
    await again.answer("Folders for your mail", { option: "Use these" });
    await again.answer("Unsubscribe from Pizza Place?", { option: "Unsubscribe" });

    expect(again.mail.moved()).toContainEqual({ account: "icloud", messageId: receipt.message_id, to: "Receipts" });
    expect(again.mail.unsubscribed()).toEqual([promo.message_id]);
    await again.mailbox.close();
  });
});

const opportunity: ArrivingMail = {
  account: "icloud",
  message_id: "intro-3@northwind.example",
  from: "Clara Voss <clara.voss@northwind.example>",
  to: ["sam@icloud.com"],
  subject: "AI Engineer at Northwind",
  text: "Hi Sam, would you be free for a call on Thursday at 14:00 or Friday at 10:00?",
};

describe("effort that follows the stakes", () => {
  it("gives mail with real stakes the thorough model, and routine mail the light one", async () => {
    const box = openInbox({ decision: "work", stakes: "high" });
    box.mail.arrive(opportunity);
    await settled(() => {
      expect(box.work()).toHaveLength(1);
    });
    const routine = openInbox({ decision: "promotion", stakes: "low", confidence: 0.5 });
    routine.mail.arrive(promo);
    await settled(() => {
      expect(routine.work()).toHaveLength(1);
    });

    expect(box.choices()).toEqual([{ model: "thorough", effort: "high" }]);
    expect(routine.choices()).toEqual([{ model: "light", effort: "low" }]);
    expect(box.asked()[0]).toContain("Stakes are high when a real person wrote it");
    expect(box.asked()[0]).toContain("What's in motion for them now: Job search (pursuit).");
    await box.mailbox.close();
    await routine.mailbox.close();
  });

  it("asks Kumo to be prompt with an opportunity: a brief of a new company, and its times on the calendar", async () => {
    const box = openInbox({ decision: "work", stakes: "high" });
    box.mail.arrive(opportunity);
    await settled(() => {
      expect(box.work()).toHaveLength(1);
    });

    const [prompt = ""] = box.work();
    expect(prompt).toContain("put a two-line brief of what it actually does in that option's note");
    expect(prompt).toContain("a time that's only proposed goes on");
    expect(prompt).toContain("Kumo's calendar as a hold");
    await box.mailbox.close();
  });

  it("chooses the person's model thinking hard for real stakes, and the quick model for routine work", async () => {
    const listed = (): ReturnType<Parameters<typeof createStakesChoice>[0]> => Promise.resolve(ok(demoModels));
    const chosenLow = createStakesChoice(listed, () => ({ model: "gpt-6.1-sol", effort: "low" }));
    const chosenMax = createStakesChoice(listed, () => ({ model: "gpt-6.1-sol", effort: "max" }));
    const unchosen = createStakesChoice(listed, nothingChosen);
    const withoutQuick = createStakesChoice(
      () => Promise.resolve(ok(demoModels.filter(({ id }) => !id.includes("luna")))),
      nothingChosen,
    );
    const unlisted = createStakesChoice(() => Promise.resolve(fail("Codex isn't running.")), nothingChosen);

    expect(await chosenLow("high")).toEqual({ model: "gpt-6.1-sol", effort: "high" });
    expect(await chosenMax("high")).toEqual({ model: "gpt-6.1-sol", effort: "max" });
    expect(await unchosen("high")).toEqual({ model: "gpt-6.1-sol", effort: "high" });
    expect(await chosenLow("low")).toEqual({ model: "gpt-6-luna", effort: "medium" });
    expect(await withoutQuick("low")).toEqual({ model: "gpt-6.1-sol", effort: "low" });
    expect(await unlisted("high")).toBeUndefined();
  });
});

// A big batch's ask as the mailbox keeps it, for the card that asked.
const batchAsk = (card: string): unknown => ({
  card,
  account: "icloud",
  groups: [{ folder: "INBOX", uids: [1, 2], ids: ["held-1@news.example", "held-2@news.example"] }],
  into: { folder: "Newsletters" },
  is_new: false,
  from: "Inbox",
  count: 30,
  reason: "",
});

const move = (inbox: Inbox, input: unknown): Promise<ToolResult> | undefined =>
  inbox.mailbox.tools.find(({ name }) => name === "mail_move")?.call(input);

describe("moving many mails at once", () => {
  const issues = ["held-1@news.example", "held-2@news.example", "held-3@news.example"];

  it("bins a page of the inbox in one move, and Undo brings it back without reading it again", async () => {
    const box = openInbox({ decision: "promotion" }, {}, chosen);
    box.mail.hold("icloud", 3);

    const moved = await move(box, { message_id: issues, into: "bin", reason: "Old news" });

    expect(moved).toMatchObject({
      text: "Moved 3 mails from Inbox to the bin.",
      step: { title: "Moved 3 mails from Inbox to the bin", note: "Old news" },
    });
    expect(moved?.step?.mails).toHaveLength(3);
    expect(issues.map((id) => box.mail.folderOf("icloud", id))).toEqual(["Trash", "Trash", "Trash"]);
    const [entry] = box.done();
    expect(box.done()).toMatchObject([{ text: "Moved 3 mails from Inbox to the bin", reason: "Old news", undo: true }]);

    if (entry) await box.undo(entry);
    expect(issues.map((id) => box.mail.folderOf("icloud", id))).toEqual(["INBOX", "INBOX", "INBOX"]);
    box.mail.arrive({ ...promo, message_id: "held-1@news.example", subject: "Issue 1" });
    box.mail.arrive(promo);
    await settled(() => {
      expect(box.done().map(({ text }) => text)).toContain('Binned "Two for one tonight" from Pizza Place');
    });
    expect(box.done().map(({ text }) => text)).not.toContain('Binned "Issue 1" from Pizza Place');
    await box.mailbox.close();
  });

  it("asks once on the Desk for a big batch, and moves nothing when they say not now", async () => {
    const box = openInbox({ decision: "promotion" }, {}, chosen);
    box.mail.hold("icloud", 30);

    const asked = await move(box, { folder: "inbox", from: "news.example", into: "newsletters" });

    expect(asked?.text).toMatch(/^That's 30 mails, so they're asked once on the Desk first, as k_1: /u);
    expect(asked?.step?.title).toBe("Asked you about moving 30 mails from Inbox into Newsletters");
    expect(box.cards()).toMatchObject([{ kind: "question", title: "Move 30 mails from Inbox into Newsletters?" }]);
    await box.answer("Move 30 mails from Inbox into Newsletters?", { option: "Not now" });
    expect(box.mail.moved()).toEqual([]);
    expect(box.done()).toEqual([]);
    expect(box.setting("mail_batch_asks")).toBe("[]");
    await box.mailbox.close();
  });

  it("says how far a move got when the server stopped it, and Undo puts back what moved", async () => {
    const box = openInbox({ decision: "promotion" }, {}, chosen);
    box.mail.hold("icloud", 3);
    box.mail.stopMovesAfter(2);

    const moved = await move(box, { message_id: issues, into: "bin", reason: "Old news" });

    expect(moved).toMatchObject({
      text:
        "Moved 2 of 3 mails from Inbox to the bin; the rest stayed where they were. " +
        "Mail couldn't finish moving mail: Connection not available.",
      step: { note: "Mail couldn't finish moving mail: Connection not available" },
    });
    expect(box.done()).toMatchObject([
      {
        text: "Moved 2 of 3 mails from Inbox to the bin; the rest stayed where they were",
        reason: "Mail couldn't finish moving mail: Connection not available",
        undo: true,
      },
    ]);
    const [entry] = box.done();
    if (entry) await box.undo(entry);
    expect(issues.map((id) => box.mail.folderOf("icloud", id))).toEqual(["INBOX", "INBOX", "INBOX"]);
    await box.mailbox.close();
  });

  it("forgets a big batch's ask once its card has gone without an answer", async () => {
    const waiting: Card = {
      id: "k_9",
      at: "2026-11-10T21:00:00.000Z",
      kind: "question",
      title: "Move 30 mails from Inbox into Newsletters?",
      options: [{ label: "Apply" }, { label: "Not now" }],
      allows_text: false,
    };
    const box = openInbox(
      { decision: "promotion" },
      {},
      [...chosen, ["mail_batch_asks", JSON.stringify([batchAsk("k_3"), batchAsk("k_9")])]],
      [waiting],
    );

    expect(JSON.parse(box.setting("mail_batch_asks") ?? "[]")).toMatchObject([{ card: "k_9" }]);
    await box.mailbox.close();
  });

  it("says where mail can go, and takes one way of picking it", async () => {
    const box = openInbox({ decision: "promotion" }, {}, chosen);
    const fresh = openInbox({ decision: "promotion" });

    expect(await move(box, { folder: "Receipts (old)", into: "Receipts" })).toEqual({
      text:
        "They have no folder called Receipts. Their folders: Bookings & travel, Money & receipts and Newsletters. " +
        "Make one with --new-folder only when they've asked for it.",
      isError: true,
    });
    expect(await move(box, { message_id: issues, folder: "inbox", into: "bin" })).toEqual({
      text: "Pick mails by --message-id, or by --folder and search words, not both.",
      isError: true,
    });
    expect(await move(box, { into: "bin" })).toEqual({
      text: "Say which mails: --message-id for each one, or --folder and any search words.",
      isError: true,
    });
    expect(await move(fresh, { folder: "inbox", into: "Money & receipts" })).toEqual({
      text: "They haven't chosen their mail folders yet, so mail can only go to archive, bin or inbox for now.",
      isError: true,
    });
    await box.mailbox.close();
    await fresh.mailbox.close();
  });
});
