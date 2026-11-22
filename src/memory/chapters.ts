import { readFileSync } from "node:fs";
import type { OwnSkill } from "#capabilities/skills.ts";
import { toLocation, type Page } from "#memory/pages.ts";
import { fail, ok, type Result } from "#result.ts";
import { textOf } from "#tools/input.ts";

// Chapters: arcs of their life that Kumo notices and names, such as "Florence with Mira" or "Back to training".
// Each is a page on memory:chapters/…, so it lives in the Thread with everything else Kumo knows: a short story
// with photos where they belong, then what changed, linked to the people, places and journal days it draws on.
// Its front matter keeps the day it began, the day it ended once it's over (none while it's still going), and the
// day Kumo noticed it, which the server stamps when the page is first written.

export const chaptersShelf = "chapters";

export const chaptersSkill: OwnSkill = {
  id: "chapters",
  summary: "noticing the chapters of their life, writing each as a short story, and keeping them as life goes on",
  text: readFileSync(new URL("../../agent/chapters.md", import.meta.url), "utf8"),
};

export const beganGuide = "Chapters only: the day it began, as YYYY-MM-DD.";

export const endedGuide = `Chapters only: the day it ended, as YYYY-MM-DD, once it's over; or "open" when it's still going after all.`;

const reopen = "open";

const dayPattern = /^\d{4}-\d{2}-\d{2}$/u;

// A real day: 2026-02-30 isn't one.
const isDay = (text: string): boolean => {
  const at = Date.parse(`${text}T00:00:00.000Z`);
  return dayPattern.test(text) && !Number.isNaN(at) && new Date(at).toISOString().startsWith(text);
};

export type ChapterDates = { readonly began: string; readonly ended?: string; readonly noticed?: string };

const onlyChapters = "Only a chapter has began and ended dates: its page is on memory:chapters/….";

// What a write or an edit leaves a page's chapter dates as: none for a page on another shelf, the dates it gave
// or kept for a chapter, or why they can't be. `today` is the day where they are, which a new chapter is noticed on.
export const toChapterDates = (
  input: unknown,
  shelf: string,
  existing: Page | undefined,
  today: string,
): Result<ChapterDates | undefined, string> => {
  const began = textOf(input, "began").trim();
  const ended = textOf(input, "ended").trim();
  if (shelf !== chaptersShelf) return began === "" && ended === "" ? ok(undefined) : fail(onlyChapters);
  const nextBegan = began || existing?.began;
  if (nextBegan === undefined) return fail("A chapter needs the day it began, as began: YYYY-MM-DD.");
  if (!isDay(nextBegan)) return fail(`${nextBegan} isn't a day: give began as YYYY-MM-DD.`);
  const nextEnded = ended === reopen ? undefined : ended || existing?.ended;
  if (nextEnded !== undefined && !isDay(nextEnded)) {
    return fail(`${nextEnded} isn't a day: give ended as YYYY-MM-DD, or "${reopen}" if it's still going.`);
  }
  if (nextBegan > today) return fail("A chapter is something that's begun: began can't be after today.");
  if (nextEnded !== undefined && nextEnded > today) {
    return fail("A chapter ends once it's over: leave ended out until it is.");
  }
  if (nextEnded !== undefined && nextEnded < nextBegan) return fail("A chapter can't end before it began.");
  const noticed = existing ? existing.noticed : today;
  return ok({
    began: nextBegan,
    ...(nextEnded !== undefined && { ended: nextEnded }),
    ...(noticed !== undefined && { noticed }),
  });
};

// A page's front matter without its chapter dates, to set them afresh.
const chapterFields: ReadonlySet<string> = new Set(["began", "ended", "noticed"]);

export const withoutChapterDates = (page: Page): Page =>
  Object.fromEntries(Object.entries(page).filter(([field]) => !chapterFields.has(field))) as Page;

export type ChapterPhoto = {
  readonly source: string;
  readonly name: string;
  readonly width?: number;
  readonly height?: number;
};

// A chapter in the Library's row: its name, when, and the photo it opens with.
export type ChapterSummary = {
  readonly address: string;
  readonly title: string;
  readonly gist?: string;
  readonly began: string;
  readonly ended?: string;
  readonly cover?: ChapterPhoto;
  readonly changed_at: string;
};

// What a chapter's page says about the chapter: when, when Kumo noticed it, and what it drew on.
export type ChapterFacts = {
  readonly began: string;
  readonly ended?: string;
  readonly noticed?: string;
  readonly drawn_from: { readonly journal_days: number; readonly photos: number };
};

export type ChapterPage = {
  readonly address: string;
  readonly title: string;
  readonly gist?: string;
  readonly began?: string;
  readonly ended?: string;
  readonly noticed?: string;
  readonly links: readonly string[];
  readonly changed_at: string;
};

export type ChapterSources = {
  // Every chapter page in memory, as it is now.
  readonly pages: () => readonly ChapterPage[];
  // The photos a page shows from memory, in the order it shows them; none for a page that isn't there.
  readonly photosOf: (address: string) => readonly ChapterPhoto[];
  readonly exists: (address: string) => boolean;
};

export type Chapters = {
  // Still going first, the one changed most lately leading; then the rest, the latest to end first.
  readonly list: () => readonly ChapterSummary[];
  readonly factsOf: (page: ChapterPage) => ChapterFacts | undefined;
};

const isJournalDay = (address: string): boolean => {
  const location = toLocation(address);
  return location.ok && location.value.shelf === "journal";
};

const byLiveliness = (left: ChapterSummary, right: ChapterSummary): number => {
  if ((left.ended === undefined) !== (right.ended === undefined)) return left.ended === undefined ? -1 : 1;
  if (left.ended === undefined || right.ended === undefined) return right.changed_at.localeCompare(left.changed_at);
  return right.ended.localeCompare(left.ended) || right.began.localeCompare(left.began);
};

export const createChapters = ({ pages, photosOf, exists }: ChapterSources): Chapters => ({
  list: () =>
    pages()
      .map((page): ChapterSummary | undefined => {
        if (page.began === undefined) return undefined;
        const [cover] = photosOf(page.address);
        return {
          address: page.address,
          title: page.title,
          ...(page.gist !== undefined && { gist: page.gist }),
          began: page.began,
          ...(page.ended !== undefined && { ended: page.ended }),
          ...(cover && { cover }),
          changed_at: page.changed_at,
        };
      })
      .filter((summary) => summary !== undefined)
      .toSorted(byLiveliness),
  factsOf: (page) => {
    if (page.began === undefined) return;
    const days = page.links.filter((address) => isJournalDay(address) && exists(address));
    const photos = new Set([page.address, ...days].flatMap((address) => photosOf(address).map(({ name }) => name)));
    return {
      began: page.began,
      ...(page.ended !== undefined && { ended: page.ended }),
      ...(page.noticed !== undefined && { noticed: page.noticed }),
      drawn_from: { journal_days: days.length, photos: photos.size },
    };
  },
});
