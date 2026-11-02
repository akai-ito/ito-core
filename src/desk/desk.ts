import { createCell } from "#cell.ts";
import { toTimestamp, type Cancel, type Clock } from "#clock.ts";
import { startOfDay, toLocal, untilMinutes } from "#desk/day.ts";
import type { Identifiers } from "#identifiers.ts";
import type { CalendarItem, Card, Desk, DoneEntry } from "#protocol/types.ts";
import { fail, ok, type Result } from "#result.ts";
import type { Store } from "#store/store.ts";
import type { Info } from "#turns/turns.ts";

export type CardAnswer = { readonly option?: string; readonly slots?: readonly number[]; readonly text?: string };

export type NewCard = Omit<Card, "id" | "at" | "state" | "answer">;

export type NewDone = Omit<DoneEntry, "id" | "at" | "undo"> & { readonly undo?: unknown };

export type CardHandler = (card: Card, answer: CardAnswer) => Promise<NewCard | undefined>;

export type Undoer = (entry: DoneEntry, payload: unknown) => Promise<Result<undefined, string>>;

export type Work = (prompt: string) => Promise<Result<string, string>>;

export type DeskKeeper = {
  readonly addCard: (card: NewCard) => Card;
  readonly cards: () => readonly Card[];
  readonly removeCard: (id: string) => void;
  readonly answer: (id: string, answer: CardAnswer) => Result<Card, string>;
  readonly handle: (kind: Card["kind"], handler: CardHandler) => void;
  // Answers one card, ahead of its kind's handler, such as a question only the mailbox can act on.
  readonly handleCard: (id: string, handler: CardHandler) => void;
  // Puts a waiting card's changed version in its place, under the same id, marked changed.
  readonly replaceCard: (id: string, card: NewCard) => void;
  readonly setComingUp: (items: readonly CalendarItem[]) => void;
  // When Kumo last read a new mail, or undefined once no mail account is connected.
  readonly setLastMail: (at: string | undefined) => void;
  // Today's Done entries, newest first.
  readonly today: () => readonly DoneEntry[];
  // One local day's Done entries, such as `2026-11-10`, newest first.
  readonly doneOn: (day: string) => readonly DoneEntry[];
  readonly addDone: (entry: NewDone) => DoneEntry;
  readonly onUndo: (undoer: Undoer) => void;
  readonly undo: (id: string) => Promise<Result<DoneEntry, string>>;
  readonly settled: () => Promise<void>;
  readonly close: () => void;
};

export type DeskOptions = {
  readonly store: Store;
  readonly identifiers: Identifiers;
  readonly clock: Clock;
  readonly timeZone: string;
  readonly work: Work;
  readonly info: Info;
};

const quoted = (card: Card): string =>
  [card.title, card.question?.text, card.offer?.text, card.times?.purpose].filter(Boolean).join(": ");

const doneLineLimit = 200;

export const lastLine = (text: string): string =>
  (
    text
      .split("\n")
      .map((line) => line.trim())
      .findLast((line) => line !== "") ?? ""
  ).slice(0, doneLineLimit);

const cardOnly = new Set(["id", "at", "state", "answer"]);

const halfDayMs = 12 * 60 * 60 * 1000;

// A local day's first instant. Noon in UTC falls on that day nearly everywhere; furthest east it's the next day.
const dayStart = (day: string, timeZone: string): number => {
  const noon = Date.parse(`${day}T12:00:00.000Z`);
  const shown = toLocal(noon, timeZone).day;
  return startOfDay(shown === day ? noon : noon + (shown < day ? halfDayMs : -halfDayMs), timeZone);
};

// Long enough past a day's start to be into the next day, whatever its daylight saving.
const pastADayMs = 26 * 60 * 60 * 1000;

const toWaiting = (card: Card): NewCard =>
  Object.fromEntries(Object.entries(card).filter(([field]) => !cardOnly.has(field))) as NewCard;

const toAnswerText = (card: Card, answer: CardAnswer): string => {
  if (answer.option !== undefined) return answer.option;
  if (answer.slots && card.times) {
    return answer.slots
      .map((index) => card.times?.slots[index])
      .filter((slot) => slot !== undefined)
      .map((slot) => `${slot.start} to ${slot.end}${slot.note ? ` (${slot.note})` : ""}`)
      .join("; ");
  }
  return answer.text ?? "";
};

const quoteLimit = 60;

// What Kumo did, short enough to quote in Done: its first sentence, cut at a word if it's long.
export const quoteOf = (text: string): string => {
  const sentence = (/^.+?[.!?;](?=\s|$)/u.exec(text)?.[0] ?? text).replace(/[.;]$/u, "");
  return sentence.length <= quoteLimit ? sentence : `${sentence.slice(0, quoteLimit - 1).replace(/\s+\S*$/u, "")}…`;
};

// The same, without one field, such as when Kumo last read mail once no account is connected.
const without = <Given extends object, Field extends keyof Given>(given: Given, field: Field): Omit<Given, Field> =>
  Object.fromEntries(Object.entries(given).filter(([key]) => key !== field)) as Omit<Given, Field>;

const alreadyActing = "Kumo is already acting on your answer.";

type Shown = NonNullable<Card["answer"]>;

// An answer as the Desk shows it, with only the parts given.
const shownAnswer = ({ option, slots, text }: CardAnswer): Shown => ({
  ...(option !== undefined && { option }),
  ...(slots && { slots: [...slots] }),
  ...(text !== undefined && { text }),
});

// The same answer again, such as the app retrying it, while Kumo acts on the first.
const isSameAnswer = (shown: Shown | undefined, given: CardAnswer): boolean =>
  JSON.stringify(shown) === JSON.stringify(shownAnswer(given));

const checked = (card: Card, answer: CardAnswer): Result<CardAnswer, string> => {
  if (answer.option !== undefined && card.options.every(({ label }) => label !== answer.option)) {
    return fail(`${card.title} has no option ${answer.option}.`);
  }
  if (answer.slots !== undefined) {
    const slots = card.times?.slots ?? [];
    if (slots.length === 0) return fail(`${card.title} has no times to pick.`);
    if (answer.slots.some((index) => index >= slots.length))
      return fail(`${card.title} has ${String(slots.length)} times.`);
  }
  return answer.text === undefined || card.allows_text ? ok(answer) : fail(`${card.title} takes one of its options.`);
};

export const createDesk = ({ store, identifiers, clock, timeZone, work, info }: DeskOptions): DeskKeeper => {
  const handlers = createCell<ReadonlyMap<Card["kind"], CardHandler>>(new Map());
  const cardHandlers = createCell<ReadonlyMap<string, CardHandler>>(new Map());
  const undoers = createCell<readonly Undoer[]>([]);
  const pending = createCell<Promise<void>>(Promise.resolve());
  const undoing = createCell<ReadonlyMap<string, Promise<Result<DoneEntry, string>>>>(new Map());
  const midnight = createCell<Cancel | undefined>(undefined);

  const at = (): string => toTimestamp(clock.now());

  const changeDesk = (change: (desk: Desk) => Desk): void => {
    store.setDesk(change(store.desk()));
  };

  const changeCards = (change: (waiting: readonly Card[]) => readonly Card[]): void => {
    changeDesk((desk) => ({ ...desk, waiting: [...change(desk.waiting)] }));
  };

  const today = (): readonly DoneEntry[] => {
    const since = startOfDay(clock.now(), timeZone);
    return store.doneSince(toTimestamp(since));
  };

  const doneOn = (day: string): readonly DoneEntry[] => {
    const since = dayStart(day, timeZone);
    const until = toTimestamp(startOfDay(since + pastADayMs, timeZone));
    return store.doneSince(toTimestamp(since)).filter((entry) => entry.at < until);
  };

  const recount = (): void => {
    const handled = today().filter(({ quiet }) => !quiet).length;
    changeDesk((desk) => ({ ...desk, handled }));
  };

  // A changed card keeps its id and when it began waiting, so an app can mark it changed.
  const replaceCard = (id: string, replacement: NewCard): void => {
    changeCards((waiting) =>
      waiting.map((card) => (card.id === id ? { ...replacement, id, at: card.at, changed_at: at() } : card)),
    );
  };

  const addCard = (given: NewCard): Card => {
    const card: Card = { id: identifiers.card(), at: at(), ...given };
    changeCards((waiting) => [...waiting, card]);
    return card;
  };

  const settle = (id: string, replacement: NewCard | undefined): void => {
    cardHandlers.update((current) => new Map([...current].filter(([card]) => card !== id)));
    if (replacement) replaceCard(id, replacement);
    else changeCards((waiting) => waiting.filter((card) => card.id !== id));
  };

  const background = (job: () => Promise<void>): void => {
    const running = (async (): Promise<void> => {
      try {
        await job();
      } catch (error) {
        info("A card couldn't be finished", { error: String(error) });
      }
    })();
    void pending.update(async (previous) => {
      await Promise.all([previous, running]);
    });
  };

  const addDone = (given: NewDone): DoneEntry => {
    const { undo, ...rest } = given;
    const entry: DoneEntry = { id: identifiers.done(), at: at(), ...rest, undo: undo !== undefined };
    store.addDone(entry, undo);
    if (!entry.quiet) recount();
    return entry;
  };

  const askKumo = async (card: Card, answer: CardAnswer): Promise<NewCard | undefined> => {
    const said = toAnswerText(card, answer);
    const prompt = [
      `You asked them on the Desk: ${quoted(card)}`,
      `They answered: ${said}`,
      "Act on it if anything follows, such as undoing what you did or noting their preference on How to help",
      "you. End with one line for their Done list saying what you did, or that nothing more was needed.",
    ].join("\n");
    const done = await work(prompt);
    const about = { quiet: false, ...(card.motion !== undefined && { motion: card.motion }) };
    if (!done.ok) {
      info("Kumo couldn't act on an answer, so the card is back", { card: card.id, error: done.failure });
      addDone({
        text: `Couldn't act on your answer to “${card.title}”; it's back on your Desk`,
        reason: done.failure,
        ...about,
      });
      return toWaiting(card);
    }
    const followed = lastLine(done.value);
    addDone({ text: `You answered “${card.title}”: ${said}`, ...(followed !== "" && { reason: followed }), ...about });
    return undefined;
  };

  const undoEntry = async (id: string): Promise<Result<DoneEntry, string>> => {
    const found = store.findDone(id);
    if (!found) return fail("not_found");
    if (!found.entry.undo || found.payload === undefined) return fail("That can't be undone.");
    const results = await Promise.all(undoers.get().map((undoer) => undoer(found.entry, found.payload)));
    const [failure] = results.flatMap((result) => (result.ok ? [] : result.failure));
    if (failure !== undefined) return fail(failure);
    const undone: DoneEntry = { ...found.entry, text: `Undone: ${found.entry.text}`, undo: false };
    store.replaceDone(undone);
    return ok(undone);
  };

  // A new day: what Kumo handled counts from nothing again.
  const scheduleMidnight = (): void => {
    const untilMidnight = untilMinutes(clock.now(), timeZone, 0);
    midnight.set(
      clock.after(untilMidnight, () => {
        recount();
        scheduleMidnight();
      }),
    );
  };

  scheduleMidnight();

  const handlerOf = (card: Card): CardHandler =>
    cardHandlers.get().get(card.id) ?? handlers.get().get(card.kind) ?? askKumo;

  return {
    addCard,
    cards: () => store.desk().waiting,
    removeCard: (id) => {
      changeCards((waiting) => waiting.filter((card) => card.id !== id));
    },
    answer: (id, given) => {
      const card = store.desk().waiting.find((waiting) => waiting.id === id);
      if (!card) return fail("not_found");
      if (card.state === "working") return isSameAnswer(card.answer, given) ? ok(card) : fail(alreadyActing);
      const answer = checked(card, given);
      if (!answer.ok) return answer;
      const working: Card = { ...card, state: "working", answer: shownAnswer(answer.value) };
      changeCards((waiting) => waiting.map((waitingCard) => (waitingCard.id === id ? working : waitingCard)));
      background(async () => {
        const replacement = await handlerOf(card)(card, answer.value);
        settle(id, replacement);
      });
      return ok(working);
    },
    handle: (kind, handler) => {
      handlers.update((current) => new Map([...current, [kind, handler]]));
    },
    handleCard: (id, handler) => {
      cardHandlers.update((current) => new Map([...current, [id, handler]]));
    },
    replaceCard,
    setComingUp: (items) => {
      changeDesk((desk) => ({ ...desk, coming_up: [...items] }));
    },
    setLastMail: (lastMail) => {
      changeDesk((desk) =>
        lastMail === undefined ? without(desk, "last_mail_at") : { ...desk, last_mail_at: lastMail },
      );
    },
    today,
    doneOn,
    addDone,
    onUndo: (undoer) => {
      undoers.update((current) => [...current, undoer]);
    },
    // Undoing one entry again while it's being undone, such as a double tap, waits for the first.
    undo: (id) => {
      const running = undoing.get().get(id);
      if (running) return running;
      const job = (async (): Promise<Result<DoneEntry, string>> => {
        try {
          return await undoEntry(id);
        } finally {
          undoing.update((current) => new Map([...current].filter(([entry]) => entry !== id)));
        }
      })();
      undoing.update((current) => new Map([...current, [id, job]]));
      return job;
    },
    settled: () => pending.get(),
    close: () => {
      midnight.get()?.();
    },
  };
};
