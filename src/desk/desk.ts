import { createCell } from "#cell.ts";
import { toTimestamp, type Cancel, type Clock } from "#clock.ts";
import { atLocal, startOfDay, toLocal, untilMinutes } from "#desk/day.ts";
import type { Identifiers } from "#identifiers.ts";
import { toThreadId } from "#conversation/ids.ts";
import type { Ambient, CalendarItem, Card, Desk, DeskLine, DoneEntry, Thread, WakeUp } from "#protocol/types.ts";
import { fail, ok, type Result } from "#result.ts";
import type { Store } from "#store/store.ts";
import type { Info } from "#turns/turns.ts";

export type CardAnswer = { readonly option?: string; readonly slots?: readonly number[]; readonly text?: string };

export type NewCard = Omit<Card, "id" | "at" | "state" | "answer">;

export type NewDone = Omit<DoneEntry, "id" | "at" | "undo"> & { readonly undo?: unknown };

export type CardHandler = (card: Card, answer: CardAnswer) => Promise<NewCard | undefined>;

export type Undoer = (entry: DoneEntry, payload: unknown) => Promise<Result<undefined, string>>;

export type Work = (prompt: string) => Promise<Result<string, string>>;

// Kumo answering a card for them, with what they said in the chat: either the card's own handler acts on it, as
// their tap would, or nothing else would, so it's settled and Kumo acts on it itself.
export type AnsweredFor = "acting" | "settled";

export type DeskKeeper = {
  readonly addCard: (card: NewCard) => Card;
  readonly cards: () => readonly Card[];
  readonly removeCard: (id: string) => void;
  // Their answer, from the Desk or from the card in the chat: in a thread, `thread` says which, so what Kumo says
  // about it goes there.
  readonly answer: (id: string, answer: CardAnswer, thread?: string) => Result<Card, string>;
  // Kumo answers a card for them, once they've settled it in the chat.
  readonly answerFor: (id: string, answer: CardAnswer) => Result<AnsweredFor, string>;
  // Kumo changes a question, offer or times card while it waits, under the same id, marked changed.
  readonly changeCard: (id: string, card: NewCard) => Result<Card, string>;
  // Whether a card has a handler of its own, such as a question only the mailbox can act on.
  readonly isOwnCard: (card: Card) => boolean;
  // What waits on them, by id, for Kumo to keep true in the chat and in the background.
  readonly inMindText: () => string;
  readonly handle: (kind: Card["kind"], handler: CardHandler) => void;
  // Answers one card, ahead of its kind's handler, such as a question only the mailbox can act on.
  readonly handleCard: (id: string, handler: CardHandler) => void;
  // Puts a waiting card's changed version in its place, under the same id, marked changed.
  readonly replaceCard: (id: string, card: NewCard) => void;
  readonly setComingUp: (items: readonly CalendarItem[]) => void;
  // Kumo's plans: every wake-up, soonest first.
  readonly setPlans: (plans: readonly WakeUp[]) => void;
  // Kumo's line and mood at the top, or none.
  readonly setLine: (line: DeskLine | undefined) => void;
  // The weather where they roughly are, or none.
  readonly setAmbient: (ambient: Ambient | undefined) => void;
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
  readonly timeZone: () => string;
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

export const stillActing = (card: Card): string =>
  `${card.title} is being acted on, with their answer: it leaves the Desk, or comes back, when that's done.`;

// Why a card with a handler of its own can't be changed by hand, and what to do instead.
export const ownCardChange = (card: Card): string => {
  if (card.kind === "draft") return `Change a draft by drafting it again with --replaces ${card.id}.`;
  if (card.kind === "invite") return "An invite can't be changed: answer it for them, or clear it.";
  return `${card.title} is Ito's own and acts on its options: answer it for them, or clear it.`;
};

// An all-day event ends on a date. Its card goes once that day is over both where they are and in UTC, which is how
// the calendar tells an invite has passed, so it isn't offered again.
const endOf = (when: string, timeZone: string): number =>
  when.length === 10 ? Math.max(Date.parse(`${when}T00:00:00.000Z`), atLocal(when, 0, timeZone)) : Date.parse(when);

// When a card can no longer help: its `until`, or an invite's event ending. Others wait however long it takes.
const deadlineOf = (card: Card, timeZone: string): number | undefined => {
  if (card.until !== undefined) return Date.parse(card.until);
  return card.invite === undefined ? undefined : endOf(card.invite.event.end, timeZone);
};

// Looks again at least this often, since a timer can't wait for weeks.
const longestRetireWaitMs = 6 * 60 * 60 * 1000;

const longestShownText = 160;

const shortened = (text: string): string =>
  text.length <= longestShownText ? text : `${text.slice(0, longestShownText - 1).replace(/\s+\S*$/u, "")}…`;

// "Sat 21 Nov 19:00", for Kumo.
const shortWhen = (at: number, timeZone: string): string =>
  new Intl.DateTimeFormat("en-GB", {
    timeZone,
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  })
    .format(at)
    .replace(",", "");

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

const checked = (card: Card, answer: CardAnswer, allowsText = card.allows_text): Result<CardAnswer, string> => {
  if (answer.option !== undefined && card.options.every(({ label }) => label !== answer.option)) {
    return fail(`${card.title} has no option ${answer.option}.`);
  }
  if (answer.slots !== undefined) {
    const slots = card.times?.slots ?? [];
    if (slots.length === 0) return fail(`${card.title} has no times to pick.`);
    if (answer.slots.some((index) => index >= slots.length))
      return fail(`${card.title} has ${String(slots.length)} times.`);
  }
  return allowsText || answer.text === undefined ? ok(answer) : fail(`${card.title} takes one of its options.`);
};

// One card as Kumo sees it in mind: its id, kind and title, what it asks, and anything that changes what to do.
const describeCard = (card: Card, now: number, timeZone: string): string => {
  const asks = ((): string => {
    if (card.question) return shortened(card.question.text);
    if (card.offer) return shortened(card.offer.text);
    if (card.times) {
      const { purpose, slots } = card.times;
      const isPast = slots.every((slot) => Date.parse(slot.end) <= now);
      return isPast
        ? `${purpose}. Every time on it has passed: offer new ones with change_card, or clear it.`
        : `${purpose}, ${slots.map((slot) => shortWhen(Date.parse(slot.start), timeZone)).join("; ")}.`;
    }
    if (card.draft)
      return `to ${card.draft.to.join(", ")}, “${card.draft.subject}”, in their ${card.draft.account} Drafts.`;
    return card.invite ? `${card.invite.event.calendar.name} calendar.` : "";
  })();
  const options = card.options.length === 0 ? "" : ` Options: ${card.options.map(({ label }) => label).join(", ")}.`;
  const acting =
    card.state === "working" && card.answer
      ? ` They answered “${toAnswerText(card, card.answer)}”; it's being acted on.`
      : "";
  const until = card.until === undefined ? "" : ` Leaves by itself ${shortWhen(Date.parse(card.until), timeZone)}.`;
  const changed = card.changed_at === undefined ? "" : `, changed ${shortWhen(Date.parse(card.changed_at), timeZone)}`;
  return (
    `- ${card.id} ${card.kind} “${card.title}”, since ${shortWhen(Date.parse(card.at), timeZone)}${changed}: ` +
    `${asks}${options}${acting}${until}`
  );
};

const deskHeader = [
  "Waiting on them on their Desk, oldest first: the same cards they see, and they can answer or talk about any",
  "of them with you in the chat. Keep it true as soon as one is settled, by them in the chat or by what happened:",
  "answer it for them with answer_card, change it with change_card, or take it off with clear_card.",
].join(" ");

export const createDesk = ({ store, identifiers, clock, timeZone, work, info }: DeskOptions): DeskKeeper => {
  const handlers = createCell<ReadonlyMap<Card["kind"], CardHandler>>(new Map());
  const cardHandlers = createCell<ReadonlyMap<string, CardHandler>>(new Map());
  const undoers = createCell<readonly Undoer[]>([]);
  const pending = createCell<Promise<void>>(Promise.resolve());
  const undoing = createCell<ReadonlyMap<string, Promise<Result<DoneEntry, string>>>>(new Map());
  const midnight = createCell<Cancel | undefined>(undefined);
  const retireTimer = createCell<Cancel | undefined>(undefined);
  const isClosed = createCell(false);

  const at = (): string => toTimestamp(clock.now());

  const changeDesk = (change: (desk: Desk) => Desk): void => {
    store.setDesk(change(store.desk()));
  };

  const changeCards = (change: (waiting: readonly Card[]) => readonly Card[]): void => {
    changeDesk((desk) => ({ ...desk, waiting: [...change(desk.waiting)] }));
    scheduleRetire();
  };

  const findCard = (id: string): Card | undefined => store.desk().waiting.find((card) => card.id === id);

  // The soonest moment a waiting card stops mattering, looked at again then. One being acted on waits for that.
  const scheduleRetire = (): void => {
    retireTimer.get()?.();
    retireTimer.set(undefined);
    if (isClosed.get()) return;
    const zone = timeZone();
    const deadlines = store
      .desk()
      .waiting.filter((card) => card.state !== "working")
      .map((card) => deadlineOf(card, zone))
      .filter((deadline): deadline is number => deadline !== undefined && !Number.isNaN(deadline));
    if (deadlines.length === 0) return;
    const wait = Math.min(Math.max(Math.min(...deadlines) - clock.now(), 0), longestRetireWaitMs);
    retireTimer.set(clock.after(wait, retirePassed));
  };

  const today = (): readonly DoneEntry[] => {
    const since = startOfDay(clock.now(), timeZone());
    return store.doneSince(toTimestamp(since));
  };

  const doneOn = (day: string): readonly DoneEntry[] => {
    const since = dayStart(day, timeZone());
    const until = toTimestamp(startOfDay(since + pastADayMs, timeZone()));
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

  // Cards that can no longer help leave quietly, each noted in Done among what was cleared.
  const retirePassed = (): void => {
    retireTimer.set(undefined);
    const now = clock.now();
    const zone = timeZone();
    const passed = store
      .desk()
      .waiting.filter((card) => card.state !== "working" && (deadlineOf(card, zone) ?? Infinity) <= now);
    if (passed.length === 0) {
      scheduleRetire();
      return;
    }
    const gone = new Set(passed.map(({ id }) => id));
    cardHandlers.update((current) => new Map([...current].filter(([card]) => !gone.has(card))));
    changeCards((waiting) => waiting.filter((card) => !gone.has(card.id)));
    for (const card of passed) {
      addDone({
        text: `“${card.title}” left Waiting on you`,
        reason: card.invite && card.until === undefined ? "Its event is over." : "Its moment has passed.",
        ...(card.motion !== undefined && { motion: card.motion }),
        quiet: true,
      });
    }
  };

  const askKumo = async (card: Card, answer: CardAnswer, thread?: Thread): Promise<NewCard | undefined> => {
    const said = toAnswerText(card, answer);
    const prompt = [
      `You asked them on the Desk: ${quoted(card)}`,
      `They answered: ${said}`,
      ...(thread
        ? [
            `They answered it on its card in their thread ${thread.title === undefined ? "" : `“${thread.title}” `}(${thread.id}):`,
            "anything you tell them about it goes in that thread.",
          ]
        : []),
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
    const untilMidnight = untilMinutes(clock.now(), timeZone(), 0);
    midnight.set(
      clock.after(untilMidnight, () => {
        recount();
        scheduleMidnight();
      }),
    );
  };

  scheduleMidnight();

  const ownHandlerOf = (card: Card): CardHandler | undefined =>
    cardHandlers.get().get(card.id) ?? handlers.get().get(card.kind);

  const isOwnCard = (card: Card): boolean => ownHandlerOf(card) !== undefined;

  // The card shows the answer while its handler acts, then leaves, or comes back changed. Kumo, acting on it, hears
  // which thread it was answered in.
  const startWorking = (card: Card, answer: CardAnswer, thread?: Thread): Card => {
    const working: Card = { ...card, state: "working", answer: shownAnswer(answer) };
    changeCards((waiting) => waiting.map((waitingCard) => (waitingCard.id === card.id ? working : waitingCard)));
    background(async () => {
      const own = ownHandlerOf(card);
      const replacement = await (own ? own(card, answer) : askKumo(card, answer, thread));
      settle(card.id, replacement);
    });
    return working;
  };

  scheduleRetire();

  return {
    addCard,
    cards: () => store.desk().waiting,
    removeCard: (id) => {
      settle(id, undefined);
    },
    answer: (id, given, threadId) => {
      const card = findCard(id);
      if (!card) return fail("not_found");
      const thread = threadId === undefined ? undefined : store.findThread(toThreadId(threadId));
      if (threadId !== undefined && !thread) return fail(`No thread ${threadId}.`);
      if (card.state === "working") return isSameAnswer(card.answer, given) ? ok(card) : fail(alreadyActing);
      const answer = checked(card, given);
      return answer.ok ? ok(startWorking(card, answer.value, thread)) : answer;
    },
    // A card with its own handler is acted on as their tap would be. Any other is settled at once, since Kumo,
    // answering for them in the chat, acts on it itself; it can say what they said in words of their own.
    answerFor: (id, given) => {
      const card = findCard(id);
      if (!card) return fail(`No card ${id} is waiting on them.`);
      if (card.state === "working") return fail(stillActing(card));
      const isOwn = isOwnCard(card);
      const answer = checked(card, given, card.allows_text || !isOwn);
      if (!answer.ok) return answer;
      if (isOwn) {
        startWorking(card, answer.value);
        return ok("acting");
      }
      settle(id, undefined);
      addDone({
        text: `You answered “${card.title}” in the chat: ${toAnswerText(card, answer.value)}`,
        ...(card.motion !== undefined && { motion: card.motion }),
        quiet: false,
      });
      return ok("settled");
    },
    changeCard: (id, given) => {
      const card = findCard(id);
      if (!card) return fail(`No card ${id} is waiting on them.`);
      if (card.state === "working") return fail(stillActing(card));
      if (isOwnCard(card)) return fail(ownCardChange(card));
      if (given.kind !== card.kind) return fail(`${card.title} stays a ${card.kind} card: clear it and add another.`);
      replaceCard(id, given);
      const changed = findCard(id);
      return changed ? ok(changed) : fail(`No card ${id} is waiting on them.`);
    },
    isOwnCard,
    inMindText: () => {
      const { waiting } = store.desk();
      if (waiting.length === 0) return "";
      const now = clock.now();
      const zone = timeZone();
      return ["<desk>", deskHeader, ...waiting.map((card) => describeCard(card, now, zone)), "</desk>"].join("\n");
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
    setPlans: (plans) => {
      changeDesk((desk) => ({ ...desk, plans: [...plans] }));
    },
    setLine: (line) => {
      changeDesk((desk) => (line ? { ...desk, line } : without(desk, "line")));
    },
    setAmbient: (ambient) => {
      changeDesk((desk) => (ambient ? { ...desk, ambient } : without(desk, "ambient")));
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
      isClosed.set(true);
      midnight.get()?.();
      retireTimer.get()?.();
    },
  };
};
