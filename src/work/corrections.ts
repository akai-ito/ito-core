import { createCell } from "#cell.ts";
import { toTimestamp, type Clock } from "#clock.ts";
import { lastLine, quoteOf, type DeskKeeper, type Work } from "#desk/desk.ts";
import type { DoneEntry } from "#protocol/types.ts";
import { fail, ok, type Result } from "#result.ts";
import type { Store } from "#store/store.ts";
import type { Info } from "#turns/turns.ts";
import type { Tracks } from "#work/tracks.ts";

// "That was wrong", on anything Kumo did: it's undone where it can be, and it becomes evidence on the learning track
// it belongs to, which steps back; Kumo files one that names no track on the right one, in the background. It's never
// a new line on How to help you: the nightly dream distils the lasting lessons from the tracks' evidence.
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
  readonly tracks: Pick<Tracks, "find" | "corrected" | "addWords">;
  readonly info: Info;
};

const correctionPrompt = (
  entry: DoneEntry,
  words: string | undefined,
  undone: Result<boolean, string>,
  track: string | undefined,
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
    track === undefined
      ? [
          `Keep it as evidence on the track it belongs to: note_track with kind corrected and done ${entry.id}, its`,
          "text saying what was wrong and what you'll do differently, general enough to apply next time, such as a",
          "sender, a kind of mail or a kind of event rather than this one. If no track fits, open one for the area,",
          "such as Sorting mail or Your calendar, first.",
        ].join("\n")
      : `It's evidence on your ${track} track, which has stepped back for it.`,
    "Don't write it on How to help you: what lasts goes there from your tracks, each night.",
    "End with one line for their Done list saying what you'll do differently.",
  ].join("\n");
};

export const createCorrections = ({ store, desk, clock, work, tracks, info }: CorrectionsOptions): Corrections => {
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
    const track = entry.track === undefined ? undefined : tracks.find(entry.track)?.name;
    const done = await work(correctionPrompt(entry, words, undone, track));
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
        if (words !== undefined) {
          tracks.addWords(entry, words);
          background(() => note(entry, words, ok(false)));
        }
        return ok(entry);
      }
      // Marked before undoing, so the same correction said again meanwhile only adds words.
      const corrected: DoneEntry = { ...entry, corrected_at: toTimestamp(clock.now()) };
      store.replaceDone(corrected);
      tracks.corrected(entry, `You said “${quoteOf(entry.text)}” was wrong${words === undefined ? "" : `: ${words}`}`);
      const undoing = entry.undo ? await desk.undo(id) : ok(undefined);
      const undone: Result<boolean, string> = undoing.ok ? ok(entry.undo) : fail(undoing.failure);
      background(() => note(entry, words, undone));
      return ok(store.findDone(id)?.entry ?? corrected);
    },
    settled: () => pending.get(),
  };
};
