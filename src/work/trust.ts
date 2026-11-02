import { createCell } from "#cell.ts";
import { toTimestamp, type Cancel, type Clock } from "#clock.ts";
import { dayMs, minuteMs, startOfDay, toLocal, toMinutes, untilMinutes } from "#desk/day.ts";
import { lastLine, quoteOf, type CardAnswer, type DeskKeeper, type Work } from "#desk/desk.ts";
import { notBeforeOf } from "#http/settings.ts";
import type { Card, DoneEntry, Trust as TrustBody, WorkKind } from "#protocol/types.ts";
import { fail, ok, type Result } from "#result.ts";
import type { Store } from "#store/store.ts";
import { fieldOf, textOf } from "#tools/input.ts";
import type { Tool } from "#tools/mcp.ts";
import type { Info } from "#turns/turns.ts";

// The trust ladder: for each kind of Kumo's work, how much it checks with them. Learning shows its calls, with a
// card a day to glance at them; Spot checks asks about one call in five; Trusted brings only what needs them. A clean
// stretch climbs a rung, and "That was wrong" steps back one, says so, and becomes a preference Kumo keeps.

export type Step = TrustBody["step"];

type Kind = {
  readonly work: WorkKind;
  readonly title: string;
  // Where its preferences live on their How to help you page.
  readonly section: string;
  // For "Two weeks without a correction on sorting".
  readonly about: string;
  // For "I'm back to showing you the mail I sort".
  readonly everything: string;
  readonly learning: string;
  // What Trusted means for it: said when it climbs there, and shown afterwards.
  readonly trusted: { readonly now: string; readonly since: string };
  // For "Yesterday I sorted 44 mails".
  readonly tally: (count: number) => string;
};

const plural = (count: number, noun: string): string => `${String(count)} ${noun}${count === 1 ? "" : "s"}`;

// The kinds of work on the ladder, in the order Kumo's work shows them. Another kind is one more entry here, and in
// `WorkKind` in the protocol.
const sorting: Kind = {
  work: "sorting",
  title: "Sorting mail",
  section: "Sorting mail",
  about: "sorting",
  everything: "the mail I sort",
  learning: "I show you the mail I sort while I learn what matters to you.",
  trusted: {
    now: "I'll stop showing you the cleared ones.",
    since: "I've stopped showing you the cleared ones.",
  },
  tally: (count) => `sorted ${plural(count, "mail")}`,
};

export const kinds: readonly Kind[] = [
  sorting,
  {
    work: "calendar",
    title: "Calendar",
    section: "Your calendar",
    about: "your calendar",
    everything: "every calendar change",
    learning: "I show you every calendar change while I learn your days.",
    trusted: {
      now: "I'll only bring you the changes that need you.",
      since: "I only bring you the changes that need you.",
    },
    tally: (count) => `made ${plural(count, "calendar change")}`,
  },
  {
    work: "drafts",
    title: "Drafts",
    section: "Writing as you",
    about: "drafts",
    everything: "every draft",
    learning: "Every draft waits for you while I learn how you write.",
    trusted: {
      now: "I'll stop asking about them, though every draft still waits for you to send.",
      since: "I've stopped asking about them; every draft still waits for you to send.",
    },
    tally: (count) => `wrote ${plural(count, "draft")}`,
  },
  {
    work: "contacts",
    title: "Contacts",
    section: "Contacts",
    about: "contacts",
    everything: "every contact change",
    learning: "I show you every contact change while I learn who's who.",
    trusted: {
      now: "I'll only bring you the changes that need you.",
      since: "I only bring you the changes that need you.",
    },
    tally: (count) => `changed ${plural(count, "contact")}`,
  },
];

const steps: readonly Step[] = ["learning", "spot_checks", "trusted"];

export type Change =
  | { readonly kind: "start" }
  | { readonly kind: "climb"; readonly days: number }
  | { readonly kind: "corrected"; readonly quote: string; readonly at: string; readonly stepped: boolean }
  | { readonly kind: "reset" };

export type Rung = { readonly step: Step; readonly since: string; readonly change: Change };

type Ladder = Partial<Readonly<Record<WorkKind, Rung>>>;

// A "Was this right?" card on one call, and the call.
type Check = { readonly card: string; readonly entry: string; readonly work: WorkKind };

export const ladderSetting = "trust_ladder";
// How many calls, and how many days, a clean stretch needs before Kumo climbs a rung.
export const climbCallsSetting = "trust_climb_calls";
export const climbDaysSetting = "trust_climb_days";
export const reviewDaySetting = "trust_review_day";
export const checksSetting = "trust_checks";
export const checkedSetting = "trust_checked";

export const defaultClimbCalls = 20;
export const defaultClimbDays = 14;
// About one call in five gets a spot check, at most one a day for each kind.
export const spotChance = 0.2;
const hourMs = 60 * minuteMs;
const glance = "Glance";
const right = "Right";
const wrong = "That was wrong";

export type Trust = {
  // Each kind of work Kumo has done, on its rung, for Kumo's work.
  readonly ladder: () => readonly TrustBody[];
  // "That was wrong": undo where possible, keep a preference, step the kind back. Saying it again adds words.
  readonly correct: (id: string, text?: string) => Promise<Result<DoneEntry, "not_found">>;
  // "Show me everything again": back to Learning.
  readonly reset: (work: WorkKind) => Result<TrustBody, "not_found">;
  readonly tools: readonly Tool[];
  readonly inMindText: () => string;
  // Puts a kind on a rung, for the demo and tests.
  readonly hold: (work: WorkKind, rung: Rung) => void;
  // Puts a day's calls of each kind still learning in one card to glance at, for the demo and the morning.
  readonly review: (day: string, said: string) => void;
  readonly settled: () => Promise<void>;
  readonly close: () => void;
};

export type TrustOptions = {
  readonly store: Pick<Store, "setting" | "setSetting" | "findDone" | "replaceDone" | "doneSince">;
  readonly desk: DeskKeeper;
  readonly clock: Clock;
  readonly timeZone: string;
  // Into Kumo's next line, the way the work thread's `post` goes.
  readonly tell: (text: string, isUrgent: boolean) => string;
  readonly work: Work;
  readonly isGettingStarted: () => boolean;
  readonly random?: () => number;
  readonly info: Info;
};

const kindOf = (work: WorkKind): Kind => kinds.find((kind) => kind.work === work) ?? sorting;

const isWork = (value: unknown): value is WorkKind => kinds.some(({ work }) => work === value);

const isStep = (value: unknown): value is Step => steps.includes(value as Step);

const parsed = (text = "null"): unknown => {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
};

const toChange = (value: unknown): Change => {
  switch (fieldOf(value, "kind")) {
    case "climb": {
      const days = fieldOf(value, "days");
      return { kind: "climb", days: typeof days === "number" ? days : 14 };
    }
    case "corrected": {
      return {
        kind: "corrected",
        quote: textOf(value, "quote"),
        at: textOf(value, "at"),
        stepped: fieldOf(value, "stepped") === true,
      };
    }
    case "reset": {
      return { kind: "reset" };
    }
    default: {
      return { kind: "start" };
    }
  }
};

const toLadder = (value: unknown): Ladder =>
  Object.fromEntries(
    kinds.flatMap(({ work }) => {
      const rung = fieldOf(value, work);
      const step = fieldOf(rung, "step");
      const since = textOf(rung, "since");
      return since !== "" && isStep(step)
        ? [[work, { step, since, change: toChange(fieldOf(rung, "change")) }] as const]
        : [];
    }),
  );

const toChecks = (value: unknown): readonly Check[] =>
  (Array.isArray(value) ? (value as readonly unknown[]) : []).flatMap((item) => {
    const work = fieldOf(item, "work");
    const [card, entry] = [textOf(item, "card"), textOf(item, "entry")];
    return card && entry && isWork(work) ? { card, entry, work } : [];
  });

const withoutStop = (text: string): string => text.trim().replace(/[.!?]+$/u, "");

const listed = (parts: readonly string[]): string =>
  parts.length <= 1 ? (parts[0] ?? "") : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1) ?? ""}`;

// "Two weeks", for how long a clean stretch lasted.
export const stretchWords = (days: number): string => {
  const weeks = Math.round(days / 7);
  if (days < 7) return plural(days, "day");
  if (weeks >= 4) return days < 45 ? "A month" : `${String(Math.round(days / 30))} months`;
  return ["", "A week", "Two weeks", "Three weeks"][weeks] ?? plural(days, "day");
};

const levelOf = (line: string): number | undefined => /^(?<hashes>#{1,6})\s/u.exec(line)?.groups?.hashes?.length;

// The section of a page's Markdown under a heading, such as "Sorting mail" on How to help you, without the heading.
export const sectionOf = (markdown: string, heading: string): string => {
  const lines = markdown.split("\n");
  const wanted = heading.trim().toLowerCase();
  const start = lines.findIndex(
    (line) =>
      levelOf(line) !== undefined &&
      line
        .replace(/^#+\s*/u, "")
        .trim()
        .toLowerCase() === wanted,
  );
  if (start === -1) return "";
  const level = levelOf(lines[start] ?? "") ?? 1;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => (levelOf(line) ?? Infinity) <= level);
  return (end === -1 ? rest : rest.slice(0, end)).join("\n").trim();
};

const correctionPrompt = (
  entry: DoneEntry,
  section: string | undefined,
  words: string | undefined,
  undone: Result<boolean, string>,
): string => {
  const notUndone =
    "Put it right with your tools if anything can be, such as moving a calendar event back or taking off one you " +
    "added; otherwise leave it.";
  const undoLine = undone.ok
    ? undone.value
      ? "It's been undone."
      : notUndone
    : `Undoing it failed (${undone.failure}): put it right with your tools if you can.`;
  return [
    `They told you this was wrong, from your Done list: “${entry.text}”${entry.reason ? ` (${entry.reason})` : ""}, ` +
      `at ${entry.at}.`,
    undoLine,
    words === undefined
      ? "They didn't say why: work out what was most likely wrong from the call itself."
      : `They said: ${words}`,
    `Keep what to do differently as a preference: a line or two ${
      section === undefined ? "on" : `under "${section}" on`
    } their How to help you page (memory:helping-you), general enough to apply next time, such as a sender, a kind of`,
    "mail or a kind of event rather than this one. If it disagrees with something already there, change that rather",
    "than adding beside it.",
    "End with one line for their Done list saying what you'll do differently.",
  ].join("\n");
};

export const createTrust = ({
  store,
  desk,
  clock,
  timeZone,
  tell,
  work,
  isGettingStarted,
  random = Math.random,
  info,
}: TrustOptions): Trust => {
  const timer = createCell<Cancel | undefined>(undefined);
  const pending = createCell<Promise<void>>(Promise.resolve());
  const isClosed = createCell(false);

  const now = (): string => toTimestamp(clock.now());

  const today = (): string => toLocal(clock.now(), timeZone).day;

  const ladder = (): Ladder => toLadder(parsed(store.setting(ladderSetting)));

  const setRung = (work: WorkKind, rung: Rung): void => {
    store.setSetting(ladderSetting, JSON.stringify({ ...ladder(), [work]: rung }));
  };

  const number = (key: string, fallback: number): number => {
    const value = Number(store.setting(key));
    return Number.isFinite(value) && value > 0 ? value : fallback;
  };

  const checks = (): readonly Check[] => toChecks(parsed(store.setting(checksSetting)));

  const setChecks = (next: readonly Check[]): void => {
    store.setSetting(checksSetting, JSON.stringify(next));
  };

  const checkedDays = (): Readonly<Record<string, string>> => {
    const value = parsed(store.setting(checkedSetting));
    return value && typeof value === "object" ? (value as Readonly<Record<string, string>>) : {};
  };

  // "on Tuesday", for a correction in Kumo's line about its rung.
  const whenWords = (at: string): string => {
    const then = Date.parse(at);
    if (Number.isNaN(then)) return "";
    const days = Math.round((startOfDay(clock.now(), timeZone) - startOfDay(then, timeZone)) / dayMs);
    if (days <= 0) return " today";
    if (days === 1) return " yesterday";
    const format = new Intl.DateTimeFormat(
      "en-GB",
      days < 7 ? { timeZone, weekday: "long" } : { timeZone, day: "numeric", month: "short" },
    );
    return ` on ${format.format(then)}`;
  };

  const lineOf = (kind: Kind, { step, change }: Rung): string => {
    switch (change.kind) {
      case "start": {
        return kind.learning;
      }
      case "climb": {
        const next = step === "trusted" ? kind.trusted.since : "I only check about one in five with you now.";
        return `${stretchWords(change.days)} without a correction on ${kind.about}. ${next}`;
      }
      case "corrected": {
        const said = `You said “${change.quote}” was wrong${whenWords(change.at)}`;
        if (!change.stepped) return `${said}. I'm still showing you ${kind.everything} while I learn.`;
        return step === "learning"
          ? `${said}, so I'm back to showing you ${kind.everything}.`
          : `${said}, so I'm back to checking about one in five with you.`;
      }
      case "reset": {
        return `You asked to see everything again, so I'm showing you ${kind.everything}.`;
      }
    }
  };

  const bodyOf = (kind: Kind, rung: Rung): TrustBody => ({
    work: kind.work,
    title: kind.title,
    step: rung.step,
    line: lineOf(kind, rung),
    since: rung.since,
  });

  const background = (job: () => Promise<void>): void => {
    const running = (async (): Promise<void> => {
      try {
        await job();
      } catch (error) {
        info("The trust ladder couldn't finish something", { error: String(error) });
      }
    })();
    void pending.update(async (previous) => {
      await Promise.all([previous, running]);
    });
  };

  // Calls of one kind since its stretch began.
  const callsSince = (work: WorkKind, since: string): number =>
    store.doneSince(since).filter((entry) => entry.work === work).length;

  const climb = (kind: Kind, rung: Rung): void => {
    const next = steps[steps.indexOf(rung.step) + 1];
    if (next === undefined) return;
    const elapsed = clock.now() - Date.parse(rung.since);
    const isClean =
      elapsed >= number(climbDaysSetting, defaultClimbDays) * dayMs &&
      callsSince(kind.work, rung.since) >= number(climbCallsSetting, defaultClimbCalls);
    if (!isClean) return;
    const days = Math.round(elapsed / dayMs);
    setRung(kind.work, { step: next, since: now(), change: { kind: "climb", days } });
    const then = next === "trusted" ? kind.trusted.now : "From now on I'll only check about one in five with you.";
    tell(`${stretchWords(days)} without a correction on ${kind.about}. ${then}`, false);
  };

  const climbAll = (): void => {
    const current = ladder();
    for (const kind of kinds) {
      const rung = current[kind.work];
      if (rung) climb(kind, rung);
    }
  };

  const answerCheck = async (card: Card, answer: CardAnswer): Promise<undefined> => {
    const check = checks().find((candidate) => candidate.card === card.id);
    setChecks(checks().filter((candidate) => candidate.card !== card.id));
    if (!check || answer.option === right) return undefined;
    await correct(check.entry, answer.text);
    // The card leaves once Kumo has taken the correction in.
    await pending.get();
    return undefined;
  };

  const answerReview = (): Promise<undefined> => Promise.resolve(undefined);

  // About one call in five, at most once a day for each kind, and one waiting at a time.
  const spotCheck = (entry: DoneEntry, work: WorkKind): void => {
    const day = today();
    const isWaiting = checks().some((check) => check.work === work);
    if (isWaiting || checkedDays()[work] === day || random() >= spotChance) return;
    const card = desk.addCard({
      kind: "question",
      title: "Was this right?",
      options: [{ label: right, acts: true }, { label: wrong }],
      allows_text: true,
      quiet: true,
      question: {
        text: `${[entry.text, entry.reason ?? ""].map(withoutStop).filter(Boolean).join(". ")}. Was this right?`,
      },
    });
    setChecks([...checks(), { card: card.id, entry: entry.id, work }]);
    store.setSetting(checkedSetting, JSON.stringify({ ...checkedDays(), [work]: day }));
    desk.handleCard(card.id, answerCheck);
  };

  const decided = (entry: DoneEntry): void => {
    const { work } = entry;
    if (work === undefined || isClosed.get()) return;
    const rung = ladder()[work];
    if (!rung) {
      setRung(work, { step: "learning", since: entry.at, change: { kind: "start" } });
      return;
    }
    if (rung.step === "spot_checks" && !isGettingStarted()) spotCheck(entry, work);
    climb(kindOf(work), rung);
  };

  // A day's calls of each kind still learning, in one quiet card to glance at, in place of any before it.
  const review = (day: string, said: string): void => {
    const current = ladder();
    const learning = kinds.filter(({ work }) => current[work]?.step === "learning");
    const calls = desk.doneOn(day);
    const counted = learning
      .map((kind) => ({ kind, count: calls.filter((entry) => entry.work === kind.work).length }))
      .filter(({ count }) => count > 0);
    if (counted.length === 0) return;
    for (const card of desk.cards()) if (card.review) desk.removeCard(card.id);
    const card = desk.addCard({
      kind: "question",
      title: `${said}'s calls to glance at`,
      options: [{ label: glance, acts: true }, { label: "Looks fine" }],
      allows_text: false,
      quiet: true,
      question: { text: `${said} I ${listed(counted.map(({ kind, count }) => kind.tally(count)))}. Glance?` },
      review: { day, work: counted.map(({ kind }) => kind.work) },
    });
    desk.handleCard(card.id, answerReview);
  };

  const isReviewDue = (): boolean =>
    !isGettingStarted() &&
    store.setting(reviewDaySetting) !== today() &&
    toLocal(clock.now(), timeZone).minutes >= toMinutes(notBeforeOf(store));

  // Looks in at least hourly, and at the morning time: a clean stretch can end with no new call, and the review
  // card comes once a day.
  const schedule = (): void => {
    timer.get()?.();
    if (isClosed.get()) return;
    const morning = toMinutes(notBeforeOf(store));
    const delay = Math.min(hourMs, untilMinutes(clock.now(), timeZone, morning));
    timer.set(
      clock.after(delay, () => {
        look();
        schedule();
      }),
    );
  };

  const look = (): void => {
    if (isClosed.get()) return;
    try {
      climbAll();
      if (isReviewDue()) {
        store.setSetting(reviewDaySetting, today());
        const lastHour = startOfDay(clock.now(), timeZone) - hourMs;
        review(toLocal(lastHour, timeZone).day, "Yesterday");
      }
    } catch (error) {
      info("The trust ladder couldn't look in", { error: String(error) });
    }
  };

  const stepDown = (work: WorkKind, entry: DoneEntry): void => {
    const kind = kindOf(work);
    const rung = ladder()[work] ?? { step: "learning", since: entry.at, change: { kind: "start" } };
    const next = steps[Math.max(0, steps.indexOf(rung.step) - 1)] ?? "learning";
    const stepped = next !== rung.step;
    const quote = quoteOf(entry.text);
    setRung(work, { step: next, since: now(), change: { kind: "corrected", quote, at: now(), stepped } });
    if (!stepped) return;
    tell(
      next === "learning"
        ? `You said “${quote}” was wrong, so I'm back to showing you ${kind.everything}.`
        : `You said “${quote}” was wrong, so I'm back to checking about one in five with you.`,
      false,
    );
  };

  const note = async (entry: DoneEntry, words: string | undefined, undone: Result<boolean, string>): Promise<void> => {
    const section = entry.work === undefined ? undefined : kindOf(entry.work).section;
    const done = await work(correctionPrompt(entry, section, words, undone));
    const said = `You said “${quoteOf(entry.text)}” was wrong${words === undefined ? "" : `: ${words}`}`;
    if (!done.ok) {
      desk.addDone({
        text: `Couldn't take in what you said about “${quoteOf(entry.text)}”`,
        reason: done.failure,
        quiet: false,
      });
      return;
    }
    const followed = lastLine(done.value);
    desk.addDone({ text: said, ...(followed !== "" && { reason: followed }), quiet: false });
  };

  const correct = async (id: string, text?: string): Promise<Result<DoneEntry, "not_found">> => {
    const found = store.findDone(id);
    if (!found) return fail("not_found");
    const { entry } = found;
    const words = text?.trim() === "" ? undefined : text?.trim();
    if (entry.corrected_at !== undefined) {
      if (words !== undefined) background(() => note(entry, words, ok(false)));
      return ok(entry);
    }
    // Marked before undoing, so the same correction said again meanwhile only adds words.
    const corrected: DoneEntry = { ...entry, corrected_at: now() };
    store.replaceDone(corrected);
    if (entry.work !== undefined) stepDown(entry.work, entry);
    // A spot check still waiting on the same call has its answer.
    const answered = checks().filter((check) => check.entry === id);
    setChecks(checks().filter((check) => check.entry !== id));
    for (const check of answered) desk.removeCard(check.card);
    const undoing = entry.undo ? await desk.undo(id) : ok(undefined);
    const undone: Result<boolean, string> = undoing.ok ? ok(entry.undo) : fail(undoing.failure);
    background(() => note(entry, words, undone));
    return ok(store.findDone(id)?.entry ?? corrected);
  };

  const reset = (work: WorkKind): Result<TrustBody, "not_found"> => {
    if (ladder()[work] === undefined) return fail("not_found");
    const rung: Rung = { step: "learning", since: now(), change: { kind: "reset" } };
    setRung(work, rung);
    return ok(bodyOf(kindOf(work), rung));
  };

  const body = (): readonly TrustBody[] => {
    const current = ladder();
    return kinds.flatMap((kind) => {
      const rung = current[kind.work];
      return rung ? bodyOf(kind, rung) : [];
    });
  };

  const tools: readonly Tool[] = [
    {
      name: "show_everything_again",
      title: "Show them everything again",
      description:
        "When they ask to see everything you do again, such as “show me everything again” or “check calendar " +
        "changes with me again”, put that kind of work back to Learning: you show them each call, with a card a day " +
        "to glance at them, until a fresh clean stretch. Leave work out for every kind.",
      inputSchema: {
        type: "object",
        properties: { work: { enum: kinds.map(({ work }) => work) } },
        additionalProperties: false,
      },
      call: (input) => {
        const given = fieldOf(input, "work");
        const chosen = isWork(given) ? [given] : body().map(({ work }) => work);
        const done = chosen.flatMap((work) => {
          const result = reset(work);
          return result.ok ? result.value.title : [];
        });
        return Promise.resolve({
          text:
            done.length === 0
              ? "You haven't done any of that work yet, so there's nothing to show again."
              : `Back to Learning: ${listed(done)}. They'll see each call again.`,
        });
      },
    },
  ];

  const inMindText = (): string => {
    const rungs = body();
    if (rungs.length === 0) return "";
    return [
      "<trust>",
      "How much you check with them, for each kind of your work: Learning shows them each call, Spot checks asks about",
      "one in five, Trusted brings only what needs them. Their corrections live on How to help you.",
      ...rungs.map(({ title, step }) => `- ${title}: ${step.replace("_", " ")}`),
      "</trust>",
    ].join("\n");
  };

  desk.onDone(decided);
  for (const card of desk.cards()) {
    if (card.review) desk.handleCard(card.id, answerReview);
    if (checks().some((check) => check.card === card.id)) desk.handleCard(card.id, answerCheck);
  }
  setChecks(checks().filter((check) => desk.cards().some((card) => card.id === check.card)));
  look();
  schedule();

  return {
    ladder: body,
    correct,
    reset,
    tools,
    inMindText,
    hold: setRung,
    review,
    settled: () => pending.get(),
    close: () => {
      isClosed.set(true);
      timer.get()?.();
    },
  };
};
