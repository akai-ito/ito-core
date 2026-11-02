import { createCell } from "#cell.ts";
import { toTimestamp, type Clock } from "#clock.ts";
import { startOfDay, toLocal } from "#desk/day.ts";
import type { Identifiers } from "#identifiers.ts";
import type { CalendarItem, Card, Desk, DoneEntry, Moment, WorkKind } from "#protocol/types.ts";
import { fail, ok, type Result } from "#result.ts";
import type { Store } from "#store/store.ts";
import { fieldOf } from "#tools/input.ts";
import type { Info } from "#turns/turns.ts";

export type CardAnswer = { readonly option?: string; readonly slots?: readonly number[]; readonly text?: string };

// An answer to Kumo's line: an option or words, or skipping the day's question.
export type MomentAnswer = { readonly option?: string; readonly text?: string; readonly skip?: true };

// How one of Kumo's lines is answered, ahead of acting on it in the background, such as a commitment for tonight.
export type MomentHandler = {
  // Acts on the answer: what followed, in a line for Done, or why it couldn't, and the line comes back.
  readonly answer: (moment: Moment, answer: CardAnswer) => Promise<Result<string, string>>;
  readonly skip?: (moment: Moment) => void;
};

export type NewCard = Omit<Card, "id" | "at" | "state" | "answer">;

export type NewDone = Omit<DoneEntry, "id" | "at" | "undo"> & { readonly undo?: unknown };

export type CardHandler = (card: Card, answer: CardAnswer) => Promise<NewCard | undefined>;

export type Undoer = (entry: DoneEntry, payload: unknown) => Promise<Result<undefined, string>>;

export type DoneListener = (entry: DoneEntry) => void;

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
  readonly setMoment: (moment: Moment | undefined) => void;
  readonly readMoment: (id: string) => boolean;
  readonly answerMoment: (id: string, answer: MomentAnswer) => Result<Moment, string>;
  // Answers one line its own way, until the line moves on.
  readonly handleMoment: (id: string, handler: MomentHandler) => void;
  readonly setComingUp: (items: readonly CalendarItem[]) => void;
  // When Kumo last read a new mail, or undefined once no mail account is connected.
  readonly setLastMail: (at: string | undefined) => void;
  // Counts what Kumo handled today again, such as after midnight.
  readonly recount: () => void;
  // Today's Done entries, newest first.
  readonly today: () => readonly DoneEntry[];
  // One local day's Done entries, such as `2026-11-10`, newest first.
  readonly doneOn: (day: string) => readonly DoneEntry[];
  readonly addDone: (entry: NewDone) => DoneEntry;
  // Hears each new Done entry, such as one of Kumo's calls for the trust ladder to count.
  readonly onDone: (listener: DoneListener) => void;
  readonly onUndo: (undoer: Undoer) => void;
  readonly undo: (id: string) => Promise<Result<DoneEntry, string>>;
  readonly settled: () => Promise<void>;
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

const isMailUndo = (payload: unknown): boolean => {
  const kind = fieldOf(payload, "kind");
  return typeof kind === "string" && kind.startsWith("mail_");
};

// The kind of Kumo's own work an entry is, when it doesn't say: mail it moved, cleared or unsubscribed from is
// sorting. A line saying Kumo couldn't do something isn't a call.
export const workOf = (given: NewDone): WorkKind | undefined => {
  if (given.work !== undefined) return given.work;
  if (/^Couldn't\b/u.test(given.text)) return undefined;
  return given.mail !== undefined || isMailUndo(given.undo) ? "sorting" : undefined;
};

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

// Kumo's line, short enough to quote in Done: its first sentence, cut at a word if it's long.
export const quoteOf = (text: string): string => {
  const sentence = (/^.+?[.!?;](?=\s|$)/u.exec(text)?.[0] ?? text).replace(/[.;]$/u, "");
  return sentence.length <= quoteLimit ? sentence : `${sentence.slice(0, quoteLimit - 1).replace(/\s+\S*$/u, "")}…`;
};

const checkedMoment = (moment: Moment, answer: CardAnswer): Result<CardAnswer, string> => {
  if (answer.option !== undefined && moment.options.every(({ label }) => label !== answer.option)) {
    return fail(`Kumo's line has no option ${answer.option}.`);
  }
  if (answer.slots !== undefined) return fail("Kumo's line has no times to pick.");
  return answer.text === undefined || moment.allows_text ? ok(answer) : fail("Kumo's line takes one of its options.");
};

// The same, without one field, such as a moment that's gone from the Desk.
const without = <Given extends object, Field extends keyof Given>(given: Given, field: Field): Omit<Given, Field> =>
  Object.fromEntries(Object.entries(given).filter(([key]) => key !== field)) as Omit<Given, Field>;

const gone = (): Moment | undefined => undefined;

const withoutAnswer = <Given extends { readonly state?: unknown; readonly answer?: unknown }>(
  given: Given,
): Omit<Given, "state" | "answer"> =>
  Object.fromEntries(Object.entries(given).filter(([field]) => field !== "state" && field !== "answer")) as Omit<
    Given,
    "state" | "answer"
  >;

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
  const momentHandlers = createCell<ReadonlyMap<string, MomentHandler>>(new Map());
  const cardHandlers = createCell<ReadonlyMap<string, CardHandler>>(new Map());
  const undoers = createCell<readonly Undoer[]>([]);
  const doneListeners = createCell<readonly DoneListener[]>([]);
  const pending = createCell<Promise<void>>(Promise.resolve());
  const undoing = createCell<ReadonlyMap<string, Promise<Result<DoneEntry, string>>>>(new Map());

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

  const changeMoment = (id: string, change: (moment: Moment) => Moment | undefined): void => {
    changeDesk((desk) => {
      if (desk.moment?.id !== id) return desk;
      const { moment: current, ...rest } = desk;
      const changed = change(current);
      return changed ? { ...rest, moment: changed } : rest;
    });
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
    const work = workOf(given);
    const entry: DoneEntry = {
      id: identifiers.done(),
      at: at(),
      ...rest,
      undo: undo !== undefined,
      ...(work !== undefined && { work }),
    };
    store.addDone(entry, undo);
    if (!entry.quiet) recount();
    for (const listener of doneListeners.get()) listener(entry);
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

  const workOnMoment = async (moment: Moment, answer: CardAnswer): Promise<Result<string, string>> => {
    const prompt = [
      `At the top of their Desk, and in the conversation, you said: ${moment.text}`,
      `They answered: ${answer.option ?? answer.text ?? ""}`,
      "Act on it if anything follows, such as noting what they told you, moving something or scheduling a look.",
      "End with one line for their Done list saying what you did, or that nothing more was needed.",
    ].join("\n");
    const done = await work(prompt);
    return done.ok ? ok(lastLine(done.value)) : done;
  };

  const actOnMoment = async (moment: Moment, answer: CardAnswer): Promise<void> => {
    const said = answer.option ?? answer.text ?? "";
    const handler = momentHandlers.get().get(moment.id);
    const done = await (handler ? handler.answer(moment, answer) : workOnMoment(moment, answer));
    if (!done.ok) {
      info("Kumo couldn't act on an answer to its line, so the line is back", {
        moment: moment.id,
        error: done.failure,
      });
      addDone({
        text: `Couldn't act on your answer to “${quoteOf(moment.text)}”; it's back on your Desk`,
        reason: done.failure,
        quiet: false,
      });
      changeMoment(moment.id, withoutAnswer);
      return;
    }
    const followed = done.value;
    addDone({
      text: `You answered “${quoteOf(moment.text)}”: ${said}`,
      ...(followed !== "" && { reason: followed }),
      quiet: false,
    });
    changeMoment(moment.id, gone);
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
    setMoment: (moment) => {
      momentHandlers.update((current) => new Map([...current].filter(([id]) => id === moment?.id)));
      changeDesk((desk) => (moment ? { ...desk, moment } : without(desk, "moment")));
    },
    readMoment: (id) => {
      if (store.desk().moment?.id !== id) return false;
      changeMoment(id, (moment) => (moment.read_at === undefined ? { ...moment, read_at: at() } : moment));
      return true;
    },
    answerMoment: (id, given) => {
      const moment = store.desk().moment;
      if (moment?.id !== id) return fail("not_found");
      if (moment.state === "working") {
        return given.skip !== true && isSameAnswer(moment.answer, given) ? ok(moment) : fail(alreadyActing);
      }
      if (given.skip === true) {
        if (moment.kind !== "question") return fail("Only the day's question can be skipped.");
        momentHandlers.get().get(id)?.skip?.(moment);
        changeMoment(id, gone);
        return ok(moment);
      }
      const answer = checkedMoment(moment, given);
      if (!answer.ok) return answer;
      const working: Moment = { ...moment, state: "working", answer: shownAnswer(answer.value) };
      changeMoment(id, () => working);
      background(() => actOnMoment(moment, answer.value));
      return ok(working);
    },
    handleMoment: (id, handler) => {
      momentHandlers.update((current) => new Map([...current, [id, handler]]));
    },
    setComingUp: (items) => {
      changeDesk((desk) => ({ ...desk, coming_up: [...items] }));
    },
    setLastMail: (lastMail) => {
      changeDesk((desk) =>
        lastMail === undefined ? without(desk, "last_mail_at") : { ...desk, last_mail_at: lastMail },
      );
    },
    recount,
    today,
    doneOn,
    addDone,
    onDone: (listener) => {
      doneListeners.update((current) => [...current, listener]);
    },
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
  };
};
