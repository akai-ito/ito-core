import { describe, expect, it } from "vitest";
import { createCell } from "#cell.ts";
import type { ContactCards, Person } from "#contacts/contacts.ts";
import { factsOf, parseVCard, photoOf } from "#contacts/vcard.ts";
import { formatPage, parsePage } from "#memory/pages.ts";
import type { Thread } from "#memory/thread.ts";
import { changeCircles, circleOf, defaultCircles, readCircles } from "#people/circles.ts";
import { latestOf, mentionOf, sentenceWith, togetherOf } from "#people/evidence.ts";
import { handlesIn, hintOf, judge } from "#people/linking.ts";
import { createPeople, type PeopleKeeper } from "#people/people.ts";
import type { Question } from "#protocol/types.ts";
import { ok } from "#result.ts";
import { photo } from "./support/contact-cards.ts";
import { createVirtualClock } from "./support/virtual-clock.ts";

const ignore = (): void => undefined;

const now = Date.parse("2026-11-24T16:30:00.000Z");

const card = (lines: readonly string[]): Person => {
  const parsed = parseVCard(["BEGIN:VCARD", "VERSION:3.0", ...lines, "END:VCARD", ""].join("\r\n"));
  if (!parsed.ok) throw new Error(parsed.failure);
  const found = photoOf(parsed.value);
  const facts = factsOf(parsed.value, "fallback");
  return {
    url: `https://contacts.example/card/${facts.uid}.vcf`,
    book: { url: "https://contacts.example/card/", name: "Contacts", readOnly: false },
    facts,
    ...(found && { photo: { ...found, name: facts.uid.toLowerCase().padEnd(24, "0").slice(0, 24) } }),
  };
};

const omarHaddad = card([
  "N:Haddad;Omar;;;",
  "FN:Omar Haddad",
  "TEL;type=CELL:+44 7700 900789",
  "ADR;type=HOME:;;4 Dalry Road;Edinburgh;;EH11 2AA;United Kingdom",
  "BDAY:1993-01-09",
  photo,
  "UID:OMAR-H",
]);
const omarLindqvist = card([
  "N:Lindqvist;Omar;;;",
  "FN:Omar Lindqvist",
  "ORG:Halcyon;",
  "EMAIL;type=INTERNET;type=WORK:omar.lindqvist@halcyon.example",
  "UID:OMAR-L",
]);
const leoMarsh = card(["N:Marsh;Leo;;;", "FN:Leo Marsh", "EMAIL;type=HOME:leo@halcyon.example", "UID:LEO"]);
const claraVoss = card(["N:Voss;Clara;;;", "FN:Clara Voss", "ORG:Northwind;", "UID:CLARA"]);
const fiveASide = card([
  "FN:Five-a-side",
  "X-ADDRESSBOOKSERVER-KIND:group",
  "X-ADDRESSBOOKSERVER-MEMBER:urn:uuid:OMAR-H",
  "UID:GROUP-5",
]);

describe("linking a People page to a card", () => {
  const cards = [omarHaddad, omarLindqvist, leoMarsh, claraVoss];
  const none = { emails: [], phones: [] };

  it("is sure of an email or a phone in common", () => {
    const verdict = judge({ title: "Leo", aliases: [] }, handlesIn("Writes from leo@halcyon.example."), cards);
    expect(verdict).toMatchObject({ kind: "sure", person: { facts: { uid: "LEO" } } });
    const byPhone = judge({ title: "Omar", aliases: [] }, handlesIn("His number: 07700 900789"), cards);
    expect(byPhone).toMatchObject({ kind: "sure", person: { facts: { uid: "OMAR-H" } } });
  });

  it("is sure of a full name only one card has", () => {
    expect(judge({ title: "Clara Voss", aliases: [] }, none, cards)).toMatchObject({
      kind: "sure",
      person: { facts: { uid: "CLARA" } },
    });
  });

  it("asks when two could fit, or there's only a first name to go on", () => {
    const two = judge({ title: "Omar", aliases: [] }, none, cards);
    expect(two.kind === "unsure" && two.candidates.map(({ facts }) => facts.uid)).toEqual(["OMAR-H", "OMAR-L"]);
    const one = judge({ title: "Clara", aliases: [] }, none, cards);
    expect(one.kind === "unsure" && one.candidates.map(({ facts }) => facts.uid)).toEqual(["CLARA"]);
    expect(judge({ title: "Tilly", aliases: [] }, none, cards)).toEqual({ kind: "none" });
  });

  it("tells the candidates apart with what the card knows", () => {
    expect(hintOf(omarHaddad, ["Five-a-side"])).toBe("mobile · Edinburgh · in Five-a-side");
    expect(hintOf(omarLindqvist, [])).toBe("work · Halcyon");
  });
});

describe("circles in his order", () => {
  it("defaults to partner, friends, family, work, then others", () => {
    expect(readCircles(undefined)).toEqual(defaultCircles);
    expect(readCircles('["Family","Friends"]')).toEqual(["Family", "Friends", "Others"]);
    expect(circleOf("friend", defaultCircles)).toBe("Friends");
    expect(circleOf("recruiters", defaultCircles)).toBe("Others");
  });

  it("reorders, adds and renames, keeping Others", () => {
    const changed = changeCircles(defaultCircles, [
      { name: "Partner" },
      { name: "Family" },
      { name: "Friends" },
      { name: "Five-a-side" },
      { name: "Colleagues", was: "Work" },
      { name: "Others" },
    ]);
    expect(changed).toEqual(
      ok({
        order: ["Partner", "Family", "Friends", "Five-a-side", "Colleagues", "Others"],
        renames: [["Work", "Colleagues"]],
      }),
    );
    expect(changeCircles(defaultCircles, [{ name: "Partner" }]).ok).toBe(false);
    expect(changeCircles(defaultCircles, [{ name: "Friends" }, { name: "friend" }, { name: "Others" }]).ok).toBe(false);
    expect(changeCircles(defaultCircles, [{ name: "Everyone", was: "Others" }, { name: "Others" }]).ok).toBe(false);
  });
});

describe("evidence of time together", () => {
  it("finds them by whole names, and the line that names them", () => {
    const mentions = mentionOf(["Leo"]);
    expect(mentions("Dinner at Leo's.")).toBe(true);
    expect(mentions("Leonie came by.")).toBe(false);
    expect(sentenceWith("- A slow start. Run with Leo in the Meadows. Home by six.", mentions)).toBe(
      "Run with Leo in the Meadows.",
    );
  });

  it("takes the latest day, and an event over a chat on the same day", () => {
    const latest = latestOf([
      { day: "2026-11-20", kind: "chat" },
      { day: "2026-11-20", kind: "calendar", what: "Dinner" },
      { day: "2026-11-17", kind: "journal" },
    ]);
    expect(latest).toEqual({ day: "2026-11-20", kind: "calendar", what: "Dinner" });
    expect(
      togetherOf(
        [
          { day: "2026-11-20", kind: "calendar", hours: 2 },
          { day: "2026-11-20", kind: "journal" },
          { day: "2026-11-21", kind: "chat" },
          { day: "2026-07-01", kind: "journal" },
        ],
        "2026-08-26",
      ),
    ).toEqual({ days: 1, hours: 2 });
  });
});

describe("a card's photo", () => {
  it("reads inline photos and leaves linked ones", () => {
    expect(omarHaddad.photo?.mediaType).toBe("image/jpeg");
    const parsed = parseVCard(
      ["BEGIN:VCARD", "VERSION:4.0", "FN:Leo", "PHOTO;VALUE=uri:https://example.com/leo.jpg", "END:VCARD"].join("\r\n"),
    );
    expect(parsed.ok && photoOf(parsed.value)).toBeUndefined();
    expect(fiveASide.facts.members).toEqual(["OMAR-H"]);
  });
});

type Setup = {
  readonly people: PeopleKeeper;
  readonly files: () => ReadonlyMap<string, string>;
  readonly asked: () => readonly Question[];
};

const page = (title: string, circle: string, markdown: string, more: { contact?: string; links?: string[] } = {}) =>
  formatPage({
    title,
    circle,
    ...(more.contact !== undefined && { contact: more.contact }),
    aliases: [],
    links: more.links ?? [],
    markdown,
  });

const setUp = (cards: ContactCards): Setup => {
  const files = createCell<ReadonlyMap<string, string>>(
    new Map([
      [
        "people/omar.md",
        page("Omar", "friends", "Plays five-a-side on Tuesdays.", { links: ["memory:places/orrins"] }),
      ],
      ["people/leo.md", page("Leo", "friends", "Writes from leo@halcyon.example.")],
      ["people/tilly.md", page("Tilly", "friend", "Away until December.")],
      ["people/clara-voss.md", page("Clara Voss", "work", "Head of Product at Northwind.")],
      ["places/orrins.md", page("Orrin's", "", "The fig thing.")],
      ["journal/2026-11-20.md", page("Friday", "", "Orrin's with Omar. The best fig thing all month.")],
      ["journal/2026-11-17.md", page("Tuesday", "", "Five-a-side, then chips in the rain with Omar.")],
    ]),
  );
  const questions = createCell<readonly Question[]>([]);
  const settings = createCell<ReadonlyMap<string, string>>(new Map());
  const thread = {
    files: () => files.get().keys().toArray(),
    read: (file: string) => files.get().get(file),
  } as unknown as Thread;
  const people = createPeople({
    memory: {
      withThread: (work) => work(thread),
      sync: () => Promise.resolve(),
      setPersonFields: (address, fields) => {
        const file = `${address.replace("memory:", "")}.md`;
        const before = parsePage(files.get().get(file) ?? "", file);
        const after = formatPage({
          ...before,
          ...(fields.circle !== undefined && { circle: fields.circle }),
          ...(typeof fields.contact === "string" && { contact: fields.contact }),
        });
        files.update((all) => new Map([...all, [file, after]]));
        return Promise.resolve(ok("ch_1"));
      },
    },
    contacts: {
      cards: () => Promise.resolve(cards),
      card: (uid) => cards.people.find(({ facts }) => facts.uid === uid),
      groupsOf: (uid) => (fiveASide.facts.members?.includes(uid) === true ? ["Five-a-side"] : []),
      photo: (name) => cards.people.find((person) => person.photo?.name === name)?.photo,
      onRefreshed: ignore,
    },
    questions: {
      addContact: ({ track, understood, missing, why, contact }) => {
        const question: Question = {
          id: `q_${String(questions.get().length + 1)}`,
          track,
          state: "open",
          understood,
          missing,
          why,
          options: contact.candidates.map(({ uid }) => uid),
          asked_at: "2026-11-24T16:30:00.000Z",
          changed_at: "2026-11-24T16:30:00.000Z",
          kind: "contact",
          contact,
        };
        questions.update((all) => [...all, question]);
        return question;
      },
      contactQuestions: () => questions.get(),
      settleContact: ignore,
    },
    tracks: {
      ensure: (name) => ({
        id: "l_people",
        name,
        stage: "learning",
        since: "2026-11-24T16:30:00.000Z",
        confirmed: 0,
        corrected: 0,
        evidence: [],
      }),
    },
    store: {
      setting: (key) => settings.get().get(key),
      setSetting: (key, value) => {
        settings.update((all) => new Map([...all, [key, value]]));
      },
      messagesSince: () => [],
    },
    senders: { addressesOf: () => [] },
    calendar: { listItems: () => [], attendeesOf: () => [] },
    wakeUps: { list: () => [] },
    dayNotes: { since: () => [] },
    clock: createVirtualClock(now),
    timeZone: () => "UTC",
    info: ignore,
  });
  return { people, files: () => files.get(), asked: () => questions.get() };
};

describe("People", () => {
  const cards: ContactCards = { isReadable: true, people: [omarHaddad, omarLindqvist, leoMarsh, claraVoss] };

  it("links the sure ones, asks about the unsure and leaves the rest", async () => {
    const { people, files, asked } = setUp(cards);
    const linked = await people.link();
    expect(linked).toEqual(
      ok({
        linked: [
          { person: "clara-voss", name: "Clara Voss", card: "CLARA" },
          { person: "leo", name: "Leo", card: "LEO" },
        ],
        asked: [{ person: "omar", name: "Omar", question: "q_1" }],
        unmatched: ["tilly"],
      }),
    );
    expect(files().get("people/leo.md")).toContain("contact: LEO");
    const [question] = asked();
    expect(question).toMatchObject({
      missing: "Is this Omar from your contacts?",
      understood: "Mentioned 2 times: Orrin's.",
      options: ["OMAR-H", "OMAR-L"],
      contact: {
        person: "omar",
        name: "Omar",
        candidates: [
          { uid: "OMAR-H", name: "Omar Haddad", hint: "mobile · Edinburgh · in Five-a-side" },
          { uid: "OMAR-L", name: "Omar Lindqvist", hint: "work · Halcyon" },
        ],
      },
    });
    expect(await people.link()).toEqual(ok({ linked: [], asked: [], unmatched: [] }));
  });

  it("links the card they pick, and asks no more after Neither", async () => {
    const { people, files, asked } = setUp(cards);
    await people.link();
    const [question] = asked();
    if (!question) throw new Error("No question was asked.");
    const at = "2026-11-24T16:31:00.000Z";
    const neither = await people.answered({ ...question, state: "answered", answer: { at, none_fit: true } });
    expect(neither).toEqual(ok("Neither is Omar: I won't suggest Omar Haddad and Omar Lindqvist again."));
    expect(await people.link()).toEqual(ok({ linked: [], asked: [], unmatched: [] }));
    const picked = await people.answered({ ...question, state: "answered", answer: { at, picked: ["OMAR-H"] } });
    expect(picked).toEqual(ok("Omar is Omar Haddad in your contacts."));
    expect(files().get("people/omar.md")).toContain("contact: OMAR-H");
  });

  it("lists people by circle in his order, with evidence and what's coming up", async () => {
    const { people, asked } = setUp(cards);
    await people.link();
    const [question] = asked();
    if (!question) throw new Error("No question was asked.");
    await people.answered({ ...question, answer: { at: "2026-11-24T16:31:00.000Z", picked: ["OMAR-H"] } });
    const listed = await people.list();
    expect(listed.circles.map(({ name, people: inIt }) => [name, inIt.map(({ id }) => id)])).toEqual([
      ["Partner", []],
      ["Friends", ["omar", "leo", "tilly"]],
      ["Family", []],
      ["Work", ["clara-voss"]],
      ["Others", []],
    ]);
    const omar = listed.circles[1]?.people[0];
    expect(omar).toMatchObject({
      contact: "OMAR-H",
      last_seen: { day: "2026-11-20", kind: "journal" },
      coming_up: [{ kind: "birthday", day: "2027-01-09", title: "Birthday" }],
    });
    expect(listed).toMatchObject({ count: 4, linked: 3 });
    const detail = await people.person("omar");
    expect(detail).toMatchObject({
      page: "memory:people/omar",
      card: { uid: "OMAR-H", phones: [{ value: "+44 7700 900789", label: "mobile" }] },
      moments: [
        { day: "2026-11-20", text: "Orrin's with Omar.", from: "journal" },
        { day: "2026-11-17", text: "Five-a-side, then chips in the rain with Omar.", from: "journal" },
      ],
      places: [{ place: "memory:places/orrins", title: "Orrin's" }],
      together: { since: "2026-08-26", days: 2, hours: 0 },
    });
    expect(await people.person("nobody")).toBeUndefined();
    const known = await people.known();
    expect(known.find(({ id }) => id === "omar")).toMatchObject({ id: "omar", name: "Omar" });
    expect(known.find(({ id }) => id === "omar")?.names).toContain("Omar");
  });
});
