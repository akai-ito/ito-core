import { createCell } from "#cell.ts";
import { toTimestamp, type Clock } from "#clock.ts";
import type { Identifiers } from "#identifiers.ts";
import type { Briefing, CalendarItem, Card, DoneEntry } from "#protocol/types.ts";
import { fail, ok, type Result } from "#result.ts";
import type { Store } from "#store/store.ts";
import type { Info } from "#turns/turns.ts";

export type CardAnswer = { readonly option?: string; readonly slots?: readonly number[]; readonly text?: string };

export type NewCard = Omit<Card, "id" | "at" | "state">;

export type NewDone = Omit<DoneEntry, "id" | "at" | "undo"> & { readonly undo?: unknown };

export type CardHandler = (card: Card, answer: CardAnswer) => Promise<NewCard | undefined>;

export type Undoer = (entry: DoneEntry, payload: unknown) => Promise<Result<undefined, string>>;

export type Work = (prompt: string) => Promise<Result<string, string>>;

export type DeskKeeper = {
  readonly addCard: (card: NewCard) => Card;
  readonly cards: () => readonly Card[];
  readonly answer: (id: string, answer: CardAnswer) => Result<Card, string>;
  readonly handle: (kind: Card["kind"], handler: CardHandler) => void;
  readonly setBriefing: (briefing: Briefing | undefined) => void;
  readonly setComingUp: (items: readonly CalendarItem[]) => void;
  readonly readBriefing: (id: string) => boolean;
  readonly addDone: (entry: NewDone) => DoneEntry;
  readonly onUndo: (undoer: Undoer) => void;
  readonly undo: (id: string) => Promise<Result<DoneEntry, string>>;
  readonly settled: () => Promise<void>;
};

export type DeskOptions = {
  readonly store: Store;
  readonly identifiers: Identifiers;
  readonly clock: Clock;
  readonly work: Work;
  readonly info: Info;
};

const quoted = (card: Card): string =>
  [card.title, card.question?.text, card.offer?.text, card.times?.purpose].filter(Boolean).join(": ");

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

export const createDesk = ({ store, identifiers, clock, work, info }: DeskOptions): DeskKeeper => {
  const handlers = createCell<ReadonlyMap<Card["kind"], CardHandler>>(new Map());
  const undoers = createCell<readonly Undoer[]>([]);
  const pending = createCell<Promise<void>>(Promise.resolve());

  const at = (): string => toTimestamp(clock.now());

  const changeCards = (change: (waiting: readonly Card[]) => readonly Card[]): void => {
    const desk = store.desk();
    store.setDesk({ ...desk, waiting: [...change(desk.waiting)] });
  };

  const addCard = (given: NewCard): Card => {
    const card: Card = { id: identifiers.card(), at: at(), ...given };
    changeCards((waiting) => [...waiting, card]);
    return card;
  };

  const settle = (id: string, replacement: NewCard | undefined): void => {
    changeCards((waiting) => waiting.filter((card) => card.id !== id));
    if (replacement) addCard(replacement);
  };

  const background = (job: () => Promise<void>): void => {
    void pending.update(async (previous) => {
      await previous;
      try {
        await job();
      } catch (error) {
        info("A card couldn't be finished", { error: String(error) });
      }
    });
  };

  const askKumo = async (card: Card, answer: CardAnswer): Promise<NewCard | undefined> => {
    const prompt = [
      `You asked them on the Desk: ${quoted(card)}`,
      `They answered: ${toAnswerText(card, answer)}`,
      "Act on it if anything follows, such as undoing what you did or noting their preference on How to help",
      "you; otherwise do nothing.",
    ].join("\n");
    const done = await work(prompt);
    if (!done.ok) info("Kumo couldn't act on an answer", { card: card.id, error: done.failure });
    return undefined;
  };

  const handlerOf = (card: Card): CardHandler => handlers.get().get(card.kind) ?? askKumo;

  return {
    addCard,
    cards: () => store.desk().waiting,
    answer: (id, given) => {
      const card = store.desk().waiting.find((waiting) => waiting.id === id);
      if (!card) return fail("not_found");
      const answer = checked(card, given);
      if (!answer.ok) return answer;
      const working: Card = { ...card, state: "working" };
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
    setBriefing: (briefing) => {
      const { coming_up: comingUp, waiting } = store.desk();
      store.setDesk({ coming_up: comingUp, waiting, ...(briefing && { briefing }) });
    },
    setComingUp: (items) => {
      store.setDesk({ ...store.desk(), coming_up: [...items] });
    },
    readBriefing: (id) => {
      const desk = store.desk();
      if (desk.briefing?.id !== id) return false;
      if (desk.briefing.read_at === undefined)
        store.setDesk({ ...desk, briefing: { ...desk.briefing, read_at: at() } });
      return true;
    },
    addDone: (given) => {
      const { undo, ...rest } = given;
      const entry: DoneEntry = { id: identifiers.done(), at: at(), ...rest, undo: undo !== undefined };
      store.addDone(entry, undo);
      return entry;
    },
    onUndo: (undoer) => {
      undoers.update((current) => [...current, undoer]);
    },
    undo: async (id) => {
      const found = store.findDone(id);
      if (!found) return fail("not_found");
      if (!found.entry.undo || found.payload === undefined) return fail("That can't be undone.");
      const results = await Promise.all(undoers.get().map((undoer) => undoer(found.entry, found.payload)));
      const [failure] = results.flatMap((result) => (result.ok ? [] : result.failure));
      if (failure !== undefined) return fail(failure);
      const undone: DoneEntry = { ...found.entry, text: `Undone: ${found.entry.text}`, undo: false };
      store.replaceDone(undone);
      return ok(undone);
    },
    settled: () => pending.get(),
  };
};
