import { createHash } from "node:crypto";
import { createCell } from "#cell.ts";
import { toTimestamp, type Cancel, type Clock } from "#clock.ts";
import type { Calendar } from "#calendar/calendar.ts";
import type { ContactCards, Contacts, Person } from "#contacts/contacts.ts";
import type { Photo } from "#contacts/vcard.ts";
import { dayMs } from "#desk/day.ts";
import type { DayNote, DayNotes } from "#dream/notes.ts";
import type { Memory } from "#memory/memory.ts";
import { parsePage, toAddress, toDay } from "#memory/pages.ts";
import {
  changeCircles,
  circleKey,
  circleOf,
  circlesSetting,
  isOthers,
  readCircles,
  type CircleChange,
} from "#people/circles.ts";
import { latestOf, mentionOf, sentenceWith, togetherOf, type Evidence, type Moment } from "#people/evidence.ts";
import { fullNames, handlesIn, hintOf, joinHandles, judge, type Handles } from "#people/linking.ts";
import type { Senders } from "#people/senders.ts";
import type {
  CalendarItem,
  CircleOrder,
  ContactCard,
  Message,
  People,
  PersonComingUp,
  PersonPage as PersonPageBody,
  PersonSummary,
  Question,
  SharedPlace,
  WakeUp,
} from "#protocol/types.ts";
import { fail, ok, type Result } from "#result.ts";
import type { Store } from "#store/store.ts";
import { textOf } from "#tools/input.ts";
import type { Tool, ToolResult } from "#tools/mcp.ts";
import type { Info } from "#turns/turns.ts";
import type { WakeUps } from "#wakeups/wakeups.ts";
import type { Questions } from "#work/questions.ts";
import type { Tracks } from "#work/tracks.ts";

// People: Kumo's People pages beside their cards in iCloud Contacts. The page holds what Kumo knows, the card the
// facts (photo, birthday, how to reach them), and the page's `contact` links the two. Kumo links a page on its own
// when it's sure, and otherwise asks in Understanding you which card it is; Contacts never change for it. The app
// gets everyone grouped by circle in his order, with when he last saw them and what's coming up, all from evidence.

// Who someone is, for the places seam: their page and the names they go by.
export type PersonReference = { readonly address: string; readonly names: readonly string[] };

export type LinkReport = {
  readonly linked: readonly { readonly person: string; readonly name: string; readonly card: string }[];
  readonly asked: readonly { readonly person: string; readonly name: string; readonly question: string }[];
  readonly unmatched: readonly string[];
};

export type PeopleKeeper = {
  readonly list: () => Promise<People>;
  readonly person: (id: string) => Promise<PersonPageBody | undefined>;
  readonly photo: (name: string) => Photo | undefined;
  readonly circles: () => Promise<CircleOrder>;
  readonly changeCircles: (wanted: readonly CircleChange[]) => Promise<Result<CircleOrder, string>>;
  // Links pages to cards now: every page not linked yet, or only this one.
  readonly link: (only?: string) => Promise<Result<LinkReport, string>>;
  // Takes in an answer to a contact question in Understanding you.
  readonly answered: (question: Question) => Promise<Result<string, string>>;
  readonly tool: Tool;
  readonly close: () => void;
};

export type PeopleOptions = {
  readonly memory: Pick<Memory, "withThread" | "setPersonFields" | "sync">;
  readonly contacts: Pick<Contacts, "cards" | "card" | "groupsOf" | "photo" | "onRefreshed">;
  readonly questions: Pick<Questions, "addContact" | "contactQuestions" | "settleContact">;
  readonly tracks: Pick<Tracks, "ensure">;
  readonly store: Pick<Store, "setting" | "setSetting" | "messagesSince">;
  readonly senders: Pick<Senders, "addressesOf">;
  readonly calendar: Pick<Calendar, "listItems" | "attendeesOf">;
  readonly wakeUps: Pick<WakeUps, "list">;
  readonly dayNotes: Pick<DayNotes, "since">;
  readonly clock: Clock;
  readonly timeZone: () => string;
  readonly info: Info;
  // The seam for places: visits to places named after someone, such as Leo's, as evidence of time together.
  readonly visits?: (person: PersonReference) => readonly Evidence[];
  // The places someone shares with him; until places have their own ids, the place pages in memory linked to them.
  readonly places?: (person: PersonReference) => readonly SharedPlace[] | undefined;
  // How long after Contacts are read the linking pass runs on its own.
  readonly passDelayMs?: number;
};

type PageRecord = {
  readonly address: string;
  readonly id: string;
  readonly title: string;
  readonly gist?: string;
  readonly circle?: string;
  readonly contact?: string;
  readonly aliases: readonly string[];
  readonly links: readonly string[];
  readonly markdown: string;
};

type JournalDay = { readonly day: string; readonly address: string; readonly markdown: string };

type LinkState = {
  readonly state: "linked" | "asked" | "declined" | "none" | "unmatched";
  readonly declined?: readonly string[];
  readonly question?: string;
  // The cards it was judged against, so a page is looked at again once Contacts change.
  readonly cards?: string;
};

type Context = {
  readonly pages: readonly PageRecord[];
  readonly places: readonly PageRecord[];
  readonly groups: readonly PageRecord[];
  readonly journal: readonly JournalDay[];
  readonly notes: readonly DayNote[];
  readonly messages: readonly Message[];
  readonly items: readonly CalendarItem[];
  readonly wakeUps: readonly WakeUp[];
  readonly cards: ContactCards;
  readonly today: string;
  readonly now: number;
};

type Gathered = {
  readonly evidence: readonly Evidence[];
  readonly moments: readonly Moment[];
  readonly coming: readonly PersonComingUp[];
};

export const linksSetting = "people_links";
export const peopleTrack = "Your people";
const peopleTrackNote = "Who's who in your contacts, and who matters to you.";

const defaultPassDelayMs = 5 * 60 * 1000;
// How far back the evidence reaches: a year and a bit, so "Not since August" still has August.
const lookBackMs = 400 * dayMs;
const togetherMs = 90 * dayMs;
const mostMessages = 2000;
const mostMoments = 10;
const mostComing = 5;
const mostOpenQuestions = 5;
const mostWords = 3;

const failed = (text: string): ToolResult => ({ text, isError: true });

const listed = (items: readonly string[]): string =>
  items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items.at(-1) ?? ""}`;

const jsonOf = (text: string | undefined): unknown => {
  try {
    return text === undefined ? undefined : (JSON.parse(text) as unknown);
  } catch {
    return undefined;
  }
};

const pad = (value: number): string => String(value).padStart(2, "0");

// The next time a day of the year comes round, from today; 29 February is the 28th in other years.
const isLeap = (year: number): boolean => (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;

const nextDay = (month: number, day: number, today: string): string => {
  const year = Number(today.slice(0, 4));
  const on = (y: number): string =>
    `${String(y)}-${pad(month)}-${pad(month === 2 && day === 29 && !isLeap(y) ? 28 : day)}`;
  const thisYear = on(year);
  return thisYear >= today ? thisYear : on(year + 1);
};

const generationOf = (cards: readonly Person[]): string =>
  createHash("sha256")
    .update(
      cards
        .map(({ facts }) => facts.uid)
        .toSorted((left, right) => left.localeCompare(right))
        .join("\n"),
    )
    .digest("hex")
    .slice(0, 16);

// A name's first word, when it has more than one.
const firstOf = (name: string): string | undefined => {
  const [first, ...rest] = name.trim().split(/\s+/u);
  return first !== undefined && rest.length > 0 && first.length >= 2 ? first : undefined;
};

const byRecency = (left: PersonSummary, right: PersonSummary): number =>
  (right.last_seen?.day ?? "").localeCompare(left.last_seen?.day ?? "") || left.name.localeCompare(right.name);

const reportText = ({ linked, asked, unmatched }: LinkReport): string => {
  if (linked.length === 0 && asked.length === 0 && unmatched.length === 0) {
    return "Every People page is linked to a card, or waiting on an answer.";
  }
  return [
    ...(linked.length === 0 ? [] : [`Linked on your own: ${listed(linked.map(({ name }) => name))}.`]),
    ...(asked.length === 0
      ? []
      : [`Asked them in Understanding you which card is ${listed(asked.map(({ name }) => name))}.`]),
    ...(unmatched.length === 0 ? [] : [`No card fits ${listed(unmatched)}.`]),
  ].join(" ");
};

const hoursBetween = (start: string, end: string): number =>
  Math.max(0, (Date.parse(end) - Date.parse(start)) / 3_600_000);

const cardBody = (person: Person): ContactCard => {
  const { facts } = person;
  return {
    uid: facts.uid,
    name: facts.name,
    ...(facts.nickname !== undefined && { nickname: facts.nickname }),
    ...(facts.organisation !== undefined && { organisation: facts.organisation }),
    ...(facts.title !== undefined && { job_title: facts.title }),
    phones: facts.phones.map(({ value, label, preferred }) => ({
      value,
      ...(label !== undefined && { label }),
      ...(preferred === true && { preferred: true }),
    })),
    emails: facts.emails.map(({ value, label, preferred }) => ({
      value,
      ...(label !== undefined && { label }),
      ...(preferred === true && { preferred: true }),
    })),
    addresses: facts.addresses.map(({ label, street, city, region, postcode, country }) => ({
      ...(label !== undefined && { label }),
      street,
      city,
      region,
      postcode,
      country,
    })),
    ...(facts.birthday !== undefined && { birthday: facts.birthday }),
    ...(person.photo !== undefined && { photo: person.photo.name }),
  };
};

export const createPeople = ({
  memory,
  contacts,
  questions,
  tracks,
  store,
  senders,
  calendar,
  wakeUps,
  dayNotes,
  clock,
  timeZone,
  info,
  visits = () => [],
  places,
  passDelayMs = defaultPassDelayMs,
}: PeopleOptions): PeopleKeeper => {
  const chain = createCell<Promise<unknown>>(Promise.resolve());
  const scheduled = createCell<Cancel | undefined>(undefined);
  const isPassing = createCell(false);
  const isClosed = createCell(false);

  // One pass or answer at a time, so two never link the same page.
  const serially = <Value>(work: () => Promise<Value>): Promise<Value> => {
    const run = async (): Promise<Value> => {
      try {
        await chain.get();
      } catch {
        info("A People pass before this one failed", {});
      }
      return work();
    };
    const next = run();
    chain.set(next);
    return next;
  };

  const readShelf = (shelf: "people" | "places" | "groups"): Promise<readonly PageRecord[]> =>
    memory.withThread((thread) =>
      Promise.resolve(
        thread
          .files()
          .filter((file) => file.startsWith(`${shelf}/`) && file.endsWith(".md"))
          .map((file) => {
            const address = toAddress(file);
            const page = parsePage(thread.read(file) ?? "", address);
            return {
              address,
              id: address.replace(`memory:${shelf}/`, ""),
              title: page.title,
              ...(page.gist !== undefined && { gist: page.gist }),
              ...(page.circle !== undefined && { circle: page.circle }),
              ...(page.contact !== undefined && { contact: page.contact }),
              aliases: page.aliases,
              links: page.links,
              markdown: page.markdown,
            };
          })
          .toSorted((left, right) => left.address.localeCompare(right.address)),
      ),
    );

  const readJournal = (since: string): Promise<readonly JournalDay[]> =>
    memory.withThread((thread) =>
      Promise.resolve(
        thread
          .files()
          .flatMap((file) => {
            const day = /^journal\/(?<day>\d{4}-\d{2}-\d{2})\.md$/u.exec(file)?.groups?.day;
            return day === undefined || day < since
              ? []
              : { day, address: toAddress(file), markdown: parsePage(thread.read(file) ?? "", day).markdown };
          })
          .toSorted((left, right) => left.day.localeCompare(right.day)),
      ),
    );

  const order = (): readonly string[] => readCircles(store.setting(circlesSetting));

  const states = (): Readonly<Record<string, LinkState>> => {
    const value = jsonOf(store.setting(linksSetting));
    return typeof value === "object" && value !== null ? (value as Record<string, LinkState>) : {};
  };

  const setState = (address: string, state: LinkState): void => {
    store.setSetting(linksSetting, JSON.stringify({ ...states(), [address]: state }));
  };

  // The card a page is linked to now, following merges, when Contacts have it.
  const cardOf = (page: PageRecord): Person | undefined =>
    page.contact === undefined ? undefined : contacts.card(page.contact);

  // The names someone goes by, for finding them in what's written: their page's names, their card's, and a first
  // name when no one else on a People page has it.
  const namesOf = (page: PageRecord, card: Person | undefined, pages: readonly PageRecord[]): readonly string[] => {
    const othersFirsts = new Set(
      pages
        .filter((other) => other.address !== page.address)
        .flatMap((other) => [other.title, ...other.aliases].map((name) => (firstOf(name) ?? name).toLowerCase())),
    );
    const firsts = [firstOf(page.title), card?.facts.given].filter(
      (name): name is string => name !== undefined && !othersFirsts.has(name.toLowerCase()),
    );
    return [
      ...new Set(
        [page.title, ...page.aliases, card?.facts.name, card?.facts.nickname, ...firsts].filter(
          (name): name is string => name !== undefined && name.trim().length >= 2,
        ),
      ),
    ];
  };

  const loadContext = async (withHistory: boolean): Promise<Context> => {
    await memory.sync();
    const now = clock.now();
    const zone = timeZone();
    const since = toDay(now - lookBackMs, zone);
    const [pages, placePages, groupPages, cards] = await Promise.all([
      readShelf("people"),
      readShelf("places"),
      readShelf("groups"),
      contacts.cards(),
    ]);
    return {
      pages,
      places: placePages,
      groups: groupPages,
      journal: withHistory ? await readJournal(since) : [],
      notes: withHistory ? dayNotes.since(since) : [],
      messages: withHistory
        ? store.messagesSince(toTimestamp(now - lookBackMs), mostMessages).filter(({ role }) => role === "user")
        : [],
      items: withHistory ? calendar.listItems().filter((item) => !item.calendar.kumo) : [],
      wakeUps: withHistory ? wakeUps.list() : [],
      cards,
      today: toDay(now, zone),
      now,
    };
  };

  // Everything that shows time with someone, the lines that mention them, and what's coming up with them.
  const gather = (page: PageRecord, card: Person | undefined, context: Context): Gathered => {
    const zone = timeZone();
    const names = namesOf(page, card, context.pages);
    const mentions = mentionOf(names);
    const emails = new Set(card?.facts.emails.map(({ value }) => value.toLowerCase()));
    const isWith = (item: CalendarItem): boolean =>
      mentions(item.title) ||
      (item.location !== undefined && mentions(item.location)) ||
      calendar.attendeesOf(item.uid).some((who) => emails.has(who.toLowerCase()) || mentions(who));
    const dayOfWhen = (when: string): string => (when.length === 10 ? when : toDay(Date.parse(when), zone));
    const journal = context.journal.filter(({ markdown }) => mentions(markdown));
    const notes = context.notes.filter(({ text }) => mentions(text));
    const events = context.items.filter((item) => isWith(item));
    const past = events.filter((item) => Date.parse(item.start) <= context.now);
    const ahead = events.filter((item) => Date.parse(item.start) > context.now);
    const evidence: readonly Evidence[] = [
      ...journal.map(({ day }) => ({ day, kind: "journal" as const })),
      ...notes.map(({ day }) => ({ day, kind: "day_note" as const })),
      ...context.messages
        .filter(({ text }) => mentions(text))
        .map(({ at }) => ({ day: toDay(Date.parse(at), zone), kind: "chat" as const })),
      ...past.map((item) => ({
        day: dayOfWhen(item.start),
        kind: "calendar" as const,
        ...(!item.all_day && { at: item.start, hours: hoursBetween(item.start, item.end) }),
        what: item.title,
      })),
      ...visits({ address: page.address, names }),
    ];
    const moments: readonly Moment[] = [
      ...journal.flatMap(({ day, address, markdown }) => {
        const text = sentenceWith(markdown, mentions);
        return text === undefined ? [] : { day, text, from: "journal" as const, page: address };
      }),
      ...notes.flatMap(({ day, text }) => {
        const line = sentenceWith(text, mentions);
        return line === undefined ? [] : { day, text: line, from: "day_note" as const };
      }),
    ]
      .toSorted((left, right) => right.day.localeCompare(left.day))
      .slice(0, mostMoments);
    const birthday = card?.facts.birthday;
    const comingAll: readonly PersonComingUp[] = [
      ...(birthday === undefined
        ? []
        : [
            {
              kind: "birthday" as const,
              day: nextDay(birthday.month, birthday.day, context.today),
              title: "Birthday",
            },
          ]),
      ...ahead.map((item) => ({
        kind: "event" as const,
        day: dayOfWhen(item.start),
        ...(!item.all_day && { at: item.start }),
        title: item.title,
        event: item.uid,
      })),
      ...context.wakeUps
        .filter(({ at, title, what }) => Date.parse(at) > context.now && (mentions(title) || mentions(what)))
        .map((wakeUp) => ({
          kind: "wake_up" as const,
          day: toDay(Date.parse(wakeUp.at), zone),
          at: wakeUp.at,
          title: wakeUp.title,
          wake_up: wakeUp.id,
        })),
    ];
    const coming = comingAll
      .toSorted((left, right) => left.day.localeCompare(right.day) || (left.at ?? "").localeCompare(right.at ?? ""))
      .slice(0, mostComing);
    return { evidence, moments, coming };
  };

  const summaryOf = (page: PageRecord, card: Person | undefined, gathered: Gathered): PersonSummary => {
    const last = latestOf(gathered.evidence);
    const contact = card?.facts.uid ?? page.contact;
    return {
      id: page.id,
      name: page.title,
      ...(page.gist !== undefined && { gist: page.gist }),
      circle: circleOf(page.circle, order()),
      ...(contact !== undefined && { contact }),
      ...(card?.photo !== undefined && { photo: card.photo.name }),
      ...(last !== undefined && {
        last_seen: {
          day: last.day,
          kind: last.kind,
          ...(last.at !== undefined && { at: last.at }),
          ...(last.what !== undefined && { what: last.what }),
        },
      }),
      coming_up: [...gathered.coming],
    };
  };

  const list = async (): Promise<People> => {
    const context = await loadContext(true);
    const summaries = context.pages.map((page) => {
      const card = cardOf(page);
      return summaryOf(page, card, gather(page, card, context));
    });
    return {
      circles: order().map((name) => ({
        name,
        ...(isOthers(name) && { others: true }),
        people: summaries.filter((summary) => summary.circle === name).toSorted(byRecency),
      })),
      count: summaries.length,
      linked: summaries.filter(({ contact }) => contact !== undefined).length,
    };
  };

  const sharedPlaces = (page: PageRecord, names: readonly string[], context: Context): readonly SharedPlace[] => {
    const given = places?.({ address: page.address, names });
    if (given !== undefined) return given;
    const mentions = mentionOf(names);
    return context.places
      .filter(
        (place) => page.links.includes(place.address) || place.links.includes(page.address) || mentions(place.markdown),
      )
      .map((place) => ({ place: place.address, title: place.title }));
  };

  const person = async (id: string): Promise<PersonPageBody | undefined> => {
    const context = await loadContext(true);
    const page = context.pages.find((candidate) => candidate.id === id);
    if (!page) return undefined;
    const card = cardOf(page);
    const gathered = gather(page, card, context);
    const since = toDay(context.now - togetherMs, timeZone());
    return {
      person: summaryOf(page, card, gathered),
      page: page.address,
      ...(card !== undefined && { card: cardBody(card) }),
      markdown: page.markdown,
      moments: [...gathered.moments],
      places: [...sharedPlaces(page, namesOf(page, card, context.pages), context)],
      together: { since, ...togetherOf(gathered.evidence, since) },
    };
  };

  const circlesNow = async (): Promise<CircleOrder> => {
    await memory.sync();
    const pages = await readShelf("people");
    const current = order();
    return {
      circles: current.map((name) => ({
        name,
        count: pages.filter((page) => circleOf(page.circle, current) === name).length,
        ...(isOthers(name) && { others: true }),
      })),
    };
  };

  const changeOrder = async (wanted: readonly CircleChange[]): Promise<Result<CircleOrder, string>> => {
    const changed = changeCircles(order(), wanted);
    if (!changed.ok) return changed;
    const pages = await readShelf("people");
    const moves = changed.value.renames.flatMap(([from, to]) =>
      pages
        .filter(({ circle }) => circle !== undefined && circleKey(circle) === circleKey(from))
        .map((page) => ({ page, from, to })),
    );
    const moved = await moves.reduce<Promise<Result<string, string>>>(
      async (before, { page, from, to }) => {
        const done = await before;
        return done.ok
          ? memory.setPersonFields(page.address, { circle: to.toLowerCase() }, `Renamed the circle ${from} to ${to}`)
          : done;
      },
      Promise.resolve(ok("")),
    );
    if (!moved.ok) return moved;
    store.setSetting(circlesSetting, JSON.stringify(changed.value.order));
    return ok(await circlesNow());
  };

  // What Kumo has to go on about someone before asking: how often they come up, and what with.
  const understoodOf = (page: PageRecord, context: Context, pages: readonly PageRecord[]): string => {
    const { evidence } = gather(page, undefined, context);
    const titles = page.links
      .flatMap(
        (link) => [...pages, ...context.groups, ...context.places].find(({ address }) => address === link)?.title ?? [],
      )
      .slice(0, mostWords);
    const words = titles.length > 0 ? `: ${titles.join(", ")}` : "";
    if (evidence.length > 0) return `Mentioned ${String(evidence.length)} times${words}.`;
    return page.gist === undefined ? `I keep a page on ${page.title}${words}.` : `${page.gist}${words}.`;
  };

  // What's been seen with someone: emails and phones on their page, mail from them under the same name, and
  // numbers he gave in the chat when he named them.
  const handlesOf = (page: PageRecord, messages: readonly Message[]): Handles => {
    const names = fullNames(page);
    const mentions = mentionOf([page.title, ...page.aliases]);
    return joinHandles([
      handlesIn(page.markdown),
      { emails: senders.addressesOf(names), phones: [] },
      ...messages.filter(({ text }) => mentions(text)).map(({ text }) => handlesIn(text)),
    ]);
  };

  const linkNow = async (only?: string): Promise<Result<LinkReport, string>> => {
    const context = await loadContext(false);
    if (!context.cards.isReadable) return fail("Their Contacts can't be read right now, so nothing could be linked.");
    const cards = context.cards.people;
    const generation = generationOf(cards);
    const wanted = only === undefined ? undefined : only.startsWith("memory:") ? only : `memory:people/${only}`;
    if (wanted !== undefined && context.pages.every(({ address }) => address !== wanted)) {
      return fail(`There's no People page ${wanted}.`);
    }
    // A question about a page that's linked now, or gone, is settled.
    for (const question of questions.contactQuestions()) {
      const page = context.pages.find(({ id }) => id === question.contact?.person);
      if (question.state !== "open") continue;
      if (!page) questions.settleContact(question.id, "Their People page has gone.");
      else if (page.contact !== undefined) questions.settleContact(question.id, "Their page is linked to a card now.");
    }
    const alreadyLinked = new Set(context.pages.flatMap((page) => cardOf(page)?.facts.uid ?? page.contact ?? []));
    const isDue = (page: PageRecord): boolean => {
      if (page.contact !== undefined) return false;
      if (wanted !== undefined) return page.address === wanted;
      const known = states()[page.address];
      if (known === undefined || known.state === "linked") return true;
      if (known.state === "none") return false;
      if (known.state === "asked") {
        return questions.contactQuestions().every(({ id, state }) => state !== "open" || id !== known.question);
      }
      return known.cards !== generation;
    };
    const due = context.pages.filter((page) => isDue(page));
    if (due.length === 0) return ok({ linked: [], asked: [], unmatched: [] });
    const history = await loadContext(true);
    type Pending = LinkReport & { readonly uids: ReadonlySet<string> };
    const linkOne = async (done: Pending, page: PageRecord): Promise<Pending> => {
      const declined = new Set(states()[page.address]?.declined);
      const free = cards.filter(({ facts }) => !done.uids.has(facts.uid) && !declined.has(facts.uid));
      const verdict = judge(page, handlesOf(page, history.messages), free);
      if (verdict.kind === "sure") {
        const uid = verdict.person.facts.uid;
        const linked = await memory.setPersonFields(
          page.address,
          { contact: uid },
          `Linked to ${verdict.person.facts.name} in Contacts, by ${verdict.why}`,
        );
        if (!linked.ok) {
          info("A People page couldn't be linked to its card", { page: page.address, reason: linked.failure });
          return done;
        }
        setState(page.address, { state: "linked" });
        return {
          ...done,
          linked: [...done.linked, { person: page.id, name: page.title, card: uid }],
          uids: new Set([...done.uids, uid]),
        };
      }
      const kept = declined.size > 0 ? { declined: [...declined] } : {};
      if (verdict.kind === "none") {
        setState(page.address, { state: "unmatched", cards: generation, ...kept });
        return { ...done, unmatched: [...done.unmatched, page.id] };
      }
      const open = questions.contactQuestions().filter(({ state }) => state === "open").length;
      if (open >= mostOpenQuestions) return done;
      const track = tracks.ensure(peopleTrack, peopleTrackNote);
      const question = questions.addContact({
        track: track.id,
        understood: understoodOf(page, history, context.pages),
        missing: `Is this ${page.title} from your contacts?`,
        why: `So ${page.title}'s page shows their photo, birthday and how to reach them.`,
        contact: {
          person: page.id,
          name: page.title,
          candidates: verdict.candidates
            .filter(({ facts }) => facts.uid.length <= 80)
            .map((candidate) => ({
              uid: candidate.facts.uid,
              name: candidate.facts.name,
              hint: hintOf(candidate, contacts.groupsOf(candidate.facts.uid)),
              ...(candidate.photo !== undefined && { photo: candidate.photo.name }),
            })),
        },
      });
      setState(page.address, { state: "asked", question: question.id, cards: generation, ...kept });
      return { ...done, asked: [...done.asked, { person: page.id, name: page.title, question: question.id }] };
    };
    const { linked, asked, unmatched } = await due.reduce<Promise<Pending>>(
      async (before, page) => linkOne(await before, page),
      Promise.resolve({ linked: [], asked: [], unmatched: [], uids: alreadyLinked }),
    );
    return ok({ linked, asked, unmatched });
  };

  const link = (only?: string): Promise<Result<LinkReport, string>> =>
    serially(async () => {
      isPassing.set(true);
      try {
        return await linkNow(only);
      } finally {
        isPassing.set(false);
      }
    });

  const answered = (question: Question): Promise<Result<string, string>> =>
    serially(async () => {
      const { contact, answer } = question;
      if (contact === undefined || answer === undefined) return fail("That isn't an answered contact question.");
      const address = `memory:people/${contact.person}`;
      const previous = states()[address];
      const [picked] = answer.picked ?? [];
      if (picked !== undefined) {
        const name = contact.candidates.find(({ uid }) => uid === picked)?.name ?? "their card";
        const linked = await memory.setPersonFields(
          address,
          { contact: picked },
          `Linked to ${name} in Contacts: you said so`,
        );
        if (!linked.ok) return linked;
        setState(address, { state: "linked" });
        return ok(`${contact.name} is ${name} in your contacts.`);
      }
      if (answer.not_in_contacts === true) {
        setState(address, { state: "none" });
        return ok(`${contact.name} isn't in your contacts, so I'll stop looking for their card.`);
      }
      const read = await contacts.cards();
      const cards = generationOf(read.people);
      if (answer.none_fit === true) {
        const declined = [...new Set([...(previous?.declined ?? []), ...contact.candidates.map(({ uid }) => uid)])];
        setState(address, { state: "declined", declined, cards });
        return ok(
          `Neither is ${contact.name}: I won't suggest ${listed(contact.candidates.map(({ name }) => name))} again.`,
        );
      }
      setState(address, { state: "declined", declined: [...(previous?.declined ?? [])], cards });
      return ok(`I'll leave ${contact.name} unlinked for now.`);
    });

  const tool: Tool = {
    name: "contacts_link",
    title: "Link People pages to Contacts",
    audience: "work",
    description:
      "Link People pages to their cards in Contacts now. A sure match (an email or phone in common, or a full " +
      "name only one card has) links on its own; when two cards could fit, or only a first name matches, it asks " +
      "them in Understanding you which card it is, with the candidates. Linking changes only the page, never " +
      "Contacts. It runs on its own soon after new People pages appear: use it after writing several, or give one " +
      "page to look at it again. When you're sure from a mail or the chat, give edit_page the contact instead.",
    inputSchema: {
      type: "object",
      properties: {
        page: { type: "string", description: "Only this People page, such as memory:people/omar." },
      },
      additionalProperties: false,
    },
    call: async (input) => {
      const page = textOf(input, "page").trim();
      const done = await link(page === "" ? undefined : page);
      return done.ok ? { text: reportText(done.value), structured: done.value } : failed(done.failure);
    },
  };

  const passNow = async (): Promise<void> => {
    try {
      const done = await link();
      if (!done.ok) info("People pages couldn't be linked to Contacts", { reason: done.failure });
      else if (done.value.linked.length > 0 || done.value.asked.length > 0) {
        info("Linked People pages to Contacts", { linked: done.value.linked.length, asked: done.value.asked.length });
      }
    } catch (error) {
      info("People pages couldn't be linked to Contacts", { error: String(error) });
    }
  };

  // Soon after each read of Contacts, pages that appeared since, or that Contacts' changes might now fit, are looked
  // at: the first read after the server starts covers every page that was never looked at.
  contacts.onRefreshed(() => {
    if (isClosed.get() || isPassing.get() || scheduled.get() !== undefined) return;
    scheduled.set(
      clock.after(passDelayMs, () => {
        scheduled.set(undefined);
        if (isClosed.get()) return;
        void passNow();
      }),
    );
  });

  return {
    list,
    person,
    photo: (name) => contacts.photo(name),
    circles: circlesNow,
    changeCircles: changeOrder,
    link,
    answered,
    tool,
    close: () => {
      isClosed.set(true);
      scheduled.get()?.();
      scheduled.set(undefined);
    },
  };
};
