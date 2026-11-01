import { createCell } from "#cell.ts";
import type { Identifiers } from "#identifiers.ts";
import type { Belief, CalendarItem, Onboarding } from "#protocol/types.ts";
import { fail, ok, type Result } from "#result.ts";
import type { Store } from "#store/store.ts";
import { textOf } from "#tools/input.ts";
import type { Tool, ToolResult } from "#tools/mcp.ts";
import type { Info } from "#turns/turns.ts";

export type BeliefAnswer = { readonly answer?: "true"; readonly correction?: string };

export type GettingStarted = {
  readonly tools: readonly Tool[];
  readonly state: () => Onboarding;
  readonly begin: () => void;
  readonly replay: () => Onboarding;
  readonly answer: (belief: string, given: BeliefAnswer) => Result<undefined, "not_found">;
  readonly finish: () => Onboarding;
  readonly inMindText: () => string;
  readonly close: () => void;
};

export type GettingStartedOptions = {
  readonly store: Pick<Store, "onboarding" | "setOnboarding" | "setting" | "setSetting">;
  readonly identifiers: Pick<Identifiers, "belief">;
  readonly work: (prompt: string) => Promise<Result<string, string>>;
  readonly catchUp: (
    onProgress: (read: number, total: number) => void,
    only: readonly string[],
  ) => Promise<Result<undefined, string>>;
  readonly mailAccounts: () => readonly string[];
  readonly onSources: (listener: () => void) => () => void;
  readonly onAdded: (listener: (item: CalendarItem) => void) => void;
  readonly motionIds: () => readonly string[];
  readonly info: Info;
};

export const askedSetting = "onboarding_asked";

export const readSetting = "onboarding_read";

export const replaySetting = "onboarding_replay";

const pagePattern = /^memory:[\w/-]+$/u;

const failed = (text: string): ToolResult => ({ text, isError: true });

const questionPrompt = [
  "You're meeting the person for the first time, while they set up Ito. Kumo is reading their recent mail and",
  "calendar in the background. Post your first question with post: one short, warm question about what would",
  "make the next month a good one for them. Their answers come as ordinary messages; you'll ask at most three",
  "questions in all.",
].join("\n");

const gettingStartedNote = [
  "<getting_started>",
  "You're getting to know them while they set up Ito, and reading their recent mail in the background. Ask at",
  "most three short questions in all, one at a time, about what they want from the next months; skip any they",
  "don't want to answer. Then say you'll show what you found. Remember what they tell you.",
  "</getting_started>",
].join("\n");

const replayQuestionPrompt = [
  "They're going through getting started again, to see it; nothing they have is reset. Post your first question",
  "with post: one short, warm question about what's changed lately, or what would make the next month a good one.",
  "Their answers come as ordinary messages; you'll ask at most three questions in all.",
].join("\n");

const replayNote = [
  "<getting_started>",
  "They're going through getting started again, to see it; nothing they have is reset. Ask at most three short",
  "questions in all, one at a time, about what's changed or what they want from the next months; skip any they",
  "don't want to answer. Then say you'll show what you found. Remember what they tell you.",
  "</getting_started>",
].join("\n");

const recapPrompt = [
  "They're going through getting started again, so there's no mail to read this time. Name a few things you",
  "believe about them from memory with believe, each with the page it's on, for them to confirm or correct before",
  "you rely on it: what matters now, not every fact.",
].join("\n");

const correctionPrompt = (belief: Belief, correction: string): string =>
  [
    `While getting started you checked a belief with them: "${belief.text}", from ${belief.page}.`,
    `They corrected it: ${correction}`,
    "Fix the page so it states the present, moving what was wrong under Earlier if it was once true.",
  ].join("\n");

export const createGettingStarted = ({
  store,
  identifiers,
  work,
  catchUp,
  mailAccounts,
  onSources,
  onAdded,
  motionIds,
  info,
}: GettingStartedOptions): GettingStarted => {
  const isReading = createCell(false);
  const beliefs = createCell<readonly Belief[]>([]);
  const added = createCell<readonly CalendarItem[]>([]);

  const isDone = (): boolean => store.onboarding().state === "done";

  const isReplay = (): boolean => store.setting(replaySetting) === "true";

  const accountsRead = (): readonly string[] => {
    try {
      const read = JSON.parse(store.setting(readSetting) ?? "[]") as unknown;
      return Array.isArray(read) ? read.filter((account): account is string => typeof account === "string") : [];
    } catch {
      return [];
    }
  };

  const markRead = (accounts: readonly string[]): void => {
    const read = new Set([...accountsRead(), ...accounts]);
    store.setSetting(readSetting, JSON.stringify([...read]));
  };

  const unread = (): readonly string[] => mailAccounts().filter((account) => !accountsRead().includes(account));

  onAdded((item) => {
    if (isReading.get()) added.update((current) => [...current, item]);
  });

  const recap = async (): Promise<Result<undefined, string>> => {
    const done = await work(recapPrompt);
    if (!done.ok) info("Kumo couldn't name what it believes, so getting started shows none", { error: done.failure });
    return ok(undefined);
  };

  const read = async (accounts: readonly string[]): Promise<void> => {
    const earlier = store.onboarding().proposal;
    const before = new Set(motionIds());
    beliefs.set([]);
    added.set([]);
    isReading.set(true);
    const readAll = async (): Promise<Result<undefined, string>> => {
      try {
        if (accounts.length === 0) return await recap();
        return await catchUp((mailsRead, total) => {
          if (isDone()) return;
          store.setOnboarding({ state: "reading", progress: { mails_read: mailsRead, mails_total: total } });
        }, accounts);
      } finally {
        isReading.set(false);
      }
    };
    const caughtUp = await readAll();
    if (isDone()) return;
    if (!caughtUp.ok) {
      info("The catch-up couldn't read the mail, so it will try again", { error: caughtUp.failure });
      store.setOnboarding({ state: "reading" });
      return;
    }
    markRead(accounts);
    const found = isReplay() ? motionIds() : motionIds().filter((id) => !before.has(id));
    store.setOnboarding({
      state: "ready",
      proposal: {
        beliefs: [...(earlier?.beliefs ?? []), ...beliefs.get()],
        added: [...(earlier?.added ?? []), ...added.get()],
        motions: [...new Set([...(earlier?.motions ?? []), ...found])],
      },
    });
    startReading();
  };

  const startReading = (): void => {
    if (isReading.get() || isDone()) return;
    const fresh = unread();
    const isRecap = isReplay() && store.onboarding().proposal === undefined;
    if (!isRecap && fresh.length === 0) return;
    void read(fresh).catch((error: unknown) => {
      isReading.set(false);
      info("The catch-up didn't finish", { error: String(error) });
    });
  };

  const unsubscribe = onSources(startReading);

  const changeBelief = (id: string, answer: NonNullable<Belief["answer"]>): void => {
    const current = store.onboarding();
    const proposal = current.proposal;
    if (!proposal) return;
    store.setOnboarding({
      ...current,
      proposal: {
        ...proposal,
        beliefs: proposal.beliefs.map((belief) => (belief.id === id ? { ...belief, answer } : belief)),
      },
    });
  };

  const tools: readonly Tool[] = [
    {
      name: "believe",
      title: "Check a belief with them",
      audience: "work",
      description:
        "While catching up, name something you believe about them from memory, with the page it's on, for them to " +
        "confirm or correct before you rely on it. A few that matter, not every fact.",
      inputSchema: {
        type: "object",
        properties: {
          text: { type: "string", description: "Such as “You're training for a sub-20 5K”." },
          page: { type: "string", description: "The memory page it's on, such as memory:now." },
        },
        required: ["text", "page"],
        additionalProperties: false,
      },
      call: (input) => {
        const text = textOf(input, "text").trim();
        const page = textOf(input, "page").trim();
        if (text === "" || !pagePattern.test(page)) return Promise.resolve(failed("Give the belief and its page."));
        if (!isReading.get()) return Promise.resolve(failed("Beliefs are only for the catch-up, while it reads."));
        const belief: Belief = { id: identifiers.belief(), text, page };
        beliefs.update((current) => [...current, belief]);
        return Promise.resolve({ text: `Noted ${belief.id} to check with them.` });
      },
    },
  ];

  return {
    tools,
    state: () => store.onboarding(),
    begin: () => {
      if (isDone()) return;
      if (store.setting(askedSetting) === undefined) {
        store.setSetting(askedSetting, "true");
        void work(questionPrompt);
      }
      startReading();
    },
    replay: () => {
      if (!isDone()) return store.onboarding();
      markRead(mailAccounts());
      store.setSetting(replaySetting, "true");
      const again: Onboarding = { state: "reading" };
      store.setOnboarding(again);
      void work(replayQuestionPrompt)
        .catch((error: unknown) => {
          info("Kumo couldn't ask its first question again", { error: String(error) });
        })
        .then(startReading);
      return again;
    },
    answer: (id, given) => {
      const belief = store.onboarding().proposal?.beliefs.find((candidate) => candidate.id === id);
      if (!belief) return fail("not_found");
      if (given.correction === undefined) {
        changeBelief(id, "true");
        return ok(undefined);
      }
      const correction = given.correction;
      void work(correctionPrompt(belief, correction)).then((done) => {
        if (done.ok) changeBelief(id, "corrected");
        else info("A belief couldn't be corrected", { belief: id, error: done.failure });
      });
      return ok(undefined);
    },
    finish: () => {
      const finished: Onboarding = { state: "done" };
      store.setOnboarding(finished);
      store.setSetting(replaySetting, "false");
      return finished;
    },
    inMindText: () => {
      if (isDone()) return "";
      return isReplay() ? replayNote : gettingStartedNote;
    },
    close: () => {
      unsubscribe();
    },
  };
};
