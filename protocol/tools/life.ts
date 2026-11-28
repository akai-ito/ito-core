import { orrins } from "./places-data.ts";
import { createTranscript, type Transcript } from "./transcript.ts";

// Life: the search on top, with Kumo's answer first; the days of a week and a month with Kumo's lines; Going on,
// joining things in motion with projects and goals; and what Kumo knows about you. Everyone here is made up.

type Seeded = {
  readonly address: string;
  readonly title: string;
  readonly gist?: string;
  readonly circle?: string;
  readonly began?: string;
  readonly aliases: readonly string[];
  readonly links: readonly string[];
  readonly markdown: string;
  readonly note: string;
};

const page = (address: string, title: string, gist: string, markdown: string, more: Partial<Seeded> = {}): Seeded => ({
  address,
  title,
  ...(gist !== "" && { gist }),
  aliases: [],
  links: [],
  markdown,
  note: title,
  ...more,
});

const day = (date: string, title: string, gist: string, markdown: string): Seeded =>
  page(`memory:journal/${date}`, title, gist, markdown, { note: `Journal for ${title}` });

const omar = page(
  "memory:people/omar",
  "Omar",
  "A friend from five-a-side",
  "- Plays five-a-side in Dalry on Tuesdays.\n- Vegetarian. Always orders the fig thing.\n",
  { circle: "friends", note: "About Omar" },
);

const searchTranscript = (): Transcript => {
  const transcript = createTranscript({
    name: "107-searching-your-life",
    scenario: 107,
    title: "Searching your life",
    summary:
      "You search Life for “dinner with Omar”. Kumo answers first, from what memory's search found: Orrin's, last " +
      "Friday, and what you wrote about the fig thing. Under it come the days (Friday, and a dinner in October), " +
      "Orrin's, known from Friday's photos, and Omar, with when you last saw him. You search again and the answer " +
      "comes as it was, kept, with no new call to the model.",
    guarantees: ["G71"],
  });
  transcript.begin("2026-11-24T16:30:00.000Z");
  transcript.world("memory_holds", {
    pages: [
      omar,
      day(
        "2026-11-20",
        "20 November 2026",
        "Orrin's with Omar, and the fig thing",
        "### 22:40\n\nDinner at Orrin's with Omar. The fig thing was the best I'd had all month.\n",
      ),
      day(
        "2026-10-03",
        "3 October 2026",
        "Orrin's for the first time, with Leo and Omar",
        "### 23:10\n\nFirst dinner at Orrin's, with Leo and Omar. Leo talked about Lisbon all evening.\n",
      ),
    ],
  });
  transcript.connect();
  transcript.wait(2000);
  // Photos from dinner at Orrin's on Friday, seeding the place. The app names a photo's ~11 km area from its
  // centre, so the box keeps only the town and country: the place stays unnamed until he names it.
  const orrinsPlace = transcript.placeId();
  const where = {
    name: "Orrin's",
    street: "31 Broughton Street",
    locality: "Edinburgh",
    country: "United Kingdom",
    country_code: "GB",
  };
  const photos = {
    batch: "photos-2026-0107",
    time_zone: "Europe/London",
    photos: [
      { taken_at: "2026-11-20T19:55:00.000Z", ...orrins, placemark: where },
      { taken_at: "2026-11-20T21:30:00.000Z", ...orrins, placemark: where },
    ],
  };
  transcript.request("POST", "/v0/location/photos", { body: photos });
  transcript.wait(30);
  transcript.response(200, { batch: photos.batch, repeated: false, taken: 2, already: 0 });
  transcript.wait(2000);
  const answer = "Orrin's, last Friday, with Omar. You wrote that the fig thing was the best you'd had all month.";
  transcript.world("life_written", { answer });
  const path = "/v0/life/search?query=dinner%20with%20Omar";
  const found = {
    query: "dinner with Omar",
    answer,
    days: [
      {
        day: "2026-11-20",
        gist: "Orrin's with Omar, and the fig thing",
        journal: "memory:journal/2026-11-20",
        excerpt: "Dinner at Orrin's with Omar. The fig thing was the best I'd had all month.",
        thread: {
          day: "2026-11-20",
          items: [
            {
              kind: "stop",
              place: orrinsPlace,
              place_kind: "unknown",
              latitude: orrins.latitude,
              longitude: orrins.longitude,
              arrived_at: "2026-11-20T19:55:00.000Z",
              departed_at: "2026-11-20T21:30:00.000Z",
              minutes: 95,
            },
          ],
          from_photos: true,
        },
      },
      {
        day: "2026-10-03",
        gist: "Orrin's for the first time, with Leo and Omar",
        journal: "memory:journal/2026-10-03",
        excerpt: "First dinner at Orrin's, with Leo and Omar. Leo talked about Lisbon all evening.",
      },
    ],
    places: [
      {
        id: orrinsPlace,
        kind: "unknown",
        latitude: orrins.latitude,
        longitude: orrins.longitude,
        radius: 0,
        hours: 1.6,
        visits: 1,
        first_visit: "2026-11-20T19:55:00.000Z",
        last_visit: "2026-11-20T19:55:00.000Z",
        locality: where.locality,
        country: where.country,
        country_code: where.country_code,
        from_photos: true,
      },
    ],
    people: [
      {
        id: "omar",
        name: "Omar",
        gist: "A friend from five-a-side",
        circle: "Friends",
        last_seen: { day: "2026-11-20", kind: "journal" },
        coming_up: [],
      },
    ],
    going_on: [],
    made: [],
    messages: [],
  };
  transcript.request("GET", path);
  transcript.wait(900);
  transcript.response(200, found);
  transcript.wait(20_000);
  transcript.request("GET", path);
  transcript.wait(60);
  transcript.response(200, found);
  return transcript;
};

const daysTranscript = (): Transcript => {
  const transcript = createTranscript({
    name: "108-your-week-and-month",
    scenario: 108,
    title: "Your week and month",
    summary:
      "On a Tuesday, the Week sheet asks for its days: today with the note Kumo kept this morning, yesterday with " +
      "its journal line, the chapter you're in as a span, and Kumo's line for the week. The Month sheet asks for " +
      "November: every day so far, its weeks from Monday to Sunday, newest first, each with Kumo's line where its " +
      "days say something, and the month's line.",
    guarantees: ["G71"],
  });
  transcript.begin("2026-11-24T16:30:00.000Z");
  const chapter = page(
    "memory:chapters/the-northwind-autumn",
    "The Northwind autumn",
    "Interviewing at Northwind, from the first call to the final",
    "From the first call with Clara Voss in October to today's final.\n",
    { began: "2026-10-05", note: "The Northwind autumn" },
  );
  transcript.world("memory_holds", {
    pages: [
      chapter,
      day(
        "2026-11-23",
        "23 November 2026",
        "The office, the gym, an early night",
        "### 22:00\n\nA long day at the office, then the gym. In bed by ten.\n",
      ),
      day(
        "2026-11-22",
        "22 November 2026",
        "A short run, then nothing at all",
        "### 21:30\n\nA short run by the canal, then a whole day of nothing.\n",
      ),
      day(
        "2026-11-18",
        "18 November 2026",
        "Up the hill with Mira",
        "### 20:15\n\nUp the hill with Mira before work.\n",
      ),
    ],
  });
  transcript.world("agent_calls", { tool: "note_day", input: { text: "At the café before the Northwind final." } });
  transcript.connect();
  transcript.wait(3000);
  const chapters = [
    {
      address: chapter.address,
      title: chapter.title,
      gist: chapter.gist ?? "",
      began: "2026-10-05",
      changed_at: "2026-11-24T16:30:00.000Z",
    },
  ];
  const weekLine = "The office and the gym, mostly. A short run on Sunday, then nothing at all.";
  transcript.world("life_written", { line: weekLine, weeks: [] });
  transcript.request("GET", "/v0/life/days?from=2026-11-23&to=2026-11-29");
  transcript.wait(700);
  const monday = {
    day: "2026-11-23",
    gist: "The office, the gym, an early night",
    journal: "memory:journal/2026-11-23",
  };
  transcript.response(200, {
    from: "2026-11-23",
    to: "2026-11-29",
    line: weekLine,
    days: [{ day: "2026-11-24", notes: 1 }, monday],
    chapters,
    trips: [],
  });
  transcript.wait(6000);
  const monthLine = "The office, the gym and a run or two. Up the hill with Mira.";
  transcript.world("life_written", {
    line: monthLine,
    weeks: [
      { from: "2026-11-23", line: "The office and the gym, before the final." },
      { from: "2026-11-16", line: "Up the hill with Mira, a quiet Sunday." },
    ],
  });
  transcript.request("GET", "/v0/life/days?from=2026-11-01&to=2026-11-30");
  transcript.wait(800);
  const gists: Readonly<Record<string, typeof monday>> = {
    "2026-11-23": monday,
    "2026-11-22": {
      day: "2026-11-22",
      gist: "A short run, then nothing at all",
      journal: "memory:journal/2026-11-22",
    },
    "2026-11-18": { day: "2026-11-18", gist: "Up the hill with Mira", journal: "memory:journal/2026-11-18" },
  };
  const november = Array.from({ length: 24 }, (_, index) => `2026-11-${String(24 - index).padStart(2, "0")}`).map(
    (date) => (date === "2026-11-24" ? { day: date, notes: 1 } : (gists[date] ?? { day: date })),
  );
  transcript.response(200, {
    from: "2026-11-01",
    to: "2026-11-30",
    line: monthLine,
    days: november,
    weeks: [
      { from: "2026-11-23", to: "2026-11-24", line: "The office and the gym, before the final." },
      { from: "2026-11-16", to: "2026-11-22", line: "Up the hill with Mira, a quiet Sunday." },
      { from: "2026-11-09", to: "2026-11-15" },
      { from: "2026-11-02", to: "2026-11-08" },
      { from: "2026-11-01", to: "2026-11-01" },
    ],
    chapters,
    trips: [],
  });
  return transcript;
};

const goingOnTranscript = (): Transcript => {
  const transcript = createTranscript({
    name: "109-going-on-and-what-kumo-knows",
    scenario: 109,
    title: "Going on, and what Kumo knows",
    summary:
      "Going on joins Kumo's things in motion with its project and goal pages: Northwind is a matter; the spare " +
      "room is one thread with its project page, which names it, with its steps; Spring 10k is a goal page alone. " +
      "Tapping Kumo on the Desk opens what Kumo knows about you: the Portrait and How to help you, short, your " +
      "tastes from the topic pages, each naming its page, and Getting to know you.",
    guarantees: ["G72", "G71"],
  });
  transcript.begin("2026-11-24T16:30:00.000Z");
  transcript.world("memory_holds", {
    pages: [
      page(
        "memory:projects/spare-room",
        "The spare room",
        "Shelves up. The desk comes on Thursday.",
        "Turning the spare room into a study (motion:spare-room). The desk comes on Thursday.\n",
      ),
      page(
        "memory:goals/spring-10k",
        "Spring 10k",
        "Three runs a week. Tonight's is with Leo.",
        "The Riverside 10K on 14 March, under 50 minutes. Three runs a week.\n",
      ),
      page(
        "memory:portrait",
        "Portrait",
        "",
        "You plan in bursts, then want it all to just happen. You run to think and cook to unwind, and you'd " +
          "take one long dinner over three quick drinks.\n",
      ),
      page(
        "memory:helping-you",
        "How to help you",
        "",
        "## Talking\n\nShort and straight. Reasons when you ask.\n\n## Mail\n\nDrafts only: you press send.\n",
      ),
      page("memory:topics/food", "Food", "Figs, and spicy but not hot", "You love figs. Spicy, never hot.\n"),
      page(
        "memory:topics/travel",
        "Travel",
        "Window seats, long walks",
        "Always a window seat. Long walks in a new city.\n",
      ),
    ],
  });
  transcript.world("agent_calls", {
    tool: "start_motion",
    input: {
      id: "northwind",
      kind: "career",
      title: "Northwind",
      summary: "Final today",
      salience: "loud",
      content: {
        org: "Northwind",
        role: "Product engineer",
        stage: "interviewing",
        stages: { interviewing: "2026-11-24" },
      },
      note: "The final round",
    },
  });
  transcript.motion(
    "started",
    {
      id: "northwind",
      kind: "career",
      title: "Northwind",
      summary: "Final today",
      status: "active",
      pinned: true,
      salience: "loud",
      version: 1,
    },
    "The final round",
  );
  transcript.world("agent_calls", {
    tool: "start_motion",
    input: {
      id: "spare-room",
      kind: "project",
      title: "The spare room",
      summary: "1 of 3 done",
      salience: "normal",
      content: {
        aim: "A study in the spare room",
        parts: [
          { id: "shelves", title: "Shelves up", status: "done" },
          { id: "desk", title: "The desk", status: "doing" },
          { id: "rug", title: "A rug", status: "planned" },
        ],
        next: { text: "The desk arrives", at: "2026-11-26T10:00" },
      },
      note: "Started the spare room",
    },
  });
  transcript.motion(
    "started",
    {
      id: "spare-room",
      kind: "project",
      title: "The spare room",
      summary: "1 of 3 done",
      status: "active",
      pinned: true,
      salience: "normal",
      version: 1,
    },
    "Started the spare room",
  );
  transcript.connect();
  transcript.wait(3000);
  transcript.request("GET", "/v0/life/going-on");
  transcript.wait(80);
  transcript.response(200, {
    threads: [
      {
        id: "motion:northwind",
        group: "matters",
        title: "Northwind",
        status: "Final today",
        began: "2026-11-24",
        marks: [{ at: "2026-11-24T16:30:00.000Z", note: "The final round" }],
        working: false,
        motion: "northwind",
        kind: "career",
        salience: "loud",
      },
      {
        id: "motion:spare-room",
        group: "projects",
        title: "The spare room",
        status: "1 of 3 done",
        line: "Shelves up. The desk comes on Thursday.",
        began: "2026-11-24",
        marks: [
          { at: "2026-11-24T16:30:00.000Z", note: "Started the spare room" },
          { at: "2026-11-24T16:30:00.000Z", note: "The spare room" },
        ],
        steps: [
          { title: "Shelves up", status: "done" },
          { title: "The desk", status: "doing" },
          { title: "A rug", status: "planned" },
        ],
        next: { text: "The desk arrives", at: "2026-11-26T10:00" },
        working: false,
        motion: "spare-room",
        kind: "project",
        salience: "normal",
        page: "memory:projects/spare-room",
      },
      {
        id: "memory:goals/spring-10k",
        group: "goals",
        title: "Spring 10k",
        line: "Three runs a week. Tonight's is with Leo.",
        began: "2026-11-24",
        marks: [{ at: "2026-11-24T16:30:00.000Z", note: "Spring 10k" }],
        working: false,
        page: "memory:goals/spring-10k",
      },
    ],
  });
  transcript.wait(5000);
  const portrait = "You plan in bursts, then want it all to just happen. You run to think and cook to unwind.";
  transcript.world("life_written", {
    portrait,
    helping: ["Short and straight.", "Reasons when you ask.", "Drafts only. You press send."],
    tastes: [
      { taste: "Figs", page: "memory:topics/food" },
      { taste: "Spicy, not hot", page: "memory:topics/food" },
      { taste: "Window seats", page: "memory:topics/travel" },
      { taste: "Long walks", page: "memory:topics/travel" },
    ],
  });
  transcript.request("GET", "/v0/life/about-you");
  transcript.wait(900);
  transcript.response(200, {
    portrait: { text: portrait, address: "memory:portrait" },
    helping: {
      lines: ["Short and straight.", "Reasons when you ask.", "Drafts only. You press send."],
      address: "memory:helping-you",
    },
    tastes: [
      { text: "Figs", address: "memory:topics/food" },
      { text: "Spicy, not hot", address: "memory:topics/food" },
      { text: "Window seats", address: "memory:topics/travel" },
      { text: "Long walks", address: "memory:topics/travel" },
    ],
    learnt: [],
    tracks: [],
    to_ask: 0,
  });
  return transcript;
};

export const lifeScenarios: readonly (() => Transcript)[] = [searchTranscript, daysTranscript, goingOnTranscript];
