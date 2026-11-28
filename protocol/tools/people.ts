import { createHash } from "node:crypto";
import { createTranscript, type Transcript } from "./transcript.ts";

// People: Kumo's People pages linked to their cards in iCloud Contacts, and the People list and a person's page the
// app shows. Everyone here is made up.

const icloud = { apple_id: "divy@icloud.com", app_password: "abcd-efgh-ijkl-mnop" };

// A Contacts photo, as iCloud keeps it inline, and the name the server gives it: made from its bytes.
const miraPhoto = "/9j/4AAQSkZJRgABAQEAYABgAAD".repeat(6);
const omarPhoto = "/9j/4AAQSkZJRgABAgAAAQABAAD".repeat(6);
const claraPhoto = "/9j/4AAQSkZJRgABAQAAAQABAAD".repeat(6);
const photoName = (base64: string): string =>
  createHash("sha256").update(Buffer.from(base64, "base64")).digest("hex").slice(0, 24);

const uids = {
  mira: "A1F0C3E2-0106-4B7D-9E21-3C5A7D9E0001",
  leo: "B2E1D4F3-0105-4C8E-8F32-4D6B8E0F0002",
  omarHaddad: "C3D2E5A4-0105-4D9F-9A43-5E7C9F1A0003",
  omarLindqvist: "D4C3F6B5-0105-4EA0-8B54-6F8DA02B0004",
  clara: "E5B4A7C6-0105-4FB1-9C65-7A9EB13C0005",
  fiveASide: "F6A5B8D7-0105-40C2-8D76-8BAFC24D0006",
};

const vcard = (lines: readonly string[]): string =>
  ["BEGIN:VCARD", "VERSION:3.0", "PRODID:-//Apple Inc.//iPhone OS 26.1//EN", ...lines, "END:VCARD", ""].join("\r\n");

const cards = {
  mira: vcard([
    "N:Ellis;Mira;;;",
    "FN:Mira Ellis",
    "TEL;type=CELL;type=VOICE;type=pref:+44 7700 900111",
    "EMAIL;type=INTERNET;type=HOME:mira@ellis.example",
    "item1.ADR;type=HOME;type=pref:;;9 Larch Row;Edinburgh;;EH9 1AA;United Kingdom",
    "BDAY:1995-12-04",
    `PHOTO;ENCODING=b;TYPE=JPEG:${miraPhoto}`,
    `UID:${uids.mira}`,
  ]),
  leo: vcard([
    "N:Marsh;Leo;;;",
    "FN:Leo Marsh",
    "TEL;type=CELL;type=VOICE:+44 7700 900456",
    "EMAIL;type=INTERNET;type=HOME:leo@halcyon.example",
    "BDAY;X-APPLE-OMIT-YEAR=1604:1604-11-05",
    `UID:${uids.leo}`,
  ]),
  omarHaddad: vcard([
    "N:Haddad;Omar;;;",
    "FN:Omar Haddad",
    "TEL;type=CELL;type=VOICE:+44 7700 900789",
    "item1.ADR;type=HOME:;;4 Rowan Close;Edinburgh;;EH11 2AA;United Kingdom",
    "BDAY:1993-01-09",
    `PHOTO;ENCODING=b;TYPE=JPEG:${omarPhoto}`,
    `UID:${uids.omarHaddad}`,
  ]),
  omarLindqvist: vcard([
    "N:Lindqvist;Omar;;;",
    "FN:Omar Lindqvist",
    "ORG:Halcyon;",
    "EMAIL;type=INTERNET;type=WORK:omar.lindqvist@halcyon.example",
    `UID:${uids.omarLindqvist}`,
  ]),
  clara: vcard([
    "N:Voss;Clara;;;",
    "FN:Clara Voss",
    "ORG:Northwind;",
    "TITLE:Head of Product",
    "EMAIL;type=INTERNET;type=WORK;type=pref:clara.voss@northwind.example",
    "BDAY;X-APPLE-OMIT-YEAR=1604:1604-04-12",
    `PHOTO;ENCODING=b;TYPE=JPEG:${claraPhoto}`,
    `UID:${uids.clara}`,
  ]),
  fiveASide: vcard([
    "N:Five-a-side;;;;",
    "FN:Five-a-side",
    "X-ADDRESSBOOKSERVER-KIND:group",
    `X-ADDRESSBOOKSERVER-MEMBER:urn:uuid:${uids.omarHaddad}`,
    `UID:${uids.fiveASide}`,
  ]),
};

const held = (names: readonly (keyof typeof cards)[]) => ({
  cards: names.map((name) => ({ file: `${uids[name]}.vcf`, vcard: cards[name] })),
});

type Seeded = {
  readonly address: string;
  readonly title: string;
  readonly gist: string;
  readonly circle?: string;
  readonly contact?: string;
  readonly aliases: readonly string[];
  readonly links: readonly string[];
  readonly markdown: string;
  readonly note: string;
};

const person = (
  id: string,
  title: string,
  circle: string,
  gist: string,
  markdown: string,
  more: { readonly contact?: string; readonly links?: readonly string[] } = {},
): Seeded => ({
  address: `memory:people/${id}`,
  title,
  gist,
  circle,
  ...(more.contact !== undefined && { contact: more.contact }),
  aliases: [],
  links: more.links ?? [],
  markdown,
  note: `About ${title}`,
});

const fiveASidePage: Seeded = {
  address: "memory:groups/five-a-side",
  title: "Five-a-side",
  gist: "Tuesday football in Dalry",
  aliases: [],
  links: ["memory:people/omar", "memory:people/leo"],
  markdown: "Five-a-side on Tuesday evenings in Dalry, with Omar and Leo.\n",
  note: "Five-a-side",
};

const orrinsPage: Seeded = {
  address: "memory:places/orrins",
  title: "Orrin's",
  gist: "The restaurant with the fig thing",
  aliases: [],
  links: ["memory:people/omar"],
  markdown: "A small place in Bruntsfield. Omar always orders the fig thing.\n",
  note: "Orrin's",
};

const day = (date: string, title: string, gist: string, markdown: string): Seeded => ({
  address: `memory:journal/${date}`,
  title,
  gist,
  aliases: [],
  links: [],
  markdown,
  note: gist,
});

const tuesday = day(
  "2026-11-24",
  "24 November 2026",
  "Five-a-side in the rain",
  "### 22:10\n\nFive-a-side, then chips in the rain with Omar.\n",
);
const friday = day(
  "2026-11-27",
  "27 November 2026",
  "Orrin's",
  "### 23:05\n\nOrrin's with Omar. The best fig thing all month.\n",
);
const august = day(
  "2026-08-14",
  "14 August 2026",
  "Tilly's leaving drinks",
  "### 23:40\n\nTilly's leaving drinks, before her year away.\n",
);

const linkingTranscript = (): Transcript => {
  const transcript = createTranscript({
    name: "105-linking-your-people",
    scenario: 105,
    title: "Linking your people",
    summary:
      "Kumo links its People pages to their cards in iCloud Contacts. Leo's page has the email his card has, and " +
      "only one card is Clara Voss, so both are linked on their own, with nothing in Contacts changed. Two cards " +
      "could be Omar, so Kumo asks in Understanding you, with each card's photo and what tells it apart from " +
      "Contacts alone. You tap Omar Haddad: his page is linked, and Kumo asks nothing more. No card fits Tilly, " +
      "so she's left as she is.",
    guarantees: ["G63", "G70"],
  });
  transcript.begin("2026-11-28T09:00:00.000Z");
  transcript.world("memory_holds", {
    pages: [
      person(
        "leo",
        "Leo",
        "friends",
        "A friend who runs",
        "Runs with you on Thursdays. Writes from leo@halcyon.example.\n",
      ),
      person("clara-voss", "Clara Voss", "work", "Head of Product at Northwind", "Leads product at Northwind.\n"),
      person("omar", "Omar", "friends", "A friend from five-a-side", "Plays five-a-side on Tuesdays. Vegetarian.\n", {
        links: [fiveASidePage.address, orrinsPage.address],
      }),
      person("tilly", "Tilly", "friends", "A friend, away for a year", "Away for a year from August.\n"),
      fiveASidePage,
      orrinsPage,
      tuesday,
      friday,
    ],
  });
  transcript.world("contacts_hold", held(["leo", "clara", "omarHaddad", "omarLindqvist", "fiveASide"]));
  transcript.world("capability_on", { capability: "icloud", values: icloud });
  transcript.connect();
  transcript.wait(2000);
  const track = transcript.track();
  const question = transcript.questionId();
  transcript.world("agent_calls", {
    tool: "contacts_link",
    input: {},
    returns: {
      linked: [
        { person: "clara-voss", name: "Clara Voss", card: uids.clara },
        { person: "leo", name: "Leo", card: uids.leo },
      ],
      asked: [{ person: "omar", name: "Omar", question }],
      unmatched: ["tilly"],
    },
  });
  const askedAt = "2026-11-28T09:00:02.000Z";
  const open = {
    id: question,
    track,
    state: "open",
    understood: "Mentioned 2 times: Five-a-side, Orrin's.",
    missing: "Is this Omar from your contacts?",
    why: "So Omar's page shows their photo, birthday and how to reach them.",
    options: [uids.omarHaddad, uids.omarLindqvist],
    asked_at: askedAt,
    changed_at: askedAt,
    kind: "contact",
    contact: {
      person: "omar",
      name: "Omar",
      candidates: [
        {
          uid: uids.omarHaddad,
          name: "Omar Haddad",
          hint: "mobile · Edinburgh · in Five-a-side",
          photo: photoName(omarPhoto),
        },
        { uid: uids.omarLindqvist, name: "Omar Lindqvist", hint: "work · Halcyon" },
      ],
    },
  };
  transcript.question(open);
  const yourPeople = {
    id: track,
    name: "Your people",
    stage: "learning",
    since: askedAt,
    note: "Who's who in your contacts, and who matters to you.",
    confirmed: 0,
    corrected: 0,
    evidence: [] as readonly Readonly<Record<string, unknown>>[],
  };
  transcript.wait(30_000);
  transcript.getUnderstanding({ tracks: [yourPeople], questions: [open], recent: [] });
  transcript.wait(8000);
  const reply = { picked: [uids.omarHaddad] };
  transcript.request("POST", `/v0/understanding/questions/${question}/answer`, { body: reply });
  const answeredAt = "2026-11-28T09:00:40.000Z";
  const answered = { ...open, state: "answered", changed_at: answeredAt, answer: { at: answeredAt, ...reply } };
  transcript.question(answered);
  const filed = { ...answered, filed: "Omar is Omar Haddad in your contacts." };
  transcript.question(filed);
  transcript.wait(60);
  transcript.response(202, { question: answered });
  transcript.wait(5000);
  const evidence = {
    at: answeredAt,
    kind: "answered",
    text: "You answered “Is this Omar from your contacts?”: Omar Haddad",
    question,
  };
  transcript.getUnderstanding({ tracks: [{ ...yourPeople, evidence: [evidence] }], questions: [], recent: [filed] });
  return transcript;
};

const peopleTranscript = (): Transcript => {
  const transcript = createTranscript({
    name: "106-your-people",
    scenario: 106,
    title: "Your people",
    summary:
      "People shows everyone Kumo keeps a page on, by circle in your order: Mira, then your friends, then work, " +
      "then Others. Each has their Contacts photo, when you last saw them, from the calendar and your journal, " +
      "and what's coming up: Mira's birthday, tonight's run with Leo. Omar's page brings his card's facts for " +
      "the one-tap actions, what Kumo knows, your moments together from the journal and the places you share. " +
      "You move Family above Friends and add Five-a-side, and the circles follow.",
    guarantees: ["G70"],
  });
  transcript.begin("2026-11-28T16:30:00.000Z");
  const dinner = {
    uid: "mira-dinner-1127@icloud.example",
    title: "Dinner with Mira",
    start: "2026-11-27T19:00:00.000Z",
    end: "2026-11-27T21:00:00.000Z",
  };
  const run = {
    uid: "run-leo-1128@icloud.example",
    title: "Run with Leo",
    start: "2026-11-28T18:00:00.000Z",
    end: "2026-11-28T19:00:00.000Z",
    location: "The Meadows",
  };
  transcript.world("memory_holds", {
    pages: [
      person(
        "mira",
        "Mira",
        "partner",
        "Your partner",
        "You've been together since 2022. She's training for a 10K.\n",
        {
          contact: uids.mira,
        },
      ),
      person("leo", "Leo", "friends", "A friend who runs", "Runs with you on Thursdays, and Saturdays lately.\n", {
        contact: uids.leo,
      }),
      person(
        "omar",
        "Omar",
        "friends",
        "A friend from five-a-side",
        "- Plays five-a-side in Dalry on Tuesdays.\n- Vegetarian. Always orders the fig thing.\n" +
          "- Wants to come to Lisbon if work lets him.\n",
        { contact: uids.omarHaddad, links: [fiveASidePage.address, orrinsPage.address] },
      ),
      person("tilly", "Tilly", "friends", "A friend, away for a year", "Away for a year from August.\n"),
      person("clara-voss", "Clara Voss", "work", "Head of Product at Northwind", "Leads product at Northwind.\n", {
        contact: uids.clara,
      }),
      person("sam", "Sam", "recruiters", "The recruiter at Halcyon", "Recruits for Halcyon's platform team.\n"),
      fiveASidePage,
      orrinsPage,
      august,
      tuesday,
      friday,
    ],
  });
  transcript.world("contacts_hold", held(["mira", "leo", "omarHaddad", "clara", "fiveASide"]));
  transcript.world("calendar_has", { events: [dinner, run] });
  transcript.world("capability_on", { capability: "icloud", values: icloud });
  // Read once more, so the calendar Kumo first saw is all read before the app connects.
  transcript.world("calendar_has", { events: [dinner, run] });
  const runItem = transcript.calendarItem({
    ...run,
    all_day: false,
    calendar: { name: "Home", kumo: false },
    status: "confirmed",
  });
  transcript.comingUp([runItem]);
  transcript.connect();
  transcript.wait(3000);

  const summaries = {
    mira: {
      id: "mira",
      name: "Mira",
      gist: "Your partner",
      circle: "Partner",
      contact: uids.mira,
      photo: photoName(miraPhoto),
      last_seen: { day: "2026-11-27", kind: "calendar", at: dinner.start, what: dinner.title },
      coming_up: [{ kind: "birthday", day: "2026-12-04", title: "Birthday" }],
    },
    omar: {
      id: "omar",
      name: "Omar",
      gist: "A friend from five-a-side",
      circle: "Friends",
      contact: uids.omarHaddad,
      photo: photoName(omarPhoto),
      last_seen: { day: "2026-11-27", kind: "journal" },
      coming_up: [{ kind: "birthday", day: "2027-01-09", title: "Birthday" }],
    },
    leo: {
      id: "leo",
      name: "Leo",
      gist: "A friend who runs",
      circle: "Friends",
      contact: uids.leo,
      coming_up: [
        { kind: "event", day: "2026-11-28", at: run.start, title: run.title, event: run.uid },
        { kind: "birthday", day: "2027-11-05", title: "Birthday" },
      ],
    },
    tilly: {
      id: "tilly",
      name: "Tilly",
      gist: "A friend, away for a year",
      circle: "Friends",
      last_seen: { day: "2026-08-14", kind: "journal" },
      coming_up: [],
    },
    clara: {
      id: "clara-voss",
      name: "Clara Voss",
      gist: "Head of Product at Northwind",
      circle: "Work",
      contact: uids.clara,
      photo: photoName(claraPhoto),
      coming_up: [{ kind: "birthday", day: "2027-04-12", title: "Birthday" }],
    },
    sam: { id: "sam", name: "Sam", gist: "The recruiter at Halcyon", circle: "Others", coming_up: [] },
  };
  transcript.request("GET", "/v0/people");
  transcript.wait(80);
  transcript.response(200, {
    circles: [
      { name: "Partner", people: [summaries.mira] },
      { name: "Friends", people: [summaries.omar, summaries.tilly, summaries.leo] },
      { name: "Family", people: [] },
      { name: "Work", people: [summaries.clara] },
      { name: "Others", others: true, people: [summaries.sam] },
    ],
    count: 6,
    linked: 4,
  });

  transcript.wait(4000);
  transcript.request("GET", "/v0/people/omar");
  transcript.wait(60);
  transcript.response(200, {
    person: summaries.omar,
    page: "memory:people/omar",
    card: {
      uid: uids.omarHaddad,
      name: "Omar Haddad",
      phones: [{ value: "+44 7700 900789", label: "mobile" }],
      emails: [],
      addresses: [
        {
          label: "home",
          street: "4 Rowan Close",
          city: "Edinburgh",
          region: "",
          postcode: "EH11 2AA",
          country: "United Kingdom",
        },
      ],
      birthday: { month: 1, day: 9, year: 1993 },
      photo: photoName(omarPhoto),
    },
    markdown:
      "- Plays five-a-side in Dalry on Tuesdays.\n- Vegetarian. Always orders the fig thing.\n" +
      "- Wants to come to Lisbon if work lets him.\n",
    moments: [
      { day: "2026-11-27", text: "Orrin's with Omar.", from: "journal", page: friday.address },
      {
        day: "2026-11-24",
        text: "Five-a-side, then chips in the rain with Omar.",
        from: "journal",
        page: tuesday.address,
      },
    ],
    places: [{ place: orrinsPage.address, title: "Orrin's" }],
    together: { since: "2026-08-30", days: 2, hours: 0 },
  });

  transcript.wait(6000);
  const order = [
    { name: "Partner" },
    { name: "Family" },
    { name: "Friends" },
    { name: "Five-a-side" },
    { name: "Work" },
    { name: "Others" },
  ];
  transcript.request("PUT", "/v0/people/circles", { body: { circles: order } });
  transcript.wait(60);
  transcript.response(200, {
    circles: [
      { name: "Partner", count: 1 },
      { name: "Family", count: 0 },
      { name: "Friends", count: 3 },
      { name: "Five-a-side", count: 0 },
      { name: "Work", count: 1 },
      { name: "Others", count: 1, others: true },
    ],
  });
  return transcript;
};

export const peopleScenarios: readonly (() => Transcript)[] = [linkingTranscript, peopleTranscript];
