import { createCell } from "#cell.ts";
import { toTimestamp, type Clock } from "#clock.ts";
import { lastLine, quoteOf, type DeskKeeper, type Work } from "#desk/desk.ts";
import type { DoneEntry } from "#protocol/types.ts";
import { fail, ok, type Result } from "#result.ts";
import type { Store } from "#store/store.ts";
import type { Info } from "#turns/turns.ts";

// "That was wrong", on anything Kumo did: it's undone where it can be, and Kumo keeps what to do differently as a
// preference on How to help you, in the background.
export type Corrections = {
  // Saying it again only adds words.
  readonly correct: (id: string, text?: string) => Promise<Result<DoneEntry, "not_found">>;
  readonly settled: () => Promise<void>;
};

export type CorrectionsOptions = {
  readonly store: Pick<Store, "findDone" | "replaceDone">;
  readonly desk: Pick<DeskKeeper, "undo" | "addDone">;
  readonly clock: Clock;
  readonly work: Work;
  readonly info: Info;
};

const correctionPrompt = (entry: DoneEntry, words: string | undefined, undone: Result<boolean, string>): string => {
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
    "Keep what to do differently as a preference: a line or two on their How to help you page (memory:helping-you),",
    "under the heading it belongs to, such as Sorting mail or Your calendar, general enough to apply next time, such",
    "as a sender, a kind of mail or a kind of event rather than this one. If it disagrees with something already",
    "there, change that rather than adding beside it.",
    "End with one line for their Done list saying what you'll do differently.",
  ].join("\n");
};

export const createCorrections = ({ store, desk, clock, work, info }: CorrectionsOptions): Corrections => {
  const pending = createCell<Promise<void>>(Promise.resolve());

  const background = (job: () => Promise<void>): void => {
    const running = (async (): Promise<void> => {
      try {
        await job();
      } catch (error) {
        info("A correction couldn't be taken in", { error: String(error) });
      }
    })();
    void pending.update(async (previous) => {
      await Promise.all([previous, running]);
    });
  };

  const note = async (entry: DoneEntry, words: string | undefined, undone: Result<boolean, string>): Promise<void> => {
    const done = await work(correctionPrompt(entry, words, undone));
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

  return {
    correct: async (id, text) => {
      const found = store.findDone(id);
      if (!found) return fail("not_found");
      const { entry } = found;
      const words = text?.trim() === "" ? undefined : text?.trim();
      if (entry.corrected_at !== undefined) {
        if (words !== undefined) background(() => note(entry, words, ok(false)));
        return ok(entry);
      }
      // Marked before undoing, so the same correction said again meanwhile only adds words.
      const corrected: DoneEntry = { ...entry, corrected_at: toTimestamp(clock.now()) };
      store.replaceDone(corrected);
      const undoing = entry.undo ? await desk.undo(id) : ok(undefined);
      const undone: Result<boolean, string> = undoing.ok ? ok(entry.undo) : fail(undoing.failure);
      background(() => note(entry, words, undone));
      return ok(store.findDone(id)?.entry ?? corrected);
    },
    settled: () => pending.get(),
  };
};
