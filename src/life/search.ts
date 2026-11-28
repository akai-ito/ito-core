import { toMessageId } from "#conversation/ids.ts";
import type { DayNotes } from "#dream/notes.ts";
import type { JsonSchema } from "#engine/engine.ts";
import type { GoingOn } from "#life/going-on.ts";
import type { Lines } from "#life/lines.ts";
import type { LifePlaces } from "#life/places.ts";
import type { MadePages } from "#made/made.ts";
import type { Hit, Memory } from "#memory/memory.ts";
import { dayTitle } from "#memory/pages.ts";
import type { PeopleKeeper } from "#people/people.ts";
import type { LifeSearch, PersonSummary, SearchDay, SearchMessage } from "#protocol/types.ts";
import { withoutBlocks } from "#replies/blocks.ts";
import { fail, ok, type Result } from "#result.ts";
import type { Store } from "#store/store.ts";
import { textOf } from "#tools/input.ts";

// The search at the top of Life: Kumo's short answer first, written on the quick model over what was found, then
// what was found, grouped: days (journal days and day notes), places, people, what's going on, made pages and chat
// messages, each with enough to show a row and open it. Pages and past conversations come from memory's own search;
// the rest is matched by its words.
export type Search = { readonly find: (query: string) => Promise<Result<LifeSearch, string>> };

export type SearchOptions = {
  readonly memory: Pick<Memory, "sync" | "search" | "pages">;
  readonly dayNotes: Pick<DayNotes, "since">;
  readonly places: LifePlaces;
  readonly people: Pick<PeopleKeeper, "list">;
  readonly goingOn: GoingOn;
  readonly made: Pick<MadePages, "list">;
  readonly store: Pick<Store, "findMessage">;
  readonly lines: Lines;
  readonly now: () => number;
  readonly timeZone: () => string;
};

export const longestQuery = 200;

const passagesSearched = 40;
const mostPerGroup = 5;
const mostPlaces = 3;
const passagesAnswered = 8;
const notesSearchedDays = 30;
const excerptChars = 240;

const dayMs = 24 * 60 * 60 * 1000;

// Words too common to find anything by on their own.
const commonWords = new Set([
  "the",
  "and",
  "with",
  "for",
  "was",
  "were",
  "what",
  "when",
  "where",
  "who",
  "how",
  "did",
  "does",
  "that",
  "this",
  "from",
  "about",
  "have",
  "had",
  "has",
  "you",
  "your",
  "my",
  "our",
  "his",
  "her",
  "their",
  "its",
  "into",
  "out",
  "on",
  "in",
  "at",
  "to",
  "of",
  "a",
  "an",
  "is",
  "it",
  "be",
  "me",
  "we",
  "us",
  "last",
  "ago",
]);

export const wordsOf = (query: string): readonly string[] =>
  [...new Set(query.toLowerCase().match(/[\p{L}\p{N}]+/gu))].filter(
    (word) => word.length >= 3 && !commonWords.has(word),
  );

const matches = (text: string, words: readonly string[]): number => {
  const lower = text.toLowerCase();
  return words.filter((word) => lower.includes(word)).length;
};

// A passage without the page's title in front, as memory's search keeps it, or who said it.
const excerptOf = ({ title, text }: Hit): string =>
  text
    .replace(`${title}: `, "")
    .replace(/^(?:You said|Ari said): /u, "")
    .replaceAll(/\s+/gu, " ")
    .trim()
    .slice(0, excerptChars);

const shelfOf = (address: string): string | undefined => /^memory:(?<shelf>[a-z-]+)\//u.exec(address)?.groups?.shelf;

const nameOf = (address: string): string => address.slice(address.lastIndexOf("/") + 1);

const answerSchema: JsonSchema = {
  type: "object",
  properties: { answer: { type: "string" } },
  required: ["answer"],
  additionalProperties: false,
};

const toAnswer = (answer: unknown): { readonly text?: string } => {
  const text = textOf(answer, "answer").replaceAll(/\s+/gu, " ").trim();
  return text === "" ? {} : { text };
};

export const toAnswerPrompt = (query: string, today: string, passages: readonly string[]): string =>
  [
    "You are Kumo, their assistant. They searched their life in Ito for this:",
    query,
    "",
    'Answer first, above what was found: one or two short sentences, at most 30 words, to them as "you", such as',
    "\"Orrin's, last Friday, 19:40 to 22:10. You wrote that the fig thing was the best you'd had all month.\"",
    "- Say when and where plainly, counting from today, such as last Friday or on 3 October.",
    "- Only from what was found below. When it doesn't answer the search, answer with nothing.",
    "",
    `Today is ${today}.`,
    "",
    "What was found:",
    ...passages,
  ].join("\n");

export const createSearch = ({
  memory,
  dayNotes,
  places,
  people,
  goingOn,
  made,
  store,
  lines,
  now,
  timeZone,
}: SearchOptions): Search => ({
  find: async (given) => {
    const query = given.replaceAll(/\s+/gu, " ").trim();
    if (query === "") return fail("Give something to search for.");
    if (query.length > longestQuery) return fail(`A search is at most ${String(longestQuery)} characters.`);
    await memory.sync();
    const words = wordsOf(query);
    const hits = await memory.search(query, passagesSearched);
    const pageHits = hits.filter((hit) => hit.message === undefined);

    // Days: journal days memory's search found, then days whose notes say the words.
    const gists = new Map(memory.pages("journal").map((page) => [nameOf(page.address), page.gist] as const));
    const fromJournal = pageHits
      .filter((hit) => shelfOf(hit.address) === "journal")
      .map((hit): SearchDay => {
        const day = nameOf(hit.address);
        const gist = gists.get(day);
        return { day, ...(gist !== undefined && { gist }), journal: hit.address, excerpt: excerptOf(hit) };
      });
    const notesSince = new Date(now() - notesSearchedDays * dayMs).toISOString().slice(0, 10);
    const fromNotes = dayNotes
      .since(notesSince)
      .map((note) => ({ note, score: matches(note.text, words) }))
      .filter(({ score }) => score > 0)
      .toSorted((left, right) => right.score - left.score || right.note.day.localeCompare(left.note.day))
      .map(({ note }): SearchDay => {
        const gist = gists.get(note.day);
        return {
          day: note.day,
          ...(gist !== undefined && { gist }),
          ...(gist !== undefined && { journal: `memory:journal/${note.day}` }),
          excerpt: note.text.slice(0, excerptChars),
        };
      });
    const days = [...fromJournal, ...fromNotes]
      .filter((day, index, all) => all.findIndex((other) => other.day === day.day) === index)
      .slice(0, mostPerGroup)
      .map((day) => {
        const thread = places.threadOf(day.day);
        return thread ? { ...day, thread } : day;
      });

    // People: those memory's search found on their pages, and anyone whose name the search says.
    const listed = await people.list();
    const everyone = listed.circles.flatMap((circle) => circle.people);
    const found = new Set(
      pageHits.filter((hit) => shelfOf(hit.address) === "people").map((hit) => nameOf(hit.address)),
    );
    const named = everyone.filter((person) => matches(person.name, words) > 0);
    const fromPages = [...found].flatMap((id) => everyone.find((person) => person.id === id) ?? []);
    const foundPeople: readonly PersonSummary[] = [...named, ...fromPages]
      .filter((person, index, all) => all.findIndex((other) => other.id === person.id) === index)
      .slice(0, mostPerGroup);

    // What's going on: projects and goals memory's search found, things in motion, and titles the search says.
    const threads = await goingOn.threads();
    const foundTargets = new Set(pageHits.map((hit) => hit.address));
    const foundThreads = threads
      .filter(
        (thread) =>
          foundTargets.has(thread.id) ||
          (thread.page !== undefined && foundTargets.has(thread.page)) ||
          matches(thread.title, words) > 0,
      )
      .slice(0, mostPerGroup);

    const foundMade = made
      .list()
      .map((page) => ({ page, score: matches(`${page.title} ${page.summary}`, words) }))
      .filter(({ score }) => score > 0)
      .toSorted((left, right) => right.score - left.score || right.page.changed_at.localeCompare(left.page.changed_at))
      .slice(0, mostPerGroup)
      .map(({ page }) => page);

    const messages = hits
      .flatMap((hit): readonly SearchMessage[] => {
        if (hit.message === undefined) return [];
        const message = store.findMessage(toMessageId(hit.message));
        if (!message) return [];
        return [
          {
            message: message.id,
            ...(message.thread !== undefined && { thread: message.thread }),
            position: message.position,
            at: message.at,
            yours: message.role === "user",
            excerpt: withoutBlocks(message.text).replaceAll(/\s+/gu, " ").trim().slice(0, excerptChars),
          },
        ];
      })
      .slice(0, mostPerGroup);

    const foundPlaces = places.find(words).slice(0, mostPlaces);

    const passages = [
      ...days.map((day) => `- ${dayTitle(day.day)}: ${day.gist ?? ""} ${day.excerpt}`.trim()),
      ...foundPlaces.map((place) => `- The place ${place.name ?? place.apple_name ?? ""}`),
      ...pageHits
        .filter((hit) => shelfOf(hit.address) !== "journal")
        .slice(0, passagesAnswered)
        .map((hit) => `- ${hit.title} (${hit.address}): ${excerptOf(hit)}`),
      ...messages.map(
        (message) => `- ${message.yours ? "You said" : "Kumo said"} on ${message.at.slice(0, 10)}: ${message.excerpt}`,
      ),
      ...foundMade.map((page) => `- A page Kumo made: ${page.title}, ${page.summary}`),
    ].slice(0, passagesAnswered * 2);
    const today = new Intl.DateTimeFormat("en-GB", {
      weekday: "long",
      day: "numeric",
      month: "long",
      year: "numeric",
      timeZone: timeZone(),
    }).format(now());
    const prompt = toAnswerPrompt(query, today, passages);
    const answer =
      passages.length === 0
        ? undefined
        : await lines.write({
            key: `search:${query.toLowerCase()}`,
            basis: prompt,
            prompt,
            schema: answerSchema,
            toValue: toAnswer,
          });
    return ok({
      query,
      ...(answer?.text !== undefined && { answer: answer.text }),
      days,
      places: [...foundPlaces],
      people: [...foundPeople],
      going_on: foundThreads,
      made: foundMade,
      messages: [...messages],
    });
  },
});
