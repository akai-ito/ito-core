import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Error as ErrorBody } from "#protocol/types.ts";
import { loadSpec } from "./spec.ts";
import { transcriptDirectory } from "./transcript-files.ts";
import { demoModels } from "#engine/scripted/models.ts";
import { defaultVoice, voices } from "#voice/voices.ts";
import { florenceId, florencePictures, florenceTrip, type FlorencePictures } from "./florence.ts";
import { sub20Id, sub20Training } from "./sub20.ts";
import { createTranscript, type Transcript } from "./transcript.ts";

const protocol = "0.20";
const serverVersion = "0.20.0";
const yesterdayAt = "2026-10-11T21:14:00.000Z";
const todayAt = "2026-10-12T08:41:00.000Z";
const authorization = "Bearer ito_example_not_a_real_token_00000000000000000000";

const bikeQuestion = "Is it worth fixing the old bike or buying a new one?";
const bikeAnswer =
  "Fix it. The frame is sound; new brakes and a chain come to about £90, against roughly £600 " +
  "for a comparable new bike. If the gears still slip after that, revisit.";
const saturdayQuestion = "Plan my Saturday: long run in the morning, then something calm.";
const saturdayAnswer = [
  "Here's a shape for Saturday:",
  "",
  "- **07:30** Long run, 18 km along the river; flat, and the café opens at 9.",
  "- **10:00** Breakfast, then a slow hour with your book.",
  "- **13:00** Lunch at home; keep it light before the afternoon.",
  "- **15:00** A walk in the botanic garden, phone in your pocket.",
  "",
  "Early night: you're up at 7.",
].join("\n");

const upTo = (text: string, marker: string): string => {
  const index = text.indexOf(marker);
  if (index === -1) throw new Error(`marker not found: ${marker}`);
  return text.slice(0, index + marker.length);
};

const saturdayAnswerAfter = (prefix: string): string => {
  if (!saturdayAnswer.startsWith(prefix)) throw new Error("not a prefix");
  return saturdayAnswer.slice(prefix.length);
};

const yesterday = (transcript: Transcript): void => {
  transcript.time(yesterdayAt);
  transcript.exchange(bikeQuestion, bikeAnswer);
};

const sendAndStart = (transcript: Transcript, text: string): { readonly user: string; readonly turn: string } => {
  const user = transcript.send(text);
  const turn = transcript.startTurn([user]);
  return { user, turn };
};

const thinking = { title: "Thinking it through", endedTitle: "Thought it through" } as const;

const searching = (query: string) => ({
  title: `Searching the web for ${query}`,
  endedTitle: `Searched the web for ${query}`,
  fields: { query },
});

const tidying = { title: "Tidying up its notes", endedTitle: "Tidied up its notes" } as const;

const heading = (transcript: Transcript, title: string, summary: string): void => {
  transcript.updateStep({ heading: title, summary: `**${title}**\n\n${summary}` }, { detail: title });
};

const packingPlan = (states: readonly string[]): readonly Readonly<Record<string, string>>[] =>
  ["Read the packing list", "Check Saturday's forecast", "Update the list"].map((text, index) => ({
    text,
    state: states[index] ?? "pending",
  }));

const writeWhole = (transcript: Transcript, text: string, pieces?: number): void => {
  transcript.status("writing", "Writing");
  transcript.reply();
  transcript.write(text, { pieces });
  transcript.endMessage("completed");
};

const firstAttachment = (transcript: Transcript): string => {
  const found = transcript
    .lines()
    .flatMap((line) => {
      const event = (line.given ?? line.event) as
        { readonly message?: { readonly attachments?: readonly { readonly id: string }[] } } | undefined;
      return event?.message?.attachments ?? [];
    })
    .at(0);
  if (!found) throw new Error("no attachment in the history");
  return found.id;
};

const junoOptions = [
  { label: "Clapham", description: "Abbeville Road, SW4" },
  { label: "Soho", description: "Greek Street, W1" },
];

const askWhichJuno = (transcript: Transcript): string => {
  transcript.step("web_search", searching("Juno restaurant London"));
  transcript.wait(1100);
  return transcript.ask({ question: "Which Juno did you mean?", options: junoOptions });
};

const booking = (operation: string, fields: Readonly<Record<string, unknown>>) => ({
  title: "Using booking",
  endedTitle: "Used booking",
  fields: { capability: "booking", operation, arguments: fields },
});

const addToCalendar = (fields: Readonly<Record<string, unknown>>) => ({
  title: "Using calendar",
  endedTitle: "Used calendar",
  fields: { capability: "calendar", operation: "create_event", arguments: fields },
});

const calendarApproval = {
  question: "Allow Google Calendar to create an event?",
  preview: "title: Call Mum\nstart: Sunday 1 November, 2pm",
  options: [{ label: "Allow", acts: true as const }, { label: "Don't" }],
};

const reportsTokenField = {
  name: "token",
  kind: "secret",
  title: "GitHub token",
  description: "Connect GitHub, so Reports files issues on akai-ito/ito-core as you.",
  connect: { kind: "oauth_device", title: "Connect GitHub" },
};

const reports = (state: string, isTokenSet: boolean, detail?: string): Readonly<Record<string, unknown>> => ({
  id: "reports",
  kind: "hand",
  title: "Reports",
  summary: "Takes your feedback, and what Ari couldn't do, to Ito's developers as public GitHub issues.",
  symbol: "exclamationmark.bubble",
  version: "0.2",
  state,
  ...(detail !== undefined && { detail }),
  fields: [{ ...reportsTokenField, set: isTokenSet }],
  uses: { hosts: ["api.github.com", "github.com"], folders: ["uploads"] },
});

const sourcesOff: readonly Readonly<Record<string, unknown>>[] = [
  {
    id: "icloud",
    kind: "source",
    title: "iCloud",
    summary: "Your iCloud Mail, Calendar and Contacts, read and kept by Kumo on your box.",
    symbol: "icloud",
    version: "0.1",
    state: "off",
    fields: [
      {
        name: "apple_id",
        kind: "text",
        title: "Email address",
        description: "The email address you sign in to iCloud with.",
        placeholder: "you@icloud.com",
      },
      {
        name: "app_password",
        kind: "secret",
        title: "App-specific password",
        description: [
          "Apple has no sign-in for other apps, so Kumo uses an app-specific password.",
          "1. Open Apple Account and sign in.",
          "2. In Sign-In and Security, choose App-Specific Passwords.",
          "3. Add one called Ito, and paste it here.",
          "",
          "It goes to your box only. One connection covers Mail, Calendar and Contacts.",
        ].join("\n"),
        set: false,
        connect: { kind: "link", title: "Open Apple Account", url: "https://account.apple.com/account/manage" },
      },
    ],
    uses: { hosts: ["caldav.icloud.com", "contacts.icloud.com", "imap.mail.me.com", "smtp.mail.me.com"], folders: [] },
  },
  {
    id: "outlook",
    kind: "source",
    title: "Outlook",
    summary: "Your Outlook.com mail, read by Kumo on your box. Kumo writes drafts and never sends.",
    symbol: "envelope",
    version: "0.1",
    state: "off",
    fields: [
      {
        name: "address",
        kind: "text",
        title: "Email address",
        description: "The email address you sign in to Outlook.com with.",
        placeholder: "you@outlook.com",
      },
      {
        name: "token",
        kind: "secret",
        title: "Microsoft account",
        description: [
          "Sign in with Microsoft so Kumo can read your Outlook.com mail.",
          "1. Open Microsoft and enter the code.",
          "2. Sign in, and allow access to your mail.",
          "",
          "The box keeps the sign-in and renews it itself.",
        ].join("\n"),
        set: false,
        connect: { kind: "oauth_device", title: "Open Microsoft" },
      },
    ],
    uses: { hosts: ["login.microsoftonline.com", "outlook.office365.com"], folders: [] },
  },
  {
    id: "gmail",
    kind: "source",
    title: "Gmail",
    summary: "Your Gmail, read by Kumo on your box. Kumo writes drafts and never sends.",
    symbol: "envelope",
    version: "0.1",
    state: "off",
    fields: [
      {
        name: "address",
        kind: "text",
        title: "Email address",
        description: "The email address you sign in to Gmail with.",
        placeholder: "you@gmail.com",
      },
      {
        name: "app_password",
        kind: "secret",
        title: "App password",
        description: [
          "Gmail lets other apps in with an app password, once 2-Step Verification is on.",
          "1. Open Google App Passwords and sign in.",
          "2. Make one called Ito.",
          "3. Paste the 16 letters here.",
          "",
          "It goes to your box only.",
        ].join("\n"),
        set: false,
        connect: { kind: "link", title: "Open Google", url: "https://myaccount.google.com/apppasswords" },
      },
    ],
    uses: { hosts: ["imap.gmail.com", "smtp.gmail.com"], folders: [] },
  },
];

const capabilityCall = (
  transcript: Transcript,
  method: string,
  path: string,
  body: unknown,
  status: number,
  answer: unknown,
): void => {
  transcript.request(method, path, body === undefined ? {} : { body });
  transcript.wait(60);
  transcript.response(status, answer, { headers: { "Ito-Protocol": protocol } });
};

const alexBefore = {
  address: "memory:people/alex",
  title: "Alex",
  gist: "Someone you're seeing; taking it slow",
  aliases: ["Alex R"],
  links: ["memory:places/dishoom-shoreditch"],
  markdown:
    "Taking things slow; you've been on two dates (as of 15 Oct).\n\n## Earlier\n\n" +
    "- 12 Oct: first date, Dishoom Shoreditch.\n",
};

const alexNow = {
  ...alexBefore,
  gist: "Someone you're seeing a lot; going really well",
  markdown:
    "Seeing each other a lot, and it's going really well (as of 26 Oct).\n\n## Earlier\n\n" +
    "- 15 Oct: decided to take things slow.\n- 12 Oct: first date, Dishoom Shoreditch.\n",
};

const lisbonTrip = {
  address: "memory:projects/lisbon-trip",
  title: "Lisbon trip",
  gist: "Four nights in November; no hotel yet",
  aliases: [],
  links: ["memory:people/alex"],
  markdown: "Four nights in Lisbon, 14 to 18 November. Flights booked; no hotel yet (as of 20 Oct).\n",
};

const nowPage = {
  address: "memory:now",
  title: "Now",
  gist: "Busy at work; training for Valencia",
  aliases: [],
  links: [],
  markdown: "A busy fortnight at work, and training for the Valencia half marathon (as of 22 Oct).\n",
};

const seededVersion = "5d41402abc";

type SeededPage = typeof alexBefore & { readonly note?: string; readonly circle?: string };

const shelfOf = (address: string): string => address.replace(/^memory:/u, "").split("/", 1)[0] ?? "";

const linkTo = ({ address, title, aliases }: SeededPage): Readonly<Record<string, unknown>> => ({
  address,
  title,
  aliases,
});

const pageBody = (
  page: SeededPage,
  changedAt: string,
  links: readonly SeededPage[] = [],
): Readonly<Record<string, unknown>> => ({
  address: page.address,
  title: page.title,
  gist: page.gist,
  ...(page.circle !== undefined && { circle: page.circle }),
  shelf: shelfOf(page.address),
  aliases: page.aliases,
  links: links.map((link) => linkTo(link)),
  changed_at: changedAt,
  markdown: page.markdown,
});

// One room of a gallery guide: its things to spot, each with where to look.
const guideRoom = (
  id: string,
  title: string,
  detail: string,
  items: readonly (readonly [string, string, string])[],
) => ({
  id,
  title,
  detail,
  items: items.map(([item, name, where]) => ({ id: item, title: name, detail: where })),
});

const memoryCall = (transcript: Transcript, path: string, answer: unknown): void => {
  transcript.request("GET", path);
  transcript.wait(50);
  transcript.response(200, answer, { headers: { "Ito-Protocol": protocol } });
};

const agentCalls = (
  transcript: Transcript,
  tool: string,
  input: Readonly<Record<string, unknown>>,
  returns?: Readonly<Record<string, unknown>>,
): void => {
  transcript.world("agent_calls", { tool, input, ...(returns && { returns }) });
};

const memoryStep = (
  transcript: Transcript,
  action: string,
  pages: readonly { readonly address: string; readonly title: string }[],
  titles: { readonly title: string; readonly endedTitle: string },
  change?: string,
): void => {
  transcript.step("memory", { ...titles, fields: { action, pages, ...(change !== undefined && { change }) } });
  transcript.endStep();
};

const florenceCard = {
  id: florenceId,
  kind: "trip",
  title: "Florence with Mira",
  summary: "6–9 Nov · 4 to book",
  status: "active" as const,
  pinned: true,
  salience: "loud" as const,
};

const motionStep = (
  transcript: Transcript,
  action: string,
  motion: { readonly id: string; readonly title: string; readonly version: number },
  titles: { readonly title: string; readonly endedTitle: string },
  note?: string,
): void => {
  transcript.step("motion", {
    ...titles,
    fields: {
      action,
      motion: motion.id,
      version: motion.version,
      ...(note !== undefined && { note }),
      pages: [{ address: `motion:${motion.id}`, title: motion.title }],
    },
  });
  transcript.endStep();
};

const motionLine = (id: string, version: number): string =>
  ["```ari:motion", JSON.stringify({ motion: id, change: version }), "```"].join("\n");

const startFlorence = (transcript: Transcript, pictures: FlorencePictures): ReturnType<Transcript["motion"]> => {
  agentCalls(transcript, "start_motion", {
    id: florenceId,
    kind: florenceCard.kind,
    title: florenceCard.title,
    summary: florenceCard.summary,
    salience: florenceCard.salience,
    content: florenceTrip(pictures),
    note: "Started the trip",
  });
  const started = transcript.motion(
    "started",
    { ...florenceCard, cover: pictures.cover, version: 1 },
    "Started the trip",
  );
  motionStep(transcript, "started", started.motion, {
    title: "Starting Florence with Mira",
    endedTitle: "Started Florence with Mira",
  });
  return started;
};

const sub20Card = {
  id: sub20Id,
  kind: "body",
  title: "Sub-20 5K",
  summary: "Week 6 of 10 · intervals today",
  status: "active" as const,
  pinned: true,
  salience: "loud" as const,
};

type TrainingWeek = { readonly id: string; readonly note?: string };

const withWeekNote = (week: string, note: string): Readonly<Record<string, unknown>> => ({
  ...sub20Training,
  weeks: (sub20Training.weeks as readonly TrainingWeek[]).map((each) => (each.id === week ? { ...each, note } : each)),
});

const findFlorencePictures = (transcript: Transcript): FlorencePictures => {
  transcript.step("web_search", searching("Florence Duomo, Uffizi, Pitti and Pisa photographs"));
  transcript.wait(1500);
  transcript.endStep();
  return Object.fromEntries(
    florencePictures.map((name) => {
      const url = `https://upload.wikimedia.org/wikipedia/commons/florence-${name}.jpg`;
      transcript.world("web_has", { url, file: "riverside.jpg" });
      const attachment = transcript.keptImage("riverside.jpg", `florence-${name}.jpg`);
      agentCalls(transcript, "keep_image", { url }, { attachment });
      transcript.wait(200);
      return [name, attachment];
    }),
  ) as FlorencePictures;
};

const halcyonTechnical = {
  uid: "halcyon-technical-1112@halcyon.example",
  title: "Halcyon technical",
  start: "2026-11-12T14:00:00.000Z",
  end: "2026-11-12T15:30:00.000Z",
  all_day: false,
  location: "Microsoft Teams",
  calendar: { name: "Home", kumo: false },
  status: "confirmed" as const,
};

const tessDraft = {
  account: "outlook",
  from: "divy@outlook.com",
  to: ["tess.harlow@halcyon.example"],
  subject: "Re: Thursday's technical",
  body: "Hi Tess, Thursday at 2 works great, thanks for moving it. See you on Teams! Divy",
  message_id: "draft-tess-0001@ito.local",
  in_reply_to: "moved-0091@halcyon.example",
};

const northwindBody =
  "Hi Clara, thanks for reaching out! I'd love a first call. Thursday 13th at 9:00 or Friday 14th at 17:30 " +
  "work well for me. Here's my CV, and I'm on LinkedIn too. Best, Divy";

const spokenWav = { "Content-Type": "audio/wav", "Content-Length": "12044" };

const preview = "Hi, I'm Ari. This is how I sound.";

const speak = (transcript: Transcript, voice?: string): void => {
  transcript.request("POST", "/v0/speech", { body: { text: preview, ...(voice !== undefined && { voice }) } });
  transcript.wait(240);
  transcript.response(200, undefined, { headers: { ...spokenWav, "Ito-Protocol": protocol } });
};

// Open-Meteo's forecast for a rough place, as the box asks for it.
const weather = (place: { readonly latitude: number; readonly longitude: number }): string =>
  "https://api.open-meteo.com/v1/forecast" +
  `?latitude=${place.latitude.toFixed(1)}&longitude=${place.longitude.toFixed(1)}` +
  "&current=temperature_2m,weather_code,is_day&daily=sunset&timezone=auto&forecast_days=1";

const scenarios: readonly (() => Transcript)[] = [
  () => {
    const transcript = createTranscript({
      name: "01-first-connection",
      scenario: 1,
      title: "First connection",
      summary:
        "Ari checks which protocol the server speaks, is refused a mistyped token, then connects " +
        "with the right one and receives a snapshot of an empty conversation.",
      guarantees: ["G11", "G12"],
    });
    transcript.begin(todayAt);
    transcript.request("GET", "/.well-known/ito");
    transcript.wait(40);
    transcript.response(200, { product: "ito", protocol: [protocol] }, { headers: { "Ito-Protocol": protocol } });
    transcript.wait(20);
    transcript.request("GET", "/v0/server", {
      headers: { Authorization: "Bearer ito_example_mistyped_token_0000000000000000000" },
    });
    transcript.wait(40);
    transcript.response(
      401,
      {
        error: {
          code: "token_rejected",
          message: "The server didn't accept this token.",
          detail: "Use the token ito serve printed, or run ito token new.",
        },
      },
      { headers: { "Ito-Protocol": protocol } },
    );
    transcript.wait(9000);
    transcript.request("GET", "/v0/server", { headers: { Authorization: authorization } });
    transcript.wait(40);
    transcript.response(
      200,
      {
        name: "studio",
        version: serverVersion,
        protocol,
        lead: { name: "Kumo" },
        time_zone: "UTC",
        agent: {},
        setup: { notifications: false, memory_backup: false },
        capabilities: [],
      },
      { headers: { "Ito-Protocol": protocol } },
    );
    transcript.wait(10);
    transcript.connect({ headers: { Authorization: authorization } });
    return transcript;
  },

  () => {
    const transcript = createTranscript({
      name: "02-open-ari",
      scenario: 2,
      title: "Open Ari",
      summary:
        "The next morning Ari shows what it already had, then resumes from its cursor and " +
        "receives only what is new: an exchange you had on the Mac last night.",
      guarantees: ["G2", "G4", "G13"],
    });
    yesterday(transcript);
    const phoneSaw = transcript.latestEventId();
    transcript.time("2026-10-11T22:05:00.000Z");
    transcript.exchange(
      "What time is sunrise on Saturday?",
      "07:12 in London, so it's light enough to start a run by about 06:50.",
    );
    transcript.begin("2026-10-12T07:58:00.000Z", { cursor: phoneSaw });
    transcript.world("app_opened");
    transcript.connect();
    return transcript;
  },

  () => {
    const transcript = createTranscript({
      name: "03-send",
      scenario: 3,
      title: "Send",
      summary:
        "Ari sends a message under the id it chose; the server confirms once the message is on " +
        "disk, before the agent is involved, and every app receives it.",
      guarantees: ["G1", "G2"],
    });
    yesterday(transcript);
    transcript.begin(todayAt, { cursor: "latest" });
    transcript.connect();
    transcript.wait(2000);
    sendAndStart(transcript, saturdayQuestion);
    transcript.wait(400);
    transcript.step("thinking", thinking);
    transcript.wait(1500);
    writeWhole(transcript, saturdayAnswer, 3);
    transcript.endTurn("completed");
    return transcript;
  },

  () => {
    const transcript = createTranscript({
      name: "04-the-agent-stirs",
      scenario: 4,
      title: "The agent stirs",
      summary:
        "The turn starts at once, then the agent's steps stream as it works (thinking, a web " +
        "search, reading a note), each with a plain title and its specifics, with a note from the " +
        "agent along the way; status follows the work and ends with the turn.",
      guarantees: ["G8", "G10", "G14"],
    });
    yesterday(transcript);
    transcript.begin(todayAt, { cursor: "latest" });
    transcript.connect();
    transcript.wait(2000);
    sendAndStart(transcript, saturdayQuestion);
    transcript.wait(250);
    transcript.step("thinking", thinking);
    transcript.wait(900);
    heading(transcript, "Sketching a calm Saturday", "A long run first, then something slow by the river.");
    transcript.wait(700);
    transcript.reply("note");
    transcript.write("I'll check which cafés by the river open early.", { pieces: 2 });
    transcript.endMessage("completed");
    transcript.wait(40);
    transcript.step("web_search", searching("riverside cafés open at 9am"));
    transcript.wait(2600);
    transcript.step("command", {
      title: "Reading saturday.md",
      endedTitle: "Read saturday.md",
      fields: {
        command: "cat notes/saturday.md",
        cwd: "/home/you/.ito/workspace",
        actions: [{ type: "read", path: "notes/saturday.md" }],
      },
    });
    transcript.wait(300);
    transcript.endStep({ fields: { exit_code: 0, output: "Long run with Sam at 7:30.\n" } });
    transcript.step("thinking", thinking);
    transcript.wait(400);
    heading(transcript, "Fitting the day around the run", "Breakfast after the run, the garden in the afternoon.");
    transcript.wait(700);
    writeWhole(transcript, saturdayAnswer, 4);
    transcript.endTurn("completed");
    return transcript;
  },

  () => {
    const transcript = createTranscript({
      name: "05-the-reply-streams",
      scenario: 5,
      title: "The reply streams",
      summary:
        "Reply text arrives as appended pieces, each with its offset, including a burst after the " +
        "network held several back; the finished text is exactly what streamed.",
      guarantees: ["G7"],
    });
    yesterday(transcript);
    transcript.begin(todayAt, { cursor: "latest" });
    transcript.connect();
    transcript.wait(2000);
    sendAndStart(transcript, saturdayQuestion);
    transcript.wait(300);
    transcript.step("thinking", thinking);
    transcript.wait(1500);
    transcript.status("writing", "Writing");
    transcript.reply();
    const first = upTo(saturdayAnswer, "café opens at 9.\n");
    const second = upTo(saturdayAnswerAfter(first), "before the afternoon.\n");
    transcript.write(first, { everyMs: 110 });
    transcript.wait(110);
    transcript.stall(900);
    transcript.write(second, { everyMs: 110 });
    transcript.wait(1000);
    transcript.write(saturdayAnswerAfter(first + second), { everyMs: 110 });
    transcript.endMessage("completed");
    transcript.endTurn("completed");
    return transcript;
  },

  () => {
    const transcript = createTranscript({
      name: "06-you-scroll-up-mid-reply",
      scenario: 6,
      title: "You scroll up mid-reply",
      summary:
        "Nothing changes on the wire while you read back: the reply keeps streaming, and its end " +
        "is an explicit event, so the app can say it finished without guessing.",
      guarantees: ["G8"],
    });
    yesterday(transcript);
    transcript.begin(todayAt, { cursor: "latest" });
    transcript.connect();
    transcript.wait(2000);
    sendAndStart(transcript, saturdayQuestion);
    transcript.wait(300);
    transcript.step("thinking", thinking);
    transcript.wait(1200);
    transcript.status("writing", "Writing");
    transcript.reply();
    const first = upTo(saturdayAnswer, "slow hour with your book.\n");
    transcript.write(first, { everyMs: 120 });
    transcript.world("app_scrolled_up");
    transcript.wait(120);
    transcript.write(saturdayAnswerAfter(first), { everyMs: 120 });
    transcript.endMessage("completed");
    transcript.endTurn("completed");
    return transcript;
  },

  () => {
    const transcript = createTranscript({
      name: "07-stop",
      scenario: 7,
      title: "Stop",
      summary:
        "Stop names the turn; the stopped message keeps everything it had streamed, and a message sent " +
        "while stopping starts the next turn. A Stop just after a message began keeps what little it " +
        "had. A Stop while a step runs ends the step as stopped, keeping its present-tense title.",
      guarantees: ["G3", "G7", "G9", "G14"],
    });
    yesterday(transcript);
    transcript.begin(todayAt, { cursor: "latest" });
    transcript.connect();
    transcript.wait(2000);
    const { turn } = sendAndStart(transcript, saturdayQuestion);
    transcript.wait(300);
    transcript.step("thinking", thinking);
    transcript.wait(1400);
    transcript.status("writing", "Writing");
    transcript.reply();
    transcript.write(upTo(saturdayAnswer, "botanic garden,"), { everyMs: 110 });
    transcript.wait(60);
    transcript.stop(turn);
    transcript.status("stopping", "Stopping");
    transcript.wait(150);
    const morning = transcript.send("Actually, just plan the morning.");
    transcript.queue(morning);
    transcript.wait(250);
    transcript.endMessage("stopped");
    transcript.endTurn("stopped");
    transcript.startTurn([morning]);
    transcript.wait(300);
    transcript.step("thinking", thinking);
    transcript.wait(1100);
    writeWhole(
      transcript,
      "Morning only:\n\n- **07:30** Long run, 18 km along the river.\n- **09:15** Coffee at the café by the bridge; it opens at 9.",
    );
    transcript.endTurn("completed");

    transcript.wait(20_000);
    const evening = sendAndStart(transcript, "And Saturday evening?");
    transcript.wait(900);
    writeWhole(transcript, "Evening: dinner at home, then an early night before the long run.", 3);
    transcript.status("writing", "Writing");
    transcript.reply();
    transcript.write("If it rains, swap the walk for the ", { pieces: 2 });
    transcript.wait(60);
    transcript.stop(evening.turn);
    transcript.status("stopping", "Stopping");
    transcript.wait(150);
    transcript.endMessage("stopped");
    transcript.endTurn("stopped");

    transcript.wait(20_000);
    const cafe = sendAndStart(transcript, "Find a café for after the run.");
    transcript.wait(300);
    transcript.step("web_search", searching("cafés near Battersea Park open at 9"));
    transcript.wait(1200);
    transcript.stop(cafe.turn);
    transcript.status("stopping", "Stopping");
    transcript.wait(150);
    transcript.endTurn("stopped");
    return transcript;
  },

  () => {
    const transcript = createTranscript({
      name: "08-copy-and-share",
      scenario: 8,
      title: "Copy and share",
      summary:
        "Message text is the Markdown source, code fence included, available piece by piece while " +
        "it streams, so the app can copy any part of it at any time.",
      guarantees: ["G7"],
    });
    yesterday(transcript);
    transcript.begin(todayAt, { cursor: "latest" });
    transcript.connect();
    transcript.wait(2000);
    sendAndStart(transcript, "How do I see what's using port 8080 on my Mac?");
    transcript.wait(300);
    transcript.step("thinking", thinking);
    transcript.wait(1200);
    writeWhole(
      transcript,
      "Run this in Terminal:\n\n```sh\nlsof -nP -iTCP:8080 -sTCP:LISTEN\n```\n\nThe second column is the process ID; `kill <PID>` stops it.",
      6,
    );
    transcript.endTurn("completed");
    return transcript;
  },

  () => {
    const transcript = createTranscript({
      name: "09-scrolling-back",
      scenario: 9,
      title: "Scrolling back",
      summary:
        "Ari pages backwards from the oldest message it has, a page at a time, until the server " +
        "says there is nothing older; pages are bounded by messages, so they never shift, and " +
        "each carries the agent's steps among its messages.",
      guarantees: ["G3", "G14"],
    });
    transcript.time("2026-09-01T17:30:00.000Z");
    transcript.exchange(
      "Any good running routes near Battersea?",
      "The river loop from Albert Bridge to Chelsea Bridge is about 5 km, flat and lit after dark. Add Battersea Park's outer path for 8 km.",
    );
    transcript.time("2026-09-10T06:55:00.000Z");
    const stretch = transcript.exchange(
      "What's a good stretch after a long run?",
      "Calves and hamstrings first: two minutes each against a wall, then a slow hip-flexor lunge. Skip deep static stretches straight after a race.",
    );
    transcript.time("2026-09-14T17:02:00.000Z");
    transcript.exchange(
      "Somewhere quiet for dinner near Clapham, Thursday?",
      "**Bistro Juno**: small, quiet after 8, and they hold tables for 15 minutes. Book through their site; Thursday has space at 19:45.",
    );
    transcript.time("2026-09-16T20:40:00.000Z");
    const thanks = transcript.exchange(
      "Thanks, Juno was perfect.",
      "Glad it worked. I'll remember it for next time you want somewhere quiet.",
    );
    yesterday(transcript);
    transcript.begin(todayAt, { cursor: "latest", oldestCached: thanks.user });
    transcript.connect();
    transcript.wait(3000);
    transcript.listMessages(thanks.user, 4);
    transcript.wait(2500);
    transcript.listMessages(stretch.user, 4);
    return transcript;
  },

  () => {
    const transcript = createTranscript({
      name: "10-send-while-it-s-busy",
      scenario: 10,
      title: "Send while it's busy",
      summary:
        "A message sent mid-reply joins the running turn: the reply being written finishes, the " +
        "agent reads the message and adjusts in a new reply. While the agent can't take input, a " +
        "message waits as Next and starts the following turn.",
      guarantees: ["G2", "G3"],
    });
    yesterday(transcript);
    transcript.begin(todayAt, { cursor: "latest" });
    transcript.connect();
    transcript.wait(2000);
    sendAndStart(transcript, saturdayQuestion);
    transcript.wait(300);
    transcript.step("thinking", thinking);
    transcript.wait(1400);
    transcript.status("writing", "Writing");
    transcript.reply();
    const first = upTo(saturdayAnswer, "slow hour with your book.\n");
    transcript.write(first, { everyMs: 110 });
    transcript.wait(80);
    const outdoors = transcript.send("Make the calm part outdoors");
    transcript.wait(30);
    transcript.write(saturdayAnswerAfter(first), { everyMs: 110 });
    transcript.endMessage("completed");
    transcript.wait(400);
    transcript.read(outdoors);
    transcript.status("adjusting", "Adjusting to your message");
    transcript.wait(900);
    transcript.status("writing", "Writing");
    transcript.reply();
    transcript.write(
      "Moving the calm part outside:\n\n- **13:00** Picnic lunch in the park instead.\n- **15:00** Keep the botanic garden walk; it's outdoors already.",
    );
    transcript.endMessage("completed");
    transcript.endTurn("completed");

    transcript.wait(30_000);
    sendAndStart(transcript, "Also find somewhere for breakfast by the river.");
    transcript.wait(200);
    transcript.world("engine_compacting", { until: transcript.stepAtOffset(2900) });
    transcript.step("compacting", tidying);
    transcript.wait(700);
    const seats = transcript.send("With outdoor seats, ideally.");
    transcript.queue(seats);
    transcript.wait(2169);
    transcript.step("web_search", searching("breakfast by the river, London"));
    transcript.wait(2400);
    writeWhole(
      transcript,
      "**The Boathouse** opens at 8 and faces the water, ten minutes' walk from where your run ends.",
    );
    transcript.endTurn("completed");
    transcript.startTurn([seats]);
    transcript.wait(600);
    writeWhole(transcript, "It does: six tables on the terrace, first come, first served.");
    transcript.endTurn("completed");
    return transcript;
  },

  () => {
    const transcript = createTranscript({
      name: "11-signal-drops-mid-reply",
      scenario: 11,
      title: "Signal drops mid-reply",
      summary:
        "The connection drops twice mid-reply. Each time Ari resumes from its cursor and receives " +
        "exactly the pieces it missed; the second time the reply finished while it was away, so " +
        "the rest and the end arrive at once.",
      guarantees: ["G4", "G7"],
    });
    yesterday(transcript);
    transcript.begin(todayAt, { cursor: "latest" });
    transcript.connect();
    transcript.wait(2000);
    sendAndStart(transcript, saturdayQuestion);
    transcript.wait(300);
    transcript.step("thinking", thinking);
    transcript.wait(1300);
    transcript.status("writing", "Writing");
    transcript.reply();
    const first = upTo(saturdayAnswer, "Breakfast, then a slow ");
    transcript.write(first, { everyMs: 110 });
    transcript.wait(50);
    transcript.disconnect("offline");
    transcript.wait(70);
    const second = upTo(saturdayAnswerAfter(first), "Lunch at home;");
    transcript.write(second, { everyMs: 110 });
    transcript.wait(5200);
    transcript.world("online");
    transcript.connect();
    transcript.wait(110);
    const third = upTo(saturdayAnswerAfter(first + second), "phone in your");
    transcript.write(third, { everyMs: 110 });
    transcript.wait(40);
    transcript.disconnect("offline");
    transcript.wait(70);
    transcript.write(saturdayAnswerAfter(first + second + third), { everyMs: 110 });
    transcript.endMessage("completed");
    transcript.endTurn("completed");
    transcript.wait(19_000);
    transcript.world("online");
    transcript.connect();
    return transcript;
  },

  () => {
    const transcript = createTranscript({
      name: "12-send-while-offline",
      scenario: 12,
      title: "Send while offline",
      summary:
        "Two messages written offline go out in order once the signal returns. The first response " +
        "is lost, so Ari sends the first message again and gets the same message back, unchanged; " +
        "the second joins the turn the first started.",
      guarantees: ["G1", "G2", "G3"],
    });
    yesterday(transcript);
    transcript.begin(todayAt, { cursor: "latest" });
    transcript.connect();
    transcript.wait(1000);
    transcript.disconnect("offline");
    transcript.wait(9000);
    transcript.world("online");
    transcript.connect();
    transcript.wait(5);
    const juno = "Also, can you check if Juno is open on Sunday?";
    const first = transcript.send(juno, { isLost: true });
    transcript.startTurn([first]);
    transcript.wait(300);
    transcript.step("thinking", thinking);
    transcript.wait(1700);
    transcript.send(juno, { id: first });
    const second = transcript.send("And book for two at 8 if so");
    transcript.wait(600);
    transcript.read(second);
    transcript.step("web_search", searching("Bistro Juno Sunday opening hours"));
    transcript.wait(2600);
    writeWhole(
      transcript,
      "Juno is open on Sunday from 18:00, and they have a table for two at 20:00. I can't book for you yet; their booking page is bistrojuno.example/book.",
    );
    transcript.endTurn("completed");
    return transcript;
  },

  () => {
    const transcript = createTranscript({
      name: "13-ari-is-closed-mid-reply",
      scenario: 13,
      title: "Ari is closed mid-reply",
      summary:
        "Ari closes mid-reply and the agent keeps working on the server. When you return, Ari " +
        "resumes from its cursor and receives the rest of the reply and its end at once.",
      guarantees: ["G4", "G6"],
    });
    yesterday(transcript);
    transcript.begin(todayAt, { cursor: "latest" });
    transcript.connect();
    transcript.wait(2000);
    sendAndStart(transcript, saturdayQuestion);
    transcript.wait(300);
    transcript.step("thinking", thinking);
    transcript.wait(1300);
    transcript.status("writing", "Writing");
    transcript.reply();
    const first = upTo(saturdayAnswer, "café opens at 9.\n");
    transcript.write(first, { everyMs: 110 });
    transcript.wait(50);
    transcript.disconnect("app_closed");
    transcript.wait(60);
    transcript.write(saturdayAnswerAfter(first), { everyMs: 110 });
    transcript.endMessage("completed");
    transcript.endTurn("completed");
    transcript.wait(660_000);
    transcript.world("app_opened");
    transcript.connect();
    return transcript;
  },

  () => {
    const transcript = createTranscript({
      name: "14-the-server-restarts-or-is-restored",
      scenario: 14,
      title: "The server restarts, or is restored",
      summary:
        "The server restarts mid-reply and, on startup, ends the cut-off turn, keeping its text as " +
        "interrupted; Ari learns it by resuming. Another day the server is restored from a backup, " +
        "Ari's cursor is unknown to it, and Ari receives a snapshot of what the server has.",
      guarantees: ["G1", "G5", "G8"],
    });
    yesterday(transcript);
    const backup = transcript.latestEventId();
    if (!backup) throw new Error("no backup point");
    transcript.begin(todayAt, { cursor: "latest" });
    transcript.connect();
    transcript.wait(2000);
    sendAndStart(transcript, saturdayQuestion);
    transcript.wait(300);
    transcript.step("thinking", thinking);
    transcript.wait(1300);
    transcript.status("writing", "Writing");
    transcript.reply();
    transcript.write(upTo(saturdayAnswer, "slow hour with your book.\n"), { everyMs: 110 });
    transcript.wait(80);
    transcript.restart();
    transcript.wait(1500);
    transcript.connect();
    transcript.wait(86_400_000);
    transcript.restore(backup);
    transcript.wait(2000);
    transcript.connect();
    return transcript;
  },

  () => {
    const transcript = createTranscript({
      name: "15-something-fails",
      scenario: 15,
      title: "Something fails",
      summary:
        "The model's stream drops mid-reply and doesn't come back; the turn fails with a typed error and " +
        "the text so far is kept. Try again, tapped twice, starts one new attempt that answers the " +
        "same message. A turn that fails before writing still leaves a reply: empty, carrying the " +
        "error, and the step it was on ends with it.",
      guarantees: ["G2", "G8", "G10", "G14"],
    });
    yesterday(transcript);
    transcript.begin(todayAt, { cursor: "latest" });
    transcript.connect();
    transcript.wait(2000);
    const { turn } = sendAndStart(transcript, saturdayQuestion);
    transcript.wait(300);
    transcript.step("thinking", thinking);
    transcript.wait(1300);
    transcript.status("writing", "Writing");
    transcript.reply();
    transcript.write(upTo(saturdayAnswer, "café opens at 9."), { everyMs: 110 });
    transcript.wait(2000);
    const error: ErrorBody = {
      code: "model_unavailable",
      message: "The model service isn't responding right now.",
      detail: "Reconnecting... 5/5 stream disconnected before completion: stream closed before response.completed",
    };
    transcript.endMessage("failed", { error });
    transcript.endTurn("failed", error);
    transcript.wait(6000);
    transcript.retry(turn);
    transcript.wait(300);
    transcript.retry(turn);
    transcript.wait(300);
    transcript.step("thinking", thinking);
    transcript.wait(1200);
    writeWhole(transcript, saturdayAnswer, 4);
    transcript.endTurn("completed");

    transcript.wait(20_000);
    sendAndStart(transcript, "And Sunday?");
    transcript.wait(300);
    transcript.step("thinking", thinking);
    transcript.wait(2000);
    const unavailable: ErrorBody = {
      code: "model_unavailable",
      message: "The model service isn't responding right now.",
      detail: "The model service answered 503 Service Unavailable.",
    };
    transcript.endStep({ outcome: "failed" });
    transcript.reply();
    transcript.endMessage("failed", { error: unavailable });
    transcript.endTurn("failed", unavailable);
    return transcript;
  },

  () => {
    const transcript = createTranscript({
      name: "16-working-through-a-task",
      scenario: 16,
      title: "Working through a task",
      summary:
        "The agent works through a task step by step: a plan it updates as it goes, a command " +
        "with two actions, a search that finds nothing (exit code 1, still completed), a tool, a " +
        "wait and a file change, each with a plain title and its specifics; the plan ends with the turn.",
      guarantees: ["G10", "G14"],
    });
    yesterday(transcript);
    transcript.begin(todayAt, { cursor: "latest" });
    transcript.connect();
    transcript.wait(2000);
    sendAndStart(transcript, "Tidy up my packing list for Saturday, and check the weather.");
    transcript.wait(300);
    transcript.step("thinking", thinking);
    transcript.wait(900);
    const plan = transcript.step("plan", {
      title: "Planning 3 steps",
      endedTitle: "Planned 3 steps",
      fields: { items: packingPlan(["in_progress"]) },
    });
    transcript.wait(200);
    transcript.step("command", {
      title: "Reading packing.md",
      endedTitle: "Read packing.md",
      fields: {
        command: 'cat packing.md && grep -n "jacket" packing.md',
        cwd: "/home/you/.ito/workspace",
        actions: [
          { type: "read", path: "packing.md" },
          { type: "search", query: "jacket", path: "packing.md" },
        ],
      },
    });
    transcript.wait(400);
    transcript.endStep({
      fields: { exit_code: 0, output: "- Running shoes\n- Water bottle\n- Light jacket\n3:- Light jacket\n" },
    });
    transcript.updateStep({ items: packingPlan(["done", "in_progress"]) }, { id: plan });
    transcript.step("command", {
      title: "Searching for “umbrella”",
      endedTitle: "Searched for “umbrella”",
      fields: {
        command: 'grep -rn "umbrella" notes/',
        cwd: "/home/you/.ito/workspace",
        actions: [{ type: "search", query: "umbrella", path: "notes/" }],
      },
    });
    transcript.wait(300);
    transcript.endStep({ fields: { exit_code: 1 } });
    transcript.step("tool", {
      title: "Using weather",
      endedTitle: "Used weather",
      fields: { capability: "weather", operation: "forecast", arguments: { place: "London", day: "Saturday" } },
    });
    transcript.wait(1300);
    transcript.endStep();
    transcript.step("wait", { title: "Waiting 2 seconds", endedTitle: "Waited 2 seconds", fields: { wait_ms: 2000 } });
    transcript.wait(2000);
    transcript.endStep();
    transcript.updateStep({ items: packingPlan(["done", "done", "in_progress"]) }, { id: plan });
    transcript.step("file_change", {
      title: "Editing packing.md",
      endedTitle: "Edited packing.md",
      fields: { files: [{ path: "packing.md", change: "modified", lines_added: 2, lines_removed: 1 }] },
    });
    transcript.wait(500);
    transcript.endStep();
    transcript.updateStep({ items: packingPlan(["done", "done", "done"]) }, { id: plan });
    transcript.wait(300);
    writeWhole(
      transcript,
      "Done. Saturday looks wet until noon, so I swapped the light jacket for a rain jacket and added an umbrella to your list.",
    );
    transcript.endTurn("completed");
    return transcript;
  },

  () => {
    const transcript = createTranscript({
      name: "17-reporting-a-gap",
      scenario: 17,
      title: "Reporting what you noticed",
      summary:
        "You send a screenshot and ask Ari to pass on what bothers you. Ari drafts a report in your words, and it " +
        "waits inside the turn as an approval showing the draft and the screenshot it would attach. You file it, " +
        "and the tool step links the issue. Later you add a thought, and Ari adds it to the same issue.",
      guarantees: ["G10", "G14", "G28"],
    });
    yesterday(transcript);
    transcript.begin(todayAt, { cursor: "latest" });
    transcript.world("capability_on", { capability: "reports", values: { token: "github_pat_example" } });
    transcript.connect();
    transcript.wait(2000);
    const shot = transcript.upload("library-shelves.png");
    transcript.wait(200);
    const noticed = transcript.send(
      "The Library shelves just show cut-off page names. Can you pass that on? I'd rather each had an icon.",
      { attachments: [shot] },
    );
    transcript.startTurn([noticed]);
    transcript.wait(900);
    const title = "Library shelves need icons, not clipped names";
    const body =
      "The Library's shelf cards show fragments of page titles that end in ellipses, so they read like search " +
      "results rather than places to browse.\n\nA distinct icon for each shelf, in the app's own style, with " +
      "its name and count, would tell them apart at a glance.";
    const reporting = { title: "Reporting it to Ito", endedTitle: "Reported it to Ito" };
    transcript.step("tool", {
      ...reporting,
      fields: {
        capability: "reports",
        operation: "report",
        arguments: {
          title,
          body,
          screenshots: [{ file: "uploads/library-shelves.png", shows: "the Library shelves" }],
        },
      },
    });
    transcript.wait(300);
    transcript.approval({
      question: "File this on GitHub?",
      preview: [title, "", body, "", "Screenshots: the Library shelves", "Public, on akai-ito/ito-core."].join("\n"),
      options: [{ label: "File it", acts: true }, { label: "Don't" }],
      attachments: [shot],
    });
    transcript.wait(6000);
    const filed = transcript.send("File it");
    transcript.read(filed);
    transcript.status("working", "Going ahead");
    transcript.wait(1500);
    const issue = "https://github.com/akai-ito/ito-core/issues/42";
    transcript.endStep({ fields: { url: issue } });
    writeWhole(transcript, `Filed, with your screenshot: [${title}](${issue}).`);
    transcript.endTurn("completed");
    transcript.wait(5 * 60 * 1000);
    const more = transcript.send("Actually, no description is fine too: just the icon, the name and the count.");
    transcript.startTurn([more]);
    transcript.wait(700);
    const addition =
      "An icon with the shelf's name and count, and no description at all, would be just as good: better than " +
      "filler or a clipped list.";
    transcript.step("tool", {
      ...reporting,
      fields: { capability: "reports", operation: "report", arguments: { body: addition, issue: 42 } },
    });
    transcript.wait(300);
    transcript.approval({
      question: "Add this to issue #42 on GitHub?",
      preview: [addition, "", "Public, on akai-ito/ito-core#42."].join("\n"),
      options: [{ label: "Add it", acts: true }, { label: "Don't" }],
    });
    transcript.wait(4000);
    const added = transcript.send("Add it");
    transcript.read(added);
    transcript.status("working", "Going ahead");
    transcript.wait(1000);
    transcript.endStep({ fields: { url: `${issue}#issuecomment-6510000001` } });
    writeWhole(transcript, "Added to the same issue.");
    transcript.endTurn("completed");
    return transcript;
  },

  () => {
    const transcript = createTranscript({
      name: "18-a-reply-while-you-re-away",
      scenario: 18,
      title: "A reply while you're away",
      summary:
        "You send two messages and leave. The first reply reaches your lock screen as a notification with " +
        "its first line, Markdown stripped; the second turn fails, and that arrives too, just as loud. Opening " +
        "Ari catches up.",
      guarantees: ["G15", "G18"],
    });
    yesterday(transcript);
    transcript.begin(todayAt, { cursor: "latest" });
    transcript.connect();
    transcript.registerDevice();
    transcript.wait(2000);
    const { turn } = sendAndStart(transcript, saturdayQuestion);
    transcript.wait(800);
    const bus = transcript.send("Also, does the 37 bus run before 7 on Saturdays?");
    transcript.queue(bus);
    transcript.wait(400);
    transcript.disconnect("app_closed");
    transcript.wait(300);
    transcript.step("thinking", thinking);
    transcript.wait(2200);
    writeWhole(transcript, saturdayAnswer);
    transcript.endTurn("completed");
    transcript.startTurn([bus]);
    transcript.wait(300);
    transcript.step("web_search", searching("37 bus Saturday first departure"));
    transcript.wait(60_000);
    const unavailable: ErrorBody = {
      code: "model_unavailable",
      message: "The model service isn't responding right now.",
      detail: "The model service answered 503 Service Unavailable.",
    };
    transcript.endStep({ outcome: "failed" });
    transcript.reply();
    transcript.endMessage("failed", { error: unavailable });
    transcript.endTurn("failed", unavailable);
    transcript.wait(20 * 60 * 1000);
    transcript.world("app_opened", { from: "notification", turn });
    transcript.connect();
    return transcript;
  },

  () => {
    const transcript = createTranscript({
      name: "19-ari-asks-before-acting",
      scenario: 19,
      title: "Ari asks before acting",
      summary:
        "The agent finds two places called Juno and asks which you meant, with both as options and room " +
        "to type your own answer. Asking ends its turn. Tapping Clapham sends it as your message, which " +
        "answers the ask, and a new turn carries on.",
      guarantees: ["G16"],
    });
    yesterday(transcript);
    transcript.begin(todayAt, { cursor: "latest" });
    transcript.connect();
    transcript.wait(2000);
    sendAndStart(transcript, "Book a table at Juno for Saturday at 7:30, for two.");
    transcript.wait(300);
    askWhichJuno(transcript);
    transcript.endTurn("completed");
    transcript.wait(4000);
    const clapham = transcript.send("Clapham");
    transcript.startTurn([clapham]);
    transcript.wait(300);
    transcript.step(
      "tool",
      booking("check", {
        place: "Juno, Clapham",
        day: "Saturday",
        time: "19:30",
        people: 2,
      }),
    );
    transcript.wait(1400);
    transcript.endStep();
    writeWhole(transcript, "Juno in Clapham has a table for two at 7:30 on Saturday. Shall I book it?");
    transcript.endTurn("completed");
    return transcript;
  },

  () => {
    const transcript = createTranscript({
      name: "20-an-approval",
      scenario: 20,
      title: "An approval",
      summary:
        "Before booking, the agent asks for your approval, with a preview of exactly what would happen " +
        "and the option that acts marked. You tap Book it, and the next turn books.",
      guarantees: ["G16"],
    });
    yesterday(transcript);
    transcript.begin(todayAt, { cursor: "latest" });
    transcript.connect();
    transcript.wait(2000);
    sendAndStart(transcript, "Book Juno in Clapham for Saturday at 7:30, for two.");
    transcript.wait(300);
    transcript.step(
      "tool",
      booking("check", {
        place: "Juno, Clapham",
        day: "Saturday",
        time: "19:30",
        people: 2,
      }),
    );
    transcript.wait(1300);
    transcript.ask({
      kind: "approval",
      question: "Shall I book this?",
      preview: "Juno, Clapham\nSaturday 18 October, 7:30pm\nTable for 2, under your name",
      options: [{ label: "Book it", acts: true }, { label: "Not now" }],
      allowsText: false,
    });
    transcript.endTurn("completed");
    transcript.wait(3000);
    const yes = transcript.send("Book it");
    transcript.startTurn([yes]);
    transcript.wait(300);
    transcript.step(
      "tool",
      booking("book", {
        place: "Juno, Clapham",
        day: "Saturday",
        time: "19:30",
        people: 2,
      }),
    );
    transcript.wait(1800);
    transcript.endStep();
    writeWhole(transcript, "Booked: Juno in Clapham, Saturday at 7:30, a table for two. The reference is JC4821.");
    transcript.endTurn("completed");
    return transcript;
  },

  () => {
    const transcript = createTranscript({
      name: "21-an-ask-while-you-re-away",
      scenario: 21,
      title: "An ask while you're away",
      summary:
        "The agent asks while you're away, so the ask arrives as a notification carrying its options. " +
        "Answering from the notification is an ordinary send naming the ask; the agent carries on, and its " +
        "reply notifies you too.",
      guarantees: ["G15", "G16", "G18"],
    });
    yesterday(transcript);
    transcript.begin(todayAt, { cursor: "latest" });
    transcript.connect();
    transcript.registerDevice();
    transcript.wait(2000);
    sendAndStart(transcript, "Book a table at Juno for Friday at 8, for two.");
    transcript.wait(500);
    transcript.disconnect("app_closed");
    transcript.wait(300);
    const juno = askWhichJuno(transcript);
    transcript.endTurn("completed");
    transcript.wait(90_000);
    transcript.world("notification_answered", { ask: juno, option: "Soho" });
    const soho = transcript.send("Soho");
    transcript.startTurn([soho]);
    transcript.wait(300);
    transcript.step(
      "tool",
      booking("book", {
        place: "Juno, Soho",
        day: "Friday",
        time: "20:00",
        people: 2,
      }),
    );
    transcript.wait(1800);
    transcript.endStep();
    writeWhole(transcript, "Booked: Juno in Soho, Friday at 8, a table for two.");
    transcript.endTurn("completed");
    transcript.wait(10 * 60 * 1000);
    transcript.world("app_opened", { from: "notification" });
    transcript.connect();
    return transcript;
  },

  () => {
    const transcript = createTranscript({
      name: "22-waiting",
      scenario: 22,
      title: "Waiting",
      summary:
        "An ask waits for hours, through the app closing and the server restarting, and is still there " +
        "when you come back. Stop cancels it, and the cancelled ask stays in the conversation.",
      guarantees: ["G16"],
    });
    yesterday(transcript);
    transcript.begin(todayAt, { cursor: "latest" });
    transcript.connect();
    transcript.wait(2000);
    sendAndStart(transcript, "Book Juno for Saturday.");
    transcript.wait(300);
    const juno = askWhichJuno(transcript);
    transcript.endTurn("completed");
    transcript.wait(5000);
    transcript.disconnect("app_closed");
    transcript.wait(2 * 60 * 60 * 1000);
    transcript.restart();
    transcript.wait(4 * 60 * 60 * 1000);
    transcript.world("app_opened");
    transcript.connect();
    transcript.wait(6000);
    transcript.cancelAsk(juno);
    return transcript;
  },

  () => {
    const transcript = createTranscript({
      name: "23-your-own-way-then-stop",
      scenario: 23,
      title: "Your own way, then Stop",
      summary:
        "Instead of picking an option you write something else; any message counts as the answer, so the " +
        "server marks it as answering the ask. The agent asks again, and this time you tap Stop: the ask " +
        "ends as cancelled.",
      guarantees: ["G16"],
    });
    yesterday(transcript);
    transcript.begin(todayAt, { cursor: "latest" });
    transcript.connect();
    transcript.wait(2000);
    sendAndStart(transcript, "Book Juno for Saturday.");
    transcript.wait(300);
    askWhichJuno(transcript);
    transcript.endTurn("completed");
    transcript.wait(6000);
    const instead = transcript.send("Actually, find somewhere new in Brixton instead.");
    transcript.startTurn([instead]);
    transcript.wait(300);
    transcript.step("web_search", searching("new restaurants Brixton"));
    transcript.wait(1500);
    const time = transcript.ask({
      question: "Same time, Saturday at 7:30?",
      options: [{ label: "Yes" }, { label: "Any time that evening" }],
    });
    transcript.endTurn("completed");
    transcript.wait(5000);
    transcript.cancelAsk(time);
    return transcript;
  },

  () => {
    const transcript = createTranscript({
      name: "26-turning-on-notifications",
      scenario: 26,
      title: "Turning on notifications",
      summary:
        "At the first longer task, Ari offers a nudge and you allow notifications. The app registers the " +
        "device with its push token and notification key, and when you've left, the finished reply notifies " +
        "you.",
      guarantees: ["G15", "G18"],
    });
    yesterday(transcript);
    transcript.begin(todayAt, { cursor: "latest" });
    transcript.connect();
    transcript.wait(2000);
    sendAndStart(transcript, "Go through my notes and tidy up the packing lists for the weekend.");
    transcript.wait(300);
    transcript.step("thinking", thinking);
    transcript.wait(4000);
    transcript.world("notifications_allowed");
    transcript.registerDevice();
    transcript.step("command", {
      title: "Reading 3 files",
      endedTitle: "Read 3 files",
      fields: {
        command: "cat notes/packing-*.md",
        cwd: "/home/you/.ito/workspace",
        actions: [
          { type: "read", path: "notes/packing-saturday.md" },
          { type: "read", path: "notes/packing-sunday.md" },
          { type: "read", path: "notes/packing-old.md" },
        ],
      },
    });
    transcript.wait(900);
    transcript.endStep({ fields: { exit_code: 0 } });
    transcript.disconnect("app_closed");
    transcript.step("file_change", {
      title: "Editing 2 files",
      endedTitle: "Edited 2 files",
      fields: {
        files: [
          { path: "notes/packing-saturday.md", change: "modified", lines_added: 4, lines_removed: 2 },
          { path: "notes/packing-old.md", change: "deleted" },
        ],
      },
    });
    transcript.wait(1500);
    transcript.endStep();
    writeWhole(
      transcript,
      "**Tidied.** Saturday's list now has the rain jacket and the bus card, and the old list is gone.",
    );
    transcript.endTurn("completed");
    transcript.wait(3 * 60 * 1000);
    transcript.world("app_opened", { from: "notification" });
    transcript.connect();
    return transcript;
  },

  () => {
    const transcript = createTranscript({
      name: "27-send-a-photo",
      scenario: 27,
      title: "Send a photo",
      summary:
        "The app uploads a photo under an id it made, then sends a message naming it. The message carries " +
        "the photo's name, type, size and dimensions, and the agent sees the image itself.",
      guarantees: ["G19"],
    });
    yesterday(transcript);
    transcript.begin(todayAt, { cursor: "latest" });
    transcript.connect();
    transcript.wait(2000);
    const photo = transcript.upload("riverside.jpg");
    transcript.wait(200);
    const question = transcript.send("Is this the Thames Path, near Hampton Court?", { attachments: [photo] });
    transcript.startTurn([question]);
    transcript.wait(300);
    transcript.step("thinking", thinking);
    transcript.wait(2400);
    writeWhole(
      transcript,
      "Yes: that's the towpath on the Surrey bank, just upstream of the palace. Keep the river on your " +
        "right and you'll reach the bridge in about ten minutes.",
    );
    transcript.endTurn("completed");
    return transcript;
  },

  () => {
    const transcript = createTranscript({
      name: "28-send-a-file",
      scenario: 28,
      title: "Send a file",
      summary:
        "A file attached to a message lands in the agent's workspace as uploads/ and its name, and the " +
        "agent reads it there like any other file.",
      guarantees: ["G19"],
    });
    yesterday(transcript);
    transcript.begin(todayAt, { cursor: "latest" });
    transcript.connect();
    transcript.wait(2000);
    const log = transcript.upload("running-log.csv");
    transcript.wait(200);
    const question = transcript.send("How far did I run this month?", { attachments: [log] });
    transcript.startTurn([question]);
    transcript.wait(300);
    transcript.step("command", {
      title: "Reading running-log.csv",
      endedTitle: "Read running-log.csv",
      fields: {
        command: "cat uploads/running-log.csv",
        cwd: "/home/you/.ito/workspace",
        actions: [{ type: "read", path: "uploads/running-log.csv" }],
      },
    });
    transcript.wait(400);
    transcript.endStep({
      fields: {
        exit_code: 0,
        output: "date,distance_km,time\n2026-10-03,12.0,1:04:10\n2026-10-07,8.5,0:44:52\n2026-10-11,18.0,1:39:37\n",
      },
    });
    writeWhole(transcript, "38.5 km over three runs. The longest was 18 km on the 11th, in 1:39:37.");
    transcript.endTurn("completed");
    return transcript;
  },

  () => {
    const transcript = createTranscript({
      name: "29-an-upload-that-fails",
      scenario: 29,
      title: "An upload that fails",
      summary:
        "A video over 20 MB is refused as too large. A photo's upload succeeds but its answer is lost, so " +
        "the app uploads it again under the same id and gets the same attachment; a message with only the " +
        "photo and no text follows. Later, a file waits in a draft for two days, past the day the server " +
        "keeps an upload no message names, so sending is refused as attachment_missing until the app " +
        "uploads it again.",
      guarantees: ["G2", "G19"],
    });
    yesterday(transcript);
    transcript.begin(todayAt, { cursor: "latest" });
    transcript.connect();
    transcript.wait(2000);
    transcript.uploadTooLarge("harbour.mov", 21_000_000);
    transcript.wait(4000);
    const photo = transcript.upload("riverside.jpg", { isLost: true });
    transcript.wait(3000);
    transcript.upload("riverside.jpg", { id: photo });
    transcript.wait(200);
    const message = transcript.send("", { attachments: [photo] });
    transcript.startTurn([message]);
    transcript.wait(300);
    transcript.step("thinking", thinking);
    transcript.wait(1800);
    writeWhole(transcript, "The river at Hampton Court on a clear morning. Want me to plan a walk from there?");
    transcript.endTurn("completed");
    transcript.wait(5 * 60 * 1000);
    const log = transcript.upload("running-log.csv");
    transcript.wait(1000);
    transcript.disconnect("app_closed");
    transcript.wait(2 * 24 * 60 * 60 * 1000);
    transcript.forgetUnsentUploads();
    transcript.world("app_opened");
    transcript.connect();
    transcript.wait(4000);
    const question = transcript.send("Which of these runs had my fastest pace?", { attachments: [log] });
    transcript.wait(300);
    transcript.upload("running-log.csv", { id: log });
    transcript.wait(200);
    transcript.send("Which of these runs had my fastest pace?", { id: question, attachments: [log] });
    transcript.startTurn([question]);
    transcript.wait(300);
    transcript.step("command", {
      title: "Reading running-log.csv",
      endedTitle: "Read running-log.csv",
      fields: {
        command: "cat uploads/running-log.csv",
        cwd: "/home/you/.ito/workspace",
        actions: [{ type: "read", path: "uploads/running-log.csv" }],
      },
    });
    transcript.wait(400);
    transcript.endStep({
      fields: {
        exit_code: 0,
        output: "date,distance_km,time\n2026-10-03,12.0,1:04:10\n2026-10-07,8.5,0:44:52\n2026-10-11,18.0,1:39:37\n",
      },
    });
    writeWhole(transcript, "The 7th: 8.5 km in 44:52, about 5:17 a kilometre.");
    transcript.endTurn("completed");
    return transcript;
  },

  () => {
    const transcript = createTranscript({
      name: "30-another-device-sees-an-attachment",
      scenario: 30,
      title: "Another device sees an attachment",
      summary:
        "A photo sent from the phone yesterday arrives on another device in its first snapshot, as part of " +
        "the message. That device fetches the bytes once and keeps them.",
      guarantees: ["G13", "G19"],
    });
    transcript.time(yesterdayAt);
    transcript.exchange(
      "Is this the Thames Path, near Hampton Court?",
      "Yes: that's the towpath on the Surrey bank, just upstream of the palace.",
      ["riverside.jpg"],
    );
    transcript.begin(todayAt);
    transcript.connect();
    transcript.wait(800);
    transcript.fetchAttachment(firstAttachment(transcript));
    return transcript;
  },

  () => {
    const transcript = createTranscript({
      name: "31-pair-with-a-qr-code",
      scenario: 31,
      title: "Pair with a QR code",
      summary:
        "ito pair shows a QR code holding the address and a short-lived code. The app exchanges the code " +
        "for a token of its own and connects with it; the same code is refused afterwards.",
      guarantees: ["G11", "G20"],
    });
    const pairedToken = "ito_paired_example_not_a_real_token_000000000000000";
    transcript.begin(todayAt);
    transcript.showPairingCode("7F3K-92QD");
    transcript.wait(9000);
    transcript.request("GET", "/.well-known/ito");
    transcript.response(200, { product: "ito", protocol: [protocol] }, { headers: { "Ito-Protocol": protocol } });
    transcript.wait(300);
    transcript.pair("7F3K-92QD", "iPhone", pairedToken);
    transcript.wait(200);
    transcript.request("GET", "/v0/server", { headers: { Authorization: `Bearer ${pairedToken}` } });
    transcript.response(
      200,
      {
        name: "studio",
        version: serverVersion,
        protocol,
        lead: { name: "Kumo" },
        time_zone: "UTC",
        agent: {},
        setup: { notifications: false, memory_backup: false },
        capabilities: [],
      },
      { headers: { "Ito-Protocol": protocol } },
    );
    transcript.wait(60_000);
    transcript.pair("7F3K-92QD", "iPad", "unused");
    return transcript;
  },

  () => {
    const transcript = createTranscript({
      name: "32-set-up-a-capability",
      scenario: 32,
      title: "Set up a capability",
      summary:
        "Settings lists the capabilities installed with the server. You switch Reports on and connect GitHub: " +
        "the server gives a code, you approve it on GitHub, where you're already signed in, and GitHub hands " +
        "the token to the server, which turns Reports on. The token never reaches the app, only that one is set.",
      guarantees: ["G21"],
    });
    transcript.begin(todayAt);
    capabilityCall(transcript, "GET", "/v0/capabilities", undefined, 200, {
      capabilities: [reports("off", false), ...sourcesOff],
    });
    transcript.wait(4000);
    capabilityCall(transcript, "PUT", "/v0/capabilities/reports", { on: true }, 200, reports("setup", false));
    transcript.wait(3000);
    capabilityCall(transcript, "POST", "/v0/capabilities/reports/connect", undefined, 200, {
      code: "WDJB-MJHT",
      url: "https://github.com/login/device",
      expires_at: "2026-10-12T08:56:07.120Z",
    });
    transcript.wait(3000);
    transcript.world("you_approve", { code: "WDJB-MJHT" });
    transcript.wait(7000);
    capabilityCall(transcript, "GET", "/v0/capabilities", undefined, 200, {
      capabilities: [reports("on", true), ...sourcesOff],
    });
    transcript.wait(300);
    transcript.request("GET", "/v0/server");
    transcript.wait(40);
    transcript.response(
      200,
      {
        name: "studio",
        version: serverVersion,
        protocol,
        lead: { name: "Kumo" },
        time_zone: "UTC",
        agent: {},
        setup: { notifications: false, memory_backup: false },
        capabilities: [{ id: "reports", version: "0.2" }],
      },
      { headers: { "Ito-Protocol": protocol } },
    );
    return transcript;
  },
  () => {
    const transcript = createTranscript({
      name: "33-a-capability-needs-you",
      scenario: 33,
      title: "A capability needs you",
      summary:
        "Reports is on, but GitHub rejects its token, so Settings shows it as needing you and says why. A setup " +
        "it can't take is refused with the reason; a new token brings it back, and switching it off takes " +
        "effect at once.",
      guarantees: ["G21"],
    });
    transcript.begin(todayAt);
    capabilityCall(transcript, "PUT", "/v0/capabilities/reports", { on: true }, 200, reports("setup", false));
    transcript.wait(15_000);
    capabilityCall(
      transcript,
      "PUT",
      "/v0/capabilities/reports/setup",
      { values: { token: "github_pat_revoked" } },
      200,
      reports("needs_you", true, "GitHub rejected the token."),
    );
    transcript.wait(20_000);
    capabilityCall(transcript, "PUT", "/v0/capabilities/reports/setup", { values: { token: true } }, 400, {
      error: { code: "invalid_request", message: "Ito can't save that setup.", detail: "token takes text." },
    });
    transcript.wait(8000);
    capabilityCall(
      transcript,
      "PUT",
      "/v0/capabilities/reports/setup",
      { values: { token: "github_pat_example" } },
      200,
      reports("on", true),
    );
    transcript.wait(30_000);
    capabilityCall(transcript, "PUT", "/v0/capabilities/reports", { on: false }, 200, reports("off", true));
    transcript.wait(2000);
    capabilityCall(transcript, "PUT", "/v0/capabilities/calendar", { on: true }, 404, {
      error: {
        code: "not_found",
        message: "The server doesn't know that.",
        detail: "No capability called calendar is installed.",
      },
    });
    return transcript;
  },

  () => {
    const transcript = createTranscript({
      name: "34-ari-uses-what-it-remembers",
      scenario: 34,
      title: "Ari uses what it remembers",
      summary:
        "Ari recalls the Lisbon trip and Alex before answering. The trail names the pages it used, never " +
        "their content, and Ari checks once before acting on what it last heard. The app then opens Alex's " +
        "page and what's in Ari's mind.",
      guarantees: ["G14", "G22"],
    });
    const seededAt = "2026-10-26T19:00:00.000Z";
    transcript.begin(seededAt);
    transcript.world("memory_holds", { pages: [alexBefore, lisbonTrip, nowPage] });
    transcript.wait(5 * 60 * 1000);
    transcript.connect();
    transcript.wait(2000);
    sendAndStart(transcript, "Should I book the hotel in Lisbon for both of us?");
    transcript.wait(700);
    agentCalls(transcript, "recall", { query: "Lisbon trip hotel with Alex" });
    memoryStep(
      transcript,
      "used",
      [
        { address: alexBefore.address, title: "Alex" },
        { address: lisbonTrip.address, title: "Lisbon trip" },
      ],
      { title: "Using Alex · Lisbon trip", endedTitle: "Used Alex · Lisbon trip" },
    );
    transcript.wait(500);
    writeWhole(
      transcript,
      "Last I heard, you and Alex were taking it slow (as of 15 Oct). Is that still the case? If it is, " +
        "I'd look at places with two rooms for 14 to 18 November.",
    );
    transcript.endTurn("completed");
    transcript.wait(6000);
    memoryCall(transcript, "/v0/memory/page?address=memory:people/alex", pageBody(alexBefore, seededAt));
    transcript.wait(4000);
    memoryCall(transcript, "/v0/memory/in-mind", {
      pages: [{ ...pageBody(nowPage, seededAt), shelf: "now" }],
    });
    return transcript;
  },

  () => {
    const transcript = createTranscript({
      name: "35-ari-updates-what-it-knows",
      scenario: 35,
      title: "Ari updates what it knows",
      summary:
        "You tell Ari things have moved on with Alex. Ari reads the page, rewrites the present and moves the " +
        "old state to Earlier, keeps a note for tonight's journal, and says so. Tapping the update shows the " +
        "page before and after.",
      guarantees: ["G14", "G22"],
    });
    const seededAt = "2026-10-26T19:00:00.000Z";
    transcript.begin(seededAt);
    transcript.world("memory_holds", { pages: [alexBefore] });
    transcript.wait(70 * 60 * 1000);
    transcript.connect();
    transcript.wait(2000);
    sendAndStart(transcript, "Alex and I are seeing each other a lot now. It's going really well!");
    transcript.wait(600);
    agentCalls(transcript, "read_page", { address: alexBefore.address });
    memoryStep(transcript, "used", [{ address: alexBefore.address, title: "Alex" }], {
      title: "Using Alex",
      endedTitle: "Used Alex",
    });
    transcript.wait(900);
    const change = transcript.change();
    agentCalls(transcript, "edit_page", {
      address: alexNow.address,
      version: seededVersion,
      old_text: "Taking things slow; you've been on two dates (as of 15 Oct).\n\n## Earlier\n\n",
      new_text:
        "Seeing each other a lot, and it's going really well (as of 26 Oct).\n\n## Earlier\n\n" +
        "- 15 Oct: decided to take things slow.\n",
      gist: alexNow.gist,
      note: "Seeing each other a lot now",
    });
    memoryStep(
      transcript,
      "updated",
      [{ address: alexNow.address, title: "Alex" }],
      { title: "Updating Alex", endedTitle: "Updated Alex" },
      change,
    );
    transcript.wait(400);
    agentCalls(transcript, "note_day", {
      text: "Things with Alex are going really well: we're seeing a lot of each other.",
      yours: true,
    });
    transcript.wait(300);
    writeWhole(transcript, "That's lovely to hear. I've updated Alex's page, so taking it slow is now history.");
    transcript.endTurn("completed");
    transcript.wait(5000);
    const updatedAt = new Date(Date.parse(seededAt) + 70 * 60 * 1000 + 2000 + 600 + 900).toISOString();
    memoryCall(transcript, `/v0/memory/changes/${change}`, {
      change,
      address: alexNow.address,
      title: "Alex",
      at: updatedAt,
      before: alexBefore.markdown,
      after: alexNow.markdown,
    });
    return transcript;
  },

  () => {
    const transcript = createTranscript({
      name: "36-forget-that",
      scenario: 36,
      title: "Forget that",
      summary:
        "You ask Ari to forget part of a page. Ari edits it out of the page, as an ordinary update, and " +
        "the Library shows the change first among what Ari changed lately, with Ari's note on it.",
      guarantees: ["G14", "G22"],
    });
    const seededAt = "2026-10-26T20:00:00.000Z";
    const alexForgotten = {
      ...alexNow,
      links: [],
      markdown:
        "Seeing each other a lot, and it's going really well (as of 26 Oct).\n\n## Earlier\n\n" +
        "- 15 Oct: decided to take things slow.\n",
    };
    transcript.begin(seededAt);
    transcript.world("memory_holds", {
      pages: [
        { ...alexNow, note: "Seeing each other a lot now" },
        { ...nowPage, note: "Training for Valencia" },
      ],
    });
    transcript.wait(30 * 60 * 1000);
    transcript.connect();
    transcript.wait(2000);
    sendAndStart(transcript, "Please forget the bit about our first date.");
    transcript.wait(800);
    const change = transcript.change();
    agentCalls(transcript, "edit_page", {
      address: alexForgotten.address,
      version: seededVersion,
      old_text: "\n- 12 Oct: first date, Dishoom Shoreditch.",
      new_text: "",
      note: "Forgot the first date",
      links: alexForgotten.links,
    });
    memoryStep(
      transcript,
      "updated",
      [{ address: alexForgotten.address, title: "Alex" }],
      { title: "Updating Alex", endedTitle: "Updated Alex" },
      change,
    );
    transcript.wait(300);
    writeWhole(transcript, "Done. It's gone from Alex's page.");
    transcript.endTurn("completed");
    transcript.wait(4000);
    const updatedAt = new Date(Date.parse(seededAt) + 30 * 60 * 1000 + 2000 + 800).toISOString();
    memoryCall(transcript, `/v0/memory/changes/${change}`, {
      change,
      address: alexForgotten.address,
      title: "Alex",
      at: updatedAt,
      before: alexNow.markdown,
      after: alexForgotten.markdown,
    });
    transcript.wait(3000);
    memoryCall(transcript, "/v0/memory/recent", {
      changes: [
        { change, address: alexForgotten.address, title: "Alex", at: updatedAt, note: "Forgot the first date" },
        {
          change: transcript.change(),
          address: nowPage.address,
          title: "Now",
          at: seededAt,
          note: "Training for Valencia",
        },
        {
          change: transcript.change(),
          address: alexNow.address,
          title: "Alex",
          at: seededAt,
          note: "Seeing each other a lot now",
        },
      ],
    });
    transcript.wait(2000);
    memoryCall(transcript, "/v0/memory/shelves", {
      shelves: [
        { shelf: "people", count: 1 },
        { shelf: "groups", count: 0 },
        { shelf: "goals", count: 0 },
        { shelf: "projects", count: 0 },
        { shelf: "places", count: 0 },
        { shelf: "topics", count: 0 },
        { shelf: "journal", count: 0 },
      ],
    });
    return transcript;
  },

  () => {
    const transcript = createTranscript({
      name: "37-choose-the-model",
      scenario: 37,
      title: "Choose the model",
      summary:
        "Settings lists the models the engine offers and how hard each can think, with the current choice. You " +
        "pick a lighter model at a middling effort; an effort it doesn't have is refused with the reason, and " +
        "the server names the new choice from then on.",
      guarantees: ["G10"],
    });
    transcript.begin(todayAt);
    transcript.request("GET", "/v0/models");
    transcript.wait(300);
    transcript.response(
      200,
      { models: demoModels, chosen: { model: "gpt-6.1-sol", effort: "low" } },
      { headers: { "Ito-Protocol": protocol } },
    );
    transcript.wait(5000);
    transcript.request("PUT", "/v0/agent", { body: { model: "gpt-6-luna", effort: "ultra" } });
    transcript.wait(200);
    transcript.response(
      400,
      {
        error: {
          code: "invalid_request",
          message: "Ito can't run on that.",
          detail: "GPT-6-Luna can't think at ultra: choose low, medium, high, xhigh or max.",
        },
      },
      { headers: { "Ito-Protocol": protocol } },
    );
    transcript.wait(3000);
    transcript.request("PUT", "/v0/agent", { body: { model: "gpt-6-luna", effort: "medium" } });
    transcript.wait(200);
    transcript.response(200, { model: "gpt-6-luna", effort: "medium" }, { headers: { "Ito-Protocol": protocol } });
    transcript.wait(400);
    transcript.request("GET", "/v0/server");
    transcript.wait(40);
    transcript.response(
      200,
      {
        name: "studio",
        version: serverVersion,
        protocol,
        lead: { name: "Kumo" },
        time_zone: "UTC",
        agent: { model: "gpt-6-luna", effort: "medium" },
        setup: { notifications: false, memory_backup: false },
        capabilities: [],
      },
      { headers: { "Ito-Protocol": protocol } },
    );
    return transcript;
  },

  () => {
    const transcript = createTranscript({
      name: "38-a-walk-with-ari",
      scenario: 38,
      title: "A walk with Ari",
      summary:
        "You start a call for a walk and stream it. The server hears your turn, shows it live, and posts it as a " +
        "spoken message with its recording; Ari's note and reply are spoken a sentence at a time up to the --- " +
        "line, the phone says when each has played, and hanging up ends the call with its length.",
      guarantees: ["G23", "G25", "G26"],
    });
    transcript.begin("2026-10-26T07:30:00.000Z");
    transcript.connect();
    transcript.wait(1500);
    const call = transcript.startCall();
    transcript.wait(300);
    transcript.openStream(call);
    transcript.wait(6000);
    const user = transcript.youSay("walk-question.pcm", "What did Leo say about the Halcyon panel?", {
      heard: ["What did Leo", "What did Leo say about the"],
    });
    transcript.startTurn([user]);
    transcript.wait(400);
    transcript.step("thinking", thinking);
    transcript.wait(900);
    transcript.endStep();
    transcript.reply("note");
    transcript.write("Let me check what I have on Leo.", { pieces: 1 });
    transcript.endMessage("completed");
    transcript.wait(300);
    transcript.played("s1");
    transcript.wait(1200);
    writeWhole(
      transcript,
      "He wants one more round on your design before the panel sits in November. I've put what he " +
        "asked for in the chat.\n---\n- Tighten the intro\n- Add the latency numbers",
      1,
    );
    transcript.endTurn("completed");
    transcript.wait(5000);
    transcript.played("s2");
    transcript.wait(4000);
    transcript.played("s3");
    transcript.wait(24 * 60 * 1000);
    transcript.hangUp();
    return transcript;
  },

  () => {
    const transcript = createTranscript({
      name: "40-delete-a-call-s-audio",
      scenario: 40,
      title: "Delete a call's audio",
      summary:
        "After a journalling walk you delete the call's recordings from its block. The words stay in the " +
        "conversation, and every app learns the audio is gone.",
      guarantees: ["G23"],
    });
    transcript.begin("2026-10-26T19:00:00.000Z");
    transcript.connect();
    transcript.wait(1000);
    const call = transcript.startCall();
    transcript.wait(300);
    transcript.openStream(call);
    transcript.wait(5000);
    const user = transcript.youSay("journal-turn.pcm", "Today was a good day. The long run felt easy.");
    transcript.startTurn([user]);
    transcript.wait(900);
    writeWhole(transcript, "That's a lovely one to end on. I've added it to today's journal.", 1);
    transcript.endTurn("completed");
    transcript.wait(3000);
    transcript.played("s1");
    transcript.wait(2500);
    transcript.played("s2");
    transcript.wait(3 * 60 * 1000);
    transcript.hangUp();
    transcript.wait(20 * 60 * 1000);
    transcript.deleteCallAudio(call);
    transcript.wait(500);
    transcript.disconnect("app_closed");
    transcript.wait(60_000);
    transcript.world("app_opened");
    transcript.connect();
    return transcript;
  },

  () => {
    const transcript = createTranscript({
      name: "41-another-device-sees-the-call",
      scenario: 41,
      title: "Another device sees the call",
      summary:
        "A walk earlier this morning was a call with one spoken message. Ari on another device connects for the " +
        "first time, and its snapshot carries the call before the message it opened, with its recording.",
      guarantees: ["G13", "G23"],
    });
    transcript.time("2026-10-26T07:30:00.000Z");
    transcript.callExchange(
      "What did Leo say about the Halcyon panel?",
      "He wants one more round on your design before the panel sits in November.",
      "walk-turn.m4a",
    );
    transcript.begin("2026-10-26T09:00:00.000Z");
    transcript.connect();
    return transcript;
  },

  () => {
    const transcript = createTranscript({
      name: "42-choose-ari-s-voice",
      scenario: 42,
      title: "Choose Ari's voice",
      summary:
        "Settings lists Ari's voices and the one chosen, plays a preview of another, and chooses it for the whole " +
        "server; a preview that names no voice then speaks in it, and a voice the server doesn't have is refused.",
      guarantees: ["G10"],
    });
    const headers = { headers: { "Ito-Protocol": protocol } };
    transcript.begin("2026-10-27T18:00:00.000Z");
    transcript.request("GET", "/v0/voices");
    transcript.wait(40);
    transcript.response(200, { voices, chosen: defaultVoice, state: "ready", voiceprint: "learning" }, headers);
    transcript.wait(6000);
    speak(transcript, "bf_emma");
    transcript.wait(4000);
    transcript.request("PUT", "/v0/voice", { body: { voice: "bf_emma" } });
    transcript.wait(20);
    transcript.response(200, { voice: "bf_emma" }, headers);
    transcript.wait(2000);
    transcript.request("GET", "/v0/voices");
    transcript.wait(40);
    transcript.response(200, { voices, chosen: "bf_emma", state: "ready", voiceprint: "learning" }, headers);
    transcript.wait(3000);
    speak(transcript);
    transcript.wait(10_000);
    transcript.request("PUT", "/v0/voice", { body: { voice: "zz_nobody" } });
    transcript.wait(20);
    transcript.response(
      400,
      {
        error: {
          code: "invalid_request",
          message: "The request isn't valid.",
          detail: "There's no voice called zz_nobody: choose one from GET /v0/voices.",
        },
      },
      headers,
    );
    return transcript;
  },

  () => {
    const transcript = createTranscript({
      name: "43-before-the-voice-is-ready",
      scenario: 43,
      title: "Before the voice is ready",
      summary:
        "Ari connects while the server's voice is still loading, so it doesn't offer Talk yet and a preview is " +
        "refused with when to try again. The event stream says when the voice is ready, and the preview plays.",
      guarantees: ["G10", "G24"],
    });
    const headers = { headers: { "Ito-Protocol": protocol } };
    const loading = "The voice models are still loading.";
    transcript.begin("2026-10-27T08:00:00.000Z");
    transcript.voiceStatus("loading", loading);
    transcript.connect();
    transcript.request("GET", "/v0/voices");
    transcript.wait(40);
    transcript.response(
      200,
      { voices, chosen: defaultVoice, state: "loading", reason: loading, voiceprint: "learning" },
      headers,
    );
    transcript.wait(2000);
    transcript.request("POST", "/v0/speech", { body: { text: preview } });
    transcript.wait(20);
    transcript.response(
      503,
      { error: { code: "unavailable", message: "Ari's voice isn't ready.", detail: loading } },
      { headers: { "Ito-Protocol": protocol, "Retry-After": "10" } },
    );
    transcript.wait(25_000);
    transcript.voiceStatus("ready");
    transcript.wait(3000);
    speak(transcript);
    return transcript;
  },

  () => {
    const transcript = createTranscript({
      name: "44-when-the-server-can-t-talk",
      scenario: 44,
      title: "When the server can't talk",
      summary:
        "The server's voice fails, and the event stream says why in a line, so Ari stops offering Talk and shows " +
        "the reason. The voice list carries the same reason, and a preview is refused with it.",
      guarantees: ["G10", "G24"],
    });
    const headers = { headers: { "Ito-Protocol": protocol } };
    const reason = "The GPU ran out of memory loading the voice.";
    transcript.begin("2026-10-27T09:00:00.000Z");
    transcript.connect();
    transcript.wait(60_000);
    transcript.voiceStatus("failed", reason);
    transcript.wait(5000);
    transcript.request("GET", "/v0/voices");
    transcript.wait(40);
    transcript.response(
      200,
      { voices, chosen: defaultVoice, state: "failed", reason, voiceprint: "learning" },
      headers,
    );
    transcript.wait(4000);
    transcript.request("POST", "/v0/speech", { body: { text: preview, voice: "am_michael" } });
    transcript.wait(20);
    transcript.response(
      503,
      { error: { code: "unavailable", message: "Ari's voice isn't ready.", detail: reason } },
      headers,
    );
    return transcript;
  },

  () => {
    const transcript = createTranscript({
      name: "45-talking-over-ari",
      scenario: 45,
      title: "Talking over Ari",
      summary:
        "Ari is still speaking its reply when you start to talk. The server stops its voice at once, the phone " +
        "drops what it hadn't played, and your words become the next turn.",
      guarantees: ["G25", "G26"],
    });
    transcript.begin("2026-10-27T07:40:00.000Z");
    transcript.connect();
    transcript.wait(1000);
    const call = transcript.startCall();
    transcript.wait(300);
    transcript.openStream(call);
    transcript.wait(4000);
    const asked = transcript.youSay("walk-question.pcm", "When's the design review?");
    transcript.startTurn([asked]);
    transcript.wait(900);
    writeWhole(transcript, "It's on Wednesday at ten. Hana and Leo will both be there.", 1);
    transcript.endTurn("completed");
    transcript.wait(800);
    const cut = transcript.unplayed();
    const followUp = transcript.youSay("walk-follow-up.pcm", "Actually, can we move it to Thursday?");
    transcript.startTurn([followUp]);
    transcript.wait(50);
    for (const sentence of cut) transcript.played(sentence, true);
    transcript.wait(900);
    writeWhole(transcript, "I'll ask Hana for Thursday.", 1);
    transcript.endTurn("completed");
    transcript.wait(2000);
    for (const sentence of transcript.unplayed()) transcript.played(sentence);
    transcript.wait(30_000);
    transcript.hangUp();
    return transcript;
  },

  () => {
    const transcript = createTranscript({
      name: "46-a-blip-in-the-signal",
      scenario: 46,
      title: "A blip in the signal",
      summary:
        "The signal drops for a few seconds while Ari is speaking. The call stays on: the phone reconnects to the " +
        "same stream, the server says where the call stands, and the walk carries on.",
      guarantees: ["G27"],
    });
    transcript.begin("2026-10-27T08:15:00.000Z");
    transcript.connect();
    transcript.wait(1000);
    const call = transcript.startCall();
    transcript.wait(300);
    transcript.openStream(call);
    transcript.wait(4000);
    const asked = transcript.youSay("walk-question.pcm", "Remind me what's for dinner.");
    transcript.startTurn([asked]);
    transcript.wait(900);
    writeWhole(transcript, "Pasta with the leftover pesto. You bought basil yesterday.", 1);
    transcript.endTurn("completed");
    transcript.wait(400);
    transcript.disconnect("offline");
    transcript.wait(6000);
    transcript.world("online");
    transcript.connect();
    transcript.wait(200);
    transcript.openStream(call);
    transcript.wait(3000);
    const again = transcript.youSay("walk-follow-up.pcm", "Say that again?");
    transcript.startTurn([again]);
    transcript.wait(900);
    writeWhole(transcript, "Pasta with the leftover pesto.", 1);
    transcript.endTurn("completed");
    transcript.wait(2000);
    for (const sentence of transcript.unplayed()) transcript.played(sentence);
    transcript.wait(10_000);
    transcript.hangUp();
    return transcript;
  },

  () => {
    const transcript = createTranscript({
      name: "47-the-connection-drops",
      scenario: 47,
      title: "The connection drops",
      summary:
        "The phone loses its connection mid-call and doesn't get it back within 20 seconds, so the server ends " +
        "the call with a plain reason. What you said is kept, and the phone sees why once it's back.",
      guarantees: ["G27"],
    });
    transcript.begin("2026-10-27T08:40:00.000Z");
    transcript.connect();
    transcript.wait(1000);
    const call = transcript.startCall();
    transcript.wait(300);
    transcript.openStream(call);
    transcript.wait(4000);
    const asked = transcript.youSay("walk-question.pcm", "Add oat milk to the shopping list.");
    transcript.startTurn([asked]);
    transcript.wait(900);
    writeWhole(transcript, "Added.", 1);
    transcript.endTurn("completed");
    transcript.wait(600);
    transcript.played("s1");
    transcript.wait(5000);
    transcript.disconnect("offline");
    transcript.wait(20_000);
    transcript.streamTimesOut();
    transcript.wait(40_000);
    transcript.world("online");
    transcript.connect();
    return transcript;
  },

  () => {
    const transcript = createTranscript({
      name: "48-mute",
      scenario: 48,
      title: "Mute",
      summary:
        "You ask something and mute to cough before the pause that would end your turn. Muting ends it at once, " +
        "so Ari answers while you cough. The server hears nothing while you're muted, and when you unmute your " +
        "next words are an ordinary turn.",
      guarantees: ["G25"],
    });
    transcript.begin("2026-10-27T09:05:00.000Z");
    transcript.connect();
    transcript.wait(1000);
    const call = transcript.startCall();
    transcript.wait(300);
    transcript.openStream(call);
    transcript.wait(3000);
    const asked = transcript.youSay("walk-question.pcm", "What time is it in Lisbon?", {
      heard: ["What time is it"],
      mutedMidway: true,
    });
    transcript.startTurn([asked]);
    transcript.wait(100);
    transcript.appAudio("cough.pcm");
    transcript.wait(800);
    writeWhole(transcript, "It's just after nine there.", 1);
    transcript.endTurn("completed");
    transcript.wait(700);
    transcript.appFrame({ type: "unmute" });
    transcript.wait(800);
    transcript.played("s1");
    transcript.wait(2000);
    const thanks = transcript.youSay("walk-follow-up.pcm", "Thanks.");
    transcript.startTurn([thanks]);
    transcript.wait(900);
    writeWhole(transcript, "Any time.", 1);
    transcript.endTurn("completed");
    transcript.wait(1500);
    transcript.played("s2");
    transcript.wait(10_000);
    transcript.hangUp();
    return transcript;
  },

  () => {
    const transcript = createTranscript({
      name: "49-the-voice-fails-mid-call",
      scenario: 49,
      title: "The voice fails mid-call",
      summary:
        "The server's voice fails during a call. The stream says why, the call ends with that reason, and a " +
        "reconnect is refused with it, so Ari stops offering Talk instead of carrying on worse.",
      guarantees: ["G10", "G24", "G27"],
    });
    const reason = "The voice failed while listening: CUDA out of memory.";
    transcript.begin("2026-10-27T09:30:00.000Z");
    transcript.connect();
    transcript.wait(1000);
    const call = transcript.startCall();
    transcript.wait(300);
    transcript.openStream(call);
    transcript.wait(4000);
    const asked = transcript.youSay("walk-question.pcm", "What's on tomorrow?");
    transcript.startTurn([asked]);
    transcript.wait(900);
    writeWhole(transcript, "A dentist at nine, then the design review.", 1);
    transcript.endTurn("completed");
    transcript.wait(1500);
    transcript.played("s1");
    transcript.wait(8000);
    transcript.voiceFails(reason);
    transcript.wait(2000);
    transcript.request("GET", `/v0/calls/${call}/stream`);
    transcript.wait(20);
    transcript.response(
      404,
      { error: { code: "not_found", message: "The server doesn't know that.", detail: `No call ${call} is on.` } },
      { headers: { "Ito-Protocol": protocol } },
    );
    return transcript;
  },

  () => {
    const transcript = createTranscript({
      name: "50-ari-says-what-it-s-doing",
      scenario: 50,
      title: "Ari says what it's doing",
      summary:
        "After your turn the phone chimes, and the tone covers the silence while Ari works. Only after a long " +
        "quiet does Ari say what it's doing, once, then it answers.",
      guarantees: ["G26"],
    });
    transcript.begin("2026-10-27T10:00:00.000Z");
    transcript.connect();
    transcript.wait(1000);
    const call = transcript.startCall();
    transcript.wait(300);
    transcript.openStream(call);
    transcript.wait(3000);
    const asked = transcript.youSay("walk-question.pcm", "Find me a quiet café near Brighton station.");
    transcript.startTurn([asked]);
    transcript.wait(500);
    transcript.step("web_search", searching("quiet cafés near Brighton station"));
    transcript.wait(8500);
    transcript.speak(["Searching the web for quiet cafés near Brighton station"]);
    transcript.wait(1500);
    transcript.played(transcript.unplayed()[0] ?? "s1");
    transcript.wait(6000);
    transcript.endStep();
    writeWhole(transcript, "Try Small Batch on Queens Road. It's quiet before noon.", 1);
    transcript.endTurn("completed");
    transcript.wait(3000);
    for (const sentence of transcript.unplayed()) transcript.played(sentence);
    transcript.wait(10_000);
    transcript.hangUp();
    return transcript;
  },

  () => {
    const transcript = createTranscript({
      name: "51-asked-on-a-call",
      scenario: 51,
      title: "Asked on a call",
      summary:
        "On a call, Ari asks for approval: the server says the preview, the question and the choices aloud, " +
        "and your next words answer it, so the reminder is added without looking at the phone.",
      guarantees: ["G25", "G26"],
    });
    transcript.begin("2026-10-28T08:00:00.000Z");
    transcript.connect();
    transcript.wait(1000);
    const call = transcript.startCall();
    transcript.wait(300);
    transcript.openStream(call);
    transcript.wait(3000);
    const asked = transcript.youSay("walk-question.pcm", "Remind me to call Mum on Sunday at two.");
    transcript.startTurn([asked]);
    transcript.wait(1200);
    transcript.ask({
      kind: "approval",
      question: "Shall I add it to your calendar?",
      preview: "Calendar: Call Mum, Sunday 1 November, 2pm",
      options: [{ label: "Add it", acts: true }, { label: "Leave it" }],
      allowsText: false,
    });
    transcript.endTurn("completed");
    transcript.wait(4000);
    for (const sentence of transcript.unplayed()) transcript.played(sentence);
    transcript.wait(1500);
    const yes = transcript.youSay("walk-follow-up.pcm", "Add it.");
    transcript.startTurn([yes]);
    transcript.wait(900);
    writeWhole(transcript, "Added. I'll remind you on Sunday.", 1);
    transcript.endTurn("completed");
    transcript.wait(2000);
    for (const sentence of transcript.unplayed()) transcript.played(sentence);
    transcript.wait(10_000);
    transcript.hangUp();
    return transcript;
  },

  () => {
    const transcript = createTranscript({
      name: "53-an-app-asks-first",
      scenario: 53,
      title: "An app asks first",
      summary:
        "Adding a calendar event needs your approval before the app runs it. The approval waits inside the running " +
        "turn; you tap Allow, the same turn carries on, and the event is added.",
      guarantees: ["G28"],
    });
    transcript.begin("2026-10-28T09:00:00.000Z");
    transcript.connect();
    transcript.wait(1000);
    const user = transcript.send("Add a reminder to call Mum on Sunday at 2.");
    transcript.startTurn([user]);
    transcript.wait(600);
    transcript.step("tool", addToCalendar({ title: "Call Mum", start: "2026-11-01T14:00:00Z" }));
    transcript.wait(400);
    transcript.approval(calendarApproval);
    transcript.wait(5000);
    const allowed = transcript.send("Allow");
    transcript.read(allowed);
    transcript.status("working", "Going ahead");
    transcript.wait(800);
    transcript.endStep();
    writeWhole(transcript, "Added: Call Mum, Sunday at 2pm.");
    transcript.endTurn("completed");
    return transcript;
  },

  () => {
    const transcript = createTranscript({
      name: "54-an-approval-answered-in-words",
      scenario: 54,
      title: "An approval answered in words",
      summary:
        "While an app's approval waits, you type something else. It answers the approval as not allowed, and your " +
        "words reach the agent in the same turn, so it can act on them.",
      guarantees: ["G28"],
    });
    transcript.begin("2026-10-28T09:20:00.000Z");
    transcript.connect();
    transcript.wait(1000);
    const user = transcript.send("Add a reminder to call Mum on Sunday at 2.");
    transcript.startTurn([user]);
    transcript.wait(600);
    transcript.step("tool", addToCalendar({ title: "Call Mum", start: "2026-11-01T14:00:00Z" }));
    transcript.wait(400);
    transcript.approval(calendarApproval);
    transcript.wait(6000);
    const words = transcript.send("Do it at 3 instead");
    transcript.status("working", "Leaving it");
    transcript.wait(300);
    transcript.endStep({ outcome: "failed" });
    transcript.wait(200);
    transcript.read(words);
    transcript.wait(900);
    writeWhole(transcript, "I've left it for now. Shall I add it at 3pm instead?");
    transcript.endTurn("completed");
    return transcript;
  },

  () => {
    const transcript = createTranscript({
      name: "55-stopped-while-an-app-waits",
      scenario: 55,
      title: "Stopped while an app waits",
      summary:
        "You stop the turn while an app's approval is waiting. The approval is cancelled as the turn stops, and " +
        "nothing is added.",
      guarantees: ["G9", "G28"],
    });
    transcript.begin("2026-10-28T09:40:00.000Z");
    transcript.connect();
    transcript.wait(1000);
    const user = transcript.send("Add a reminder to call Mum on Sunday at 2.");
    const turn = transcript.startTurn([user]);
    transcript.wait(600);
    transcript.step("tool", addToCalendar({ title: "Call Mum", start: "2026-11-01T14:00:00Z" }));
    transcript.wait(400);
    transcript.approval(calendarApproval);
    transcript.wait(4000);
    transcript.stop(turn);
    transcript.status("stopping", "Stopping");
    transcript.wait(300);
    transcript.endTurn("stopped");
    return transcript;
  },

  () => {
    const transcript = createTranscript({
      name: "56-relearn-my-voice",
      scenario: 56,
      title: "Relearn my voice",
      summary:
        "Settings shows the server knows your voice. You choose to relearn it, and the server forgets the voiceprint " +
        "and learns your voice again from your next calls.",
      guarantees: ["G25"],
    });
    const headers = { headers: { "Ito-Protocol": protocol } };
    transcript.begin("2026-10-28T10:00:00.000Z");
    transcript.world("voiceprint_learnt");
    transcript.request("GET", "/v0/voices");
    transcript.wait(40);
    transcript.response(200, { voices, chosen: defaultVoice, state: "ready", voiceprint: "learnt" }, headers);
    transcript.wait(5000);
    transcript.request("DELETE", "/v0/voice/voiceprint");
    transcript.wait(40);
    transcript.response(200, { voices, chosen: defaultVoice, state: "ready", voiceprint: "learning" }, headers);
    return transcript;
  },

  () => {
    const transcript = createTranscript({
      name: "57-what-ari-learnt-lately",
      scenario: 57,
      title: "What Ari learnt lately",
      summary:
        "You tell Ari about a trip. Ari starts a page for it, with a line on what the page is now and a note on " +
        "what changed, and keeps a note for tonight's journal. The Library leads with those notes, lists journal " +
        "days by their headlines, lists people with the circle Ari keeps for each, and shows the trip's linked " +
        "page by its name.",
      guarantees: ["G22"],
    });
    const seededAt = "2026-10-27T18:00:00.000Z";
    const mira = {
      address: "memory:people/mira",
      title: "Mira",
      gist: "Your oldest friend, from school",
      aliases: ["Mimi"],
      links: [],
      markdown: "Your oldest friend; you met at school in Pune (as of 20 Oct).\n",
      note: "Oldest friend, from school",
      circle: "friends",
    };
    const yesterday = {
      address: "memory:journal/2026-10-26",
      title: "26 October 2026",
      gist: "Home from Ljubljana; Leo's first sub-two",
      aliases: [],
      links: [],
      markdown: "### 21:10\n\nHome from Ljubljana. Leo ran his first half marathon under two hours.\n",
      note: "Home from Ljubljana",
    };
    const florence = {
      address: "memory:projects/florence-trip",
      title: "Florence trip",
      gist: "With Mira, 6–9 November; nothing booked yet",
      aliases: [],
      links: [mira.address],
      markdown: "Florence with Mira, 6 to 9 November. Nothing booked yet (as of 27 Oct).\n",
    };
    transcript.begin(seededAt);
    transcript.world("memory_holds", { pages: [mira, yesterday] });
    transcript.wait(10 * 60 * 1000);
    transcript.connect();
    transcript.wait(2000);
    sendAndStart(transcript, "Mira and I are off to Florence together, 6 to 9 November!");
    transcript.wait(700);
    const change = transcript.change();
    agentCalls(transcript, "write_page", {
      address: florence.address,
      title: florence.title,
      gist: florence.gist,
      note: "Florence with Mira, 6–9 Nov",
      links: florence.links,
      body: florence.markdown,
    });
    memoryStep(
      transcript,
      "updated",
      [{ address: florence.address, title: florence.title }],
      { title: "Updating Florence trip", endedTitle: "Updated Florence trip" },
      change,
    );
    transcript.wait(400);
    agentCalls(transcript, "note_day", { text: "Mira and I are off to Florence together, 6 to 9 November." });
    transcript.wait(300);
    writeWhole(transcript, "Florence with Mira, lovely! I've started a page for the trip.");
    transcript.endTurn("completed");
    transcript.wait(5000);
    const writtenAt = new Date(Date.parse(seededAt) + 10 * 60 * 1000 + 2000 + 700).toISOString();
    memoryCall(transcript, "/v0/memory/recent", {
      changes: [
        {
          change,
          address: florence.address,
          title: florence.title,
          at: writtenAt,
          note: "Florence with Mira, 6–9 Nov",
        },
        {
          change: transcript.change(),
          address: yesterday.address,
          title: yesterday.title,
          at: seededAt,
          note: yesterday.note,
        },
        { change: transcript.change(), address: mira.address, title: mira.title, at: seededAt, note: mira.note },
      ],
    });
    transcript.wait(2000);
    memoryCall(transcript, "/v0/memory/pages?shelf=journal", {
      pages: [{ address: yesterday.address, title: yesterday.title, gist: yesterday.gist, changed_at: seededAt }],
    });
    transcript.wait(2000);
    memoryCall(transcript, "/v0/memory/pages?shelf=people", {
      pages: [{ address: mira.address, title: mira.title, gist: mira.gist, circle: "friends", changed_at: seededAt }],
    });
    transcript.wait(2000);
    memoryCall(
      transcript,
      `/v0/memory/page?address=${florence.address}`,
      pageBody({ ...florence, links: [] }, writtenAt, [mira]),
    );
    return transcript;
  },

  () => {
    const transcript = createTranscript({
      name: "58-side-threads",
      scenario: 58,
      title: "Side threads",
      summary:
        "You send Kumo a photo with a one-off question. Kumo moves it into a side thread of its own, so the main " +
        "chat keeps only the thread's line, and the thread's own turn answers there. While it works, what you say " +
        "in the main chat starts a turn of its own instead of steering the thread aside. Kumo marks the thread " +
        "done with a result; the notification opens the thread, and Threads lists it.",
      guarantees: ["G29", "G15"],
    });
    yesterday(transcript);
    transcript.begin(todayAt, { cursor: "latest" });
    transcript.connect();
    transcript.registerDevice();
    transcript.wait(2000);
    const photo = transcript.upload("riverside.jpg");
    transcript.wait(200);
    const question = transcript.send("Where's this, and is the walk worth it?", { attachments: [photo] });
    transcript.startTurn([question]);
    transcript.wait(900);
    transcript.world("agent_calls", { tool: "start_thread", input: { title: "Riverside walk" } });
    const thread = transcript.branch("Riverside walk", [question]);
    transcript.inThread(thread, () => {
      transcript.startTurn([question]);
    });
    transcript.endTurn("completed");
    transcript.inThread(thread, () => {
      transcript.wait(300);
      transcript.step("thinking", thinking);
    });
    transcript.wait(1200);
    const aside = transcript.send("Also, will it rain this afternoon?");
    transcript.startTurn([aside]);
    transcript.wait(300);
    transcript.step("thinking", thinking);
    transcript.wait(900);
    writeWhole(transcript, "Dry until about six, then showers. Take a light jacket if you'll be out late.");
    transcript.endTurn("completed");
    transcript.inThread(thread, () => {
      transcript.wait(600);
      writeWhole(
        transcript,
        "That's the Thames Path on the Surrey bank, just upstream of Hampton Court. Worth it: flat, quiet, and " +
          "the palace gardens are ten minutes on.",
      );
      const result = "Thames Path by Hampton Court: worth it";
      transcript.world("agent_calls", { tool: "update_thread", input: { state: "done", result }, thread });
      transcript.changeThread(thread, { state: "done", result });
      transcript.wait(200);
      transcript.endTurn("completed");
    });
    transcript.wait(4000);
    transcript.world("notification_tapped", { thread });
    transcript.getThread(thread);
    transcript.seeThread(thread);
    transcript.wait(2000);
    transcript.listThreads();
    return transcript;
  },

  () => {
    const transcript = createTranscript({
      name: "59-blocks-in-a-reply",
      scenario: 59,
      title: "Blocks in a reply",
      summary:
        "Ari answers with a Markdown list, a place and choices to tap, the last two as blocks the app draws. " +
        "Tapping a choice sends its label as an ordinary message.",
      guarantees: [],
    });
    transcript.begin("2026-10-28T12:00:00.000Z");
    transcript.connect();
    transcript.wait(2000);
    sendAndStart(transcript, "Can you plan our three days in Florence? We land on Friday morning.");
    transcript.wait(900);
    writeWhole(
      transcript,
      [
        "Here's a gentle shape for it, with the Uffizi first thing on Saturday, before the crowds.",
        "",
        "- **Friday:** the Duomo climb in the afternoon",
        "- **Saturday:** the Uffizi at 8:15, then the Oltrarno",
        "- **Sunday:** a train to Siena",
        "",
        "```ari:place",
        JSON.stringify({
          name: "Uffizi Gallery",
          address: "Piazzale degli Uffizi 6, Florence",
          lat: 43.7678,
          lon: 11.2553,
        }),
        "```",
        "",
        "```ari:choices",
        JSON.stringify({ options: ["Book the Uffizi", "Swap Siena for Pisa"] }),
        "```",
      ].join("\n"),
    );
    transcript.endTurn("completed");
    transcript.wait(60_000);
    sendAndStart(transcript, "Swap Siena for Pisa");
    transcript.wait(800);
    writeWhole(transcript, "Done: Pisa on Sunday, 50 minutes by train from Santa Maria Novella.");
    transcript.endTurn("completed");
    return transcript;
  },
  () => {
    const transcript = createTranscript({
      name: "60-pictures-ari-found",
      scenario: 60,
      title: "Pictures Ari found",
      summary:
        "You ask what somewhere looks like. Ari finds a photo on the web and keeps it on the server, then shows " +
        "it in its reply with its source and credit. The app fetches it from the server, never from the site.",
      guarantees: ["G31"],
    });
    const url = "https://photos.example.org/lungarno-dusk.jpg";
    transcript.begin("2026-10-28T13:00:00.000Z");
    transcript.connect();
    transcript.wait(2000);
    sendAndStart(transcript, "What does the Lungarno look like at dusk?");
    transcript.wait(600);
    transcript.step("web_search", searching("Lungarno at dusk photo"));
    transcript.wait(1500);
    transcript.endStep();
    transcript.world("web_has", { url, file: "riverside.jpg" });
    const picture = transcript.keptImage("riverside.jpg", "lungarno-dusk.jpg");
    agentCalls(transcript, "keep_image", { url }, { attachment: picture });
    transcript.wait(400);
    writeWhole(
      transcript,
      [
        "Golden, then blue: the river turns to glass and the bridges light up.",
        "",
        "```ari:images",
        JSON.stringify({
          images: [
            {
              attachment: picture,
              alt: "The Arno at dusk, with the Ponte Vecchio lit up",
              source_url: "https://commons.example.org/wiki/File:Lungarno_at_dusk.jpg",
              credit: "Photo by M. Rossi, CC BY-SA 4.0",
            },
          ],
        }),
        "```",
      ].join("\n"),
    );
    transcript.endTurn("completed");
    transcript.wait(1500);
    transcript.fetchAttachment(picture);
    return transcript;
  },

  () => {
    const transcript = createTranscript({
      name: "61-you-carry-on",
      scenario: 61,
      title: "You carry on",
      summary:
        "You pause mid-thought long enough for your turn to end, then carry on before Ari has begun to answer. " +
        "Your new words join the message you'd just spoken, with one recording of both parts, and Ari answers " +
        "the whole thought once.",
      guarantees: ["G25"],
    });
    transcript.begin("2026-10-29T08:00:00.000Z");
    transcript.connect();
    transcript.wait(1000);
    const call = transcript.startCall();
    transcript.wait(300);
    transcript.openStream(call);
    transcript.wait(4000);
    const thought = transcript.youSay("walk-question.pcm", "I keep thinking about Florence.");
    transcript.startTurn([thought]);
    transcript.wait(700);
    transcript.youSay("walk-follow-up.pcm", "Should we take a day for Pisa, or stay put?", { carriesOn: thought });
    transcript.wait(1200);
    writeWhole(transcript, "Stay put, I'd say: four days is short. Pisa's an easy morning if you want it.", 1);
    transcript.endTurn("completed");
    transcript.wait(4000);
    transcript.played("s1");
    transcript.wait(2000);
    transcript.played("s2");
    transcript.wait(5000);
    transcript.hangUp();
    return transcript;
  },

  () => {
    const transcript = createTranscript({
      name: "62-a-trip-in-motion",
      scenario: 62,
      title: "A trip in motion",
      summary:
        "You ask Ari to plan a weekend. Ari finds a cover and a photo for every place, starts the trip as a thing " +
        "in motion with its days, places, travel, stay and to-do list, every stop at its place, and answers in a " +
        "line with a compact line under it. The trip is pinned; the app lists it, opens it, and fetches its cover " +
        "from the server.",
      guarantees: ["G32"],
    });
    transcript.begin("2026-10-29T09:00:00.000Z");
    transcript.connect();
    transcript.wait(2000);
    sendAndStart(
      transcript,
      "Can you plan Florence with Mira? 6 to 9 November. Good food, the Uffizi, maybe Pisa for a day.",
    );
    transcript.wait(800);
    const pictures = findFlorencePictures(transcript);
    transcript.wait(2500);
    const { motion, change } = startFlorence(transcript, pictures);
    transcript.wait(400);
    writeWhole(
      transcript,
      [
        "Here's a first shape: the Duomo when you land, the Uffizi first thing Saturday, Pisa on Sunday. I've " +
          "started it in In motion, so it's always to hand.",
        "",
        motionLine(florenceId, 1),
      ].join("\n"),
    );
    transcript.endTurn("completed");
    transcript.wait(3000);
    memoryCall(transcript, "/v0/motion", { motions: [motion] });
    transcript.wait(1500);
    memoryCall(transcript, `/v0/motion/${florenceId}`, {
      motion,
      content: florenceTrip(pictures),
      state: {},
      changes: [change],
    });
    transcript.wait(300);
    transcript.fetchAttachment(pictures.cover);
    return transcript;
  },

  () => {
    const transcript = createTranscript({
      name: "63-keeping-it-current",
      scenario: 63,
      title: "Keeping it current",
      summary:
        "You tell Ari you booked the Uffizi. Ari reads the trip and changes it by id, citing the version it read: " +
        "the to-do is ticked, the stop is booked and the pinned line counts one fewer. You tick the Pisa train " +
        "yourself and put the Boboli Gardens in the plan; every app hears it, a few seconds later Ari quietly fits " +
        "the gardens into Saturday, and it learns of both with your next message. The trip shows what changed.",
      guarantees: ["G32"],
    });
    transcript.begin("2026-10-29T09:00:00.000Z");
    transcript.connect();
    transcript.wait(2000);
    sendAndStart(transcript, "Can you plan Florence with Mira? 6 to 9 November.");
    transcript.wait(800);
    const pictures = findFlorencePictures(transcript);
    transcript.wait(2000);
    const started = startFlorence(transcript, pictures);
    transcript.wait(400);
    writeWhole(transcript, `Here's a first shape, in In motion.\n\n${motionLine(florenceId, 1)}`);
    transcript.endTurn("completed");
    transcript.wait(60 * 60 * 1000);
    sendAndStart(transcript, "Booked the Uffizi for 8:15 Saturday.");
    transcript.wait(600);
    agentCalls(transcript, "read_motion", { id: florenceId });
    transcript.wait(900);
    const note = "Booked the Uffizi, 8:15 Saturday";
    agentCalls(transcript, "change_motion", {
      id: florenceId,
      version: 1,
      changes: [
        { set: "book-uffizi", fields: { done: true } },
        { set: "uffizi", fields: { booking: { status: "booked", ref: "UF-2291" } } },
        { set: "uffizi-place", fields: { status: "booked", booking: { status: "booked", ref: "UF-2291" } } },
      ],
      summary: "6–9 Nov · 3 to book",
      note,
    });
    const changed = transcript.motion(
      "changed",
      { ...florenceCard, cover: pictures.cover, version: 2, summary: "6–9 Nov · 3 to book" },
      note,
    );
    motionStep(
      transcript,
      "updated",
      changed.motion,
      {
        title: "Updating Florence with Mira: booked the Uffizi, 8:15 Saturday",
        endedTitle: "Updated Florence with Mira: booked the Uffizi, 8:15 Saturday",
      },
      note,
    );
    transcript.wait(400);
    writeWhole(
      transcript,
      `Lovely, that's in. Three to go: the Duomo climb, the Pisa train and the Pitti Palace.\n\n${motionLine(florenceId, 2)}`,
    );
    transcript.endTurn("completed");
    transcript.wait(5 * 60 * 1000);
    transcript.patchMotion(florenceId, { todo: { "book-pisa": { done: true } } });
    transcript.wait(1500);
    const state = transcript.patchMotion(florenceId, { places: { boboli: { status: "picked" } } });
    const gardens = { id: "boboli-stop", title: "Boboli Gardens", time: "15:30", place: "boboli" };
    const fitted = "Fitted the Boboli Gardens into Saturday";
    transcript.world("ari_keeps_up", {
      changes: [
        { add: gardens, to: "sat", after: "pitti" },
        { set: "boboli", fields: { status: "picked" } },
      ],
      summary: "6–9 Nov · 2 to book",
      note: fitted,
    });
    transcript.wait(3000);
    const keptUp = transcript.motion(
      "changed",
      { ...florenceCard, cover: pictures.cover, version: 3, summary: "6–9 Nov · 2 to book" },
      fitted,
    );
    transcript.wait(2000);
    const trip = florenceTrip(pictures);
    memoryCall(transcript, `/v0/motion/${florenceId}`, {
      motion: keptUp.motion,
      content: {
        ...trip,
        days: (trip.days as readonly Readonly<Record<string, unknown>>[]).map((day) =>
          day.id === "sat"
            ? {
                ...day,
                stops: [
                  ...(day.stops as readonly Readonly<Record<string, unknown>>[]).map((stop) =>
                    stop.id === "uffizi" ? { ...stop, booking: { status: "booked", ref: "UF-2291" } } : stop,
                  ),
                  gardens,
                ],
              }
            : day,
        ),
        places: (trip.places as readonly Readonly<Record<string, unknown>>[]).map((place) => {
          if (place.id === "uffizi-place") {
            return { ...place, status: "booked", booking: { status: "booked", ref: "UF-2291" } };
          }
          return place.id === "boboli" ? { ...place, status: "picked" } : place;
        }),
        todo: (trip.todo as readonly Readonly<Record<string, unknown>>[]).map((item) =>
          item.id === "book-uffizi" ? { ...item, done: true } : item,
        ),
      },
      state,
      changes: [keptUp.change, changed.change, started.change],
    });
    transcript.wait(2000);
    sendAndStart(transcript, "Thanks! What's left?");
    transcript.wait(900);
    writeWhole(
      transcript,
      "The Duomo climb and the Pitti Palace. The Pisa train's ticked off, and the gardens follow the Pitti.",
    );
    transcript.endTurn("completed");
    return transcript;
  },

  () => {
    const transcript = createTranscript({
      name: "64-a-training-block",
      scenario: 64,
      title: "A training block",
      summary:
        "You ask Ari to keep your sub-20 5K plan. Ari starts the whole block as a thing in motion in Body, loud, " +
        "every week from the first to the last. That evening you tick today's intervals; a few seconds later Ari quietly " +
        "rewrites the week's note, with no chat message and no turn. On Saturday you tell Ari a parkrun time, " +
        "and Ari adds it to the results.",
      guarantees: ["G32"],
    });
    transcript.begin("2026-10-28T07:30:00.000Z");
    transcript.connect();
    transcript.wait(2000);
    sendAndStart(
      transcript,
      "I'm five weeks into a sub-20 5K block, ten weeks to the end of November. Can you keep the plan? Intervals today.",
    );
    transcript.wait(1200);
    agentCalls(transcript, "start_motion", {
      id: sub20Id,
      kind: sub20Card.kind,
      title: sub20Card.title,
      summary: sub20Card.summary,
      salience: sub20Card.salience,
      content: sub20Training,
      note: "Started the block",
    });
    const started = transcript.motion("started", { ...sub20Card, version: 1 }, "Started the block");
    motionStep(transcript, "started", started.motion, {
      title: "Starting Sub-20 5K",
      endedTitle: "Started Sub-20 5K",
    });
    transcript.wait(400);
    writeWhole(
      transcript,
      `All ten weeks are in In motion. Today's the 6 × 800 m; keep the jogs honest.\n\n${motionLine(sub20Id, 1)}`,
    );
    transcript.endTurn("completed");
    transcript.wait(10 * 60 * 60 * 1000);
    const state = transcript.patchMotion(sub20Id, { sessions: { "w6-wed": { done: true } } });
    const weekNote = "Intervals done. Keep tomorrow easy; Friday's tempo is next.";
    const keptUp = "Week 6: intervals done";
    transcript.world("ari_keeps_up", {
      changes: [{ set: "week-6", fields: { note: weekNote } }],
      summary: "Week 6 of 10 · tempo Friday",
      note: keptUp,
    });
    transcript.wait(3000);
    const changed = transcript.motion(
      "changed",
      { ...sub20Card, summary: "Week 6 of 10 · tempo Friday", version: 2 },
      keptUp,
    );
    transcript.wait(2000);
    memoryCall(transcript, `/v0/motion/${sub20Id}`, {
      motion: changed.motion,
      content: withWeekNote("week-6", weekNote),
      state,
      changes: [changed.change, started.change],
    });
    transcript.wait(2.5 * 24 * 60 * 60 * 1000);
    sendAndStart(transcript, "Did parkrun this morning: 20:12!");
    transcript.wait(600);
    agentCalls(transcript, "read_motion", { id: sub20Id });
    transcript.wait(900);
    const resultNote = "Parkrun 20:12, a best";
    agentCalls(transcript, "change_motion", {
      id: sub20Id,
      version: 2,
      changes: [
        {
          add: { id: "parkrun-oct-31", date: "2026-10-31", result: "20:12", note: "29 s faster than last time" },
          to: "results",
          after: "parkrun-oct-24",
        },
      ],
      summary: "Week 6 of 10 · long run Sunday",
      note: resultNote,
    });
    const added = transcript.motion(
      "changed",
      { ...sub20Card, summary: "Week 6 of 10 · long run Sunday", version: 3 },
      resultNote,
    );
    motionStep(
      transcript,
      "updated",
      added.motion,
      { title: "Updating Sub-20 5K: parkrun 20:12, a best", endedTitle: "Updated Sub-20 5K: parkrun 20:12, a best" },
      resultNote,
    );
    transcript.wait(400);
    writeWhole(
      transcript,
      `20:12, 29 seconds off in four weeks. Sunday's long run stays easy.\n\n${motionLine(sub20Id, 3)}`,
    );
    transcript.endTurn("completed");
    return transcript;
  },

  () => {
    const transcript = createTranscript({
      name: "65-the-desk",
      scenario: 65,
      title: "The Desk",
      summary:
        "Overnight Kumo filled the Desk: what's coming up and five cards waiting on you, one of each kind. The " +
        "snapshot carries it, and so does GET /v0/desk. You answer the question, accept the offer, which Kumo " +
        "takes on in the background and messages you about at once, and pick the clear times, which Kumo turns " +
        "into a draft. Each counts in what Kumo handled today.",
      guarantees: ["G33", "G34", "G48"],
    });
    transcript.time("2026-11-11T06:00:00.000Z");
    const technical = transcript.calendarItem(halcyonTechnical);
    const mira = transcript.calendarItem({
      uid: "mira-dinner-1111@icloud.com",
      title: "Mira",
      start: "2026-11-11T19:30:00.000Z",
      end: "2026-11-11T21:30:00.000Z",
      all_day: false,
      location: "Dishoom Shoreditch",
      calendar: { name: "Home", kumo: false },
      leave_at: "2026-11-11T19:05:00.000Z",
      status: "confirmed",
    });
    transcript.comingUp([mira, technical]);
    const question = transcript.addCard({
      kind: "question",
      title: "Binned a Revolut mail",
      options: [{ label: "Right", acts: true }, { label: "Keep it" }],
      allows_text: true,
      question: { text: 'Binned "Your account update" from Revolut as a promotion. Right?' },
    });
    transcript.addCard({
      kind: "draft",
      title: "Draft to Tess",
      options: [{ label: "Drop it" }],
      allows_text: true,
      draft: tessDraft,
    });
    transcript.addCard({
      kind: "invite",
      title: "Halcyon technical, Thursday 14:00",
      options: [{ label: "Accept", acts: true }, { label: "Maybe" }, { label: "Decline" }],
      allows_text: false,
      invite: { event: technical },
    });
    const times = transcript.addCard({
      kind: "times",
      title: "Times for a call with Northwind",
      options: [{ label: "Draft it", acts: true }],
      allows_text: true,
      times: {
        purpose: "A first call with Clara at Northwind",
        slots: [
          { start: "2026-11-13T09:00:00.000Z", end: "2026-11-13T09:30:00.000Z", note: "WFH day" },
          { start: "2026-11-13T12:30:00.000Z", end: "2026-11-13T13:00:00.000Z", note: "WFH day" },
          { start: "2026-11-14T17:30:00.000Z", end: "2026-11-14T18:00:00.000Z" },
        ],
      },
    });
    const offer = transcript.addCard({
      kind: "offer",
      title: "Italian practice?",
      options: [{ label: "Yes", acts: true }, { label: "Not now" }],
      allows_text: false,
      offer: { text: "Italian keeps coming up. Want a 15-minute lesson on Tuesday and Thursday evenings?" },
    });
    transcript.begin("2026-11-11T07:40:00.000Z");
    transcript.world("capability_on", {
      capability: "outlook",
      values: { address: "divy@outlook.com", token: "replay-token" },
    });
    transcript.connect();
    transcript.wait(1500);
    transcript.getDesk();
    transcript.wait(3000);
    transcript.world("kumo_works", { calls: [] });
    transcript.answerCard(question.id, { option: "Right" });
    transcript.handled({ text: "You answered “Binned a Revolut mail”: Right", reason: "Done." });
    transcript.settleCard(question.id);
    transcript.wait(2000);
    const lessons = "Italian is on: 15 minutes on Tuesday and Thursday evenings, from this week.";
    transcript.world("kumo_works", { calls: [], post: lessons });
    transcript.answerCard(offer.id, { option: "Yes" });
    transcript.post(lessons);
    transcript.handled({ text: "You answered “Italian practice?”: Yes", reason: "Done." });
    transcript.settleCard(offer.id);
    transcript.wait(4000);
    transcript.world("kumo_works", {
      calls: [
        {
          tool: "draft",
          input: {
            account: "outlook",
            to: ["clara.voss@northwind.example"],
            subject: "Re: AI Engineer, FI",
            body: northwindBody,
            title: "Draft to Clara at Northwind",
          },
        },
      ],
    });
    transcript.answerCard(times.id, { slots: [0, 2] });
    transcript.addCard({
      kind: "draft",
      title: "Draft to Clara at Northwind",
      options: [{ label: "Drop it" }],
      allows_text: true,
      draft: {
        account: "outlook",
        from: "divy@outlook.com",
        to: ["clara.voss@northwind.example"],
        subject: "Re: AI Engineer, FI",
        body: northwindBody,
        message_id: "draft-northwind-0001@ito.local",
      },
    });
    transcript.handled({
      text:
        "You answered “Times for a call with Northwind”: 2026-11-13T09:00:00.000Z to 2026-11-13T09:30:00.000Z " +
        "(WFH day); 2026-11-14T17:30:00.000Z to 2026-11-14T18:00:00.000Z",
      reason: "Done.",
    });
    transcript.settleCard(times.id);
    return transcript;
  },

  () => {
    const transcript = createTranscript({
      name: "66-a-mail-arrives",
      scenario: 66,
      title: "A mail arrives",
      summary:
        "A booking confirmation lands in iCloud Mail. The attention pass judges it work, and a short-lived work " +
        "thread puts the stay on your calendar, notices check-in closes before you land, drafts a note in your " +
        "voice into Drafts and messages you about it in the conversation. Nothing is sent to the hotel.",
      guarantees: ["G35", "G36", "G48"],
    });
    transcript.begin("2026-11-10T22:31:00.000Z");
    transcript.world("capability_on", {
      capability: "icloud",
      values: { apple_id: "divy@icloud.com", app_password: "abcd-efgh-ijkl-mnop" },
    });
    transcript.connect();
    transcript.wait(1000);
    transcript.world("attention_decides", {
      decision: "work",
      stakes: "high",
      folder: "",
      reason: "A hotel booking for Florence",
      confidence: 0.94,
    });
    const stay = {
      title: "Hotel Orto",
      start: "2026-11-20",
      end: "2026-11-23",
      all_day: true,
      location: "Via Guelfa 27, Florence",
      notes: "Booked through iCloud Mail: Booking confirmed: 20–23 November",
    };
    const note =
      "Hi! We land at 22:10 on the 20th, so we'll reach you around 23:00, after reception closes. Could you " +
      "leave the keys for us, or tell us how late check-in works? Thanks, Divy";
    const snag =
      "Hotel Orto confirmed you for 20–23 Nov; it's on your calendar. One snag: you land 22:10 and check-in " +
      "closes 22:00, so I drafted a note.";
    transcript.world("kumo_works", {
      calls: [
        { tool: "add_event", input: stay },
        {
          tool: "draft",
          input: {
            account: "icloud",
            reply_to: "confirm-48213@hotelorto.it",
            body: note,
            title: "Note to Hotel Orto",
          },
        },
      ],
      post: snag,
    });
    transcript.world("mail_arrives", {
      account: "icloud",
      message_id: "confirm-48213@hotelorto.it",
      from: "Hotel Orto <reservations@hotelorto.it>",
      to: ["divy@icloud.com"],
      subject: "Booking confirmed: 20–23 November",
      text: "Dear Divy, your stay at Hotel Orto is confirmed for 20–23 November. Reception is open until 22:00.",
    });
    transcript.mailRead();
    transcript.addCard({
      kind: "draft",
      title: "Note to Hotel Orto",
      options: [{ label: "Drop it" }],
      allows_text: true,
      draft: {
        account: "icloud",
        from: "divy@icloud.com",
        to: ["reservations@hotelorto.it"],
        subject: "Re: Booking confirmed: 20–23 November",
        body: note,
        message_id: "draft-orto-0001@ito.local",
        in_reply_to: "confirm-48213@hotelorto.it",
      },
    });
    transcript.post(snag);
    return transcript;
  },

  () => {
    const transcript = createTranscript({
      name: "67-an-invite",
      scenario: 67,
      title: "An invite",
      summary:
        "Tess's invite for the Halcyon technical arrives. Kumo holds the time on its own calendar, checks for a " +
        "clash and puts Accept, Maybe and Decline on the Desk. You accept; iCloud sends the reply itself, and the " +
        "event shows in Coming up.",
      guarantees: ["G34", "G37"],
    });
    transcript.begin("2026-11-11T09:00:00.000Z");
    transcript.world("capability_on", {
      capability: "icloud",
      values: { apple_id: "divy@icloud.com", app_password: "abcd-efgh-ijkl-mnop" },
    });
    transcript.connect();
    transcript.wait(1000);
    transcript.world("invite_arrives", {
      uid: halcyonTechnical.uid,
      title: halcyonTechnical.title,
      start: halcyonTechnical.start,
      end: halcyonTechnical.end,
      location: halcyonTechnical.location,
      organizer: "Tess Harlow <tess.harlow@halcyon.example>",
    });
    const invited = transcript.calendarItem({ ...halcyonTechnical, status: "tentative" });
    const held = transcript.calendarItem({
      ...halcyonTechnical,
      uid: `hold-${halcyonTechnical.uid}`,
      calendar: { name: "Kumo", kumo: true },
      status: "hold",
    });
    const invite = transcript.addCard({
      kind: "invite",
      title: "Halcyon technical, Thursday 14:00",
      options: [{ label: "Accept", acts: true }, { label: "Maybe" }, { label: "Decline" }],
      allows_text: false,
      invite: { event: invited },
    });
    transcript.comingUp([held]);
    transcript.wait(5000);
    transcript.answerCard(invite.id, { option: "Accept" });
    transcript.comingUp([{ ...invited, status: "confirmed" }]);
    transcript.settleCard(invite.id);
    return transcript;
  },

  () => {
    const transcript = createTranscript({
      name: "69-getting-started",
      scenario: 69,
      title: "Getting started",
      summary:
        "On a fresh box Kumo asks its first question in the conversation as soon as the app connects. You " +
        "connect iCloud, and Kumo reads your last 90 days of mail, with its progress on every app. When it has " +
        "read everything it shows what it found: a booking it put on your calendar and a belief to check. You " +
        "answer the question, confirm the belief and finish.",
      guarantees: ["G39"],
    });
    transcript.time("2026-11-09T19:00:00.000Z");
    transcript.onboarding({ state: "reading" });
    transcript.begin("2026-11-09T19:02:00.000Z");
    const question = "While I read: what would make the next month a good one for you?";
    transcript.world("kumo_works", { calls: [], post: question });
    transcript.connect();
    transcript.post(question);
    transcript.wait(20_000);
    const flights = {
      title: "Flights to Valencia",
      start: "2026-12-04T07:15:00.000Z",
      end: "2026-12-04T09:40:00.000Z",
      location: "Gatwick North",
      notes: "Booked through iCloud Mail: Your easyJet booking EZY8817",
    };
    const sub20 = "You're training for a sub-20 5K, with parkrun on Saturdays.";
    transcript.world("kumo_works", {
      calls: [
        { tool: "add_event", input: flights },
        { tool: "believe", input: { text: sub20, page: "memory:now" } },
      ],
    });
    transcript.world("inbox_holds", { account: "icloud", count: 40 });
    transcript.world("capability_on", {
      capability: "icloud",
      values: { apple_id: "divy@icloud.com", app_password: "abcd-efgh-ijkl-mnop" },
    });
    transcript.onboarding({ state: "reading", progress: { mails_read: 0, mails_total: 40 } });
    const belief = transcript.belief();
    const booked = transcript.calendarItem({
      uid: transcript.eventUid(),
      title: flights.title,
      start: flights.start,
      end: flights.end,
      all_day: false,
      location: flights.location,
      calendar: { name: "Home", kumo: false },
      status: "confirmed",
    });
    transcript.onboarding({
      state: "ready",
      proposal: { beliefs: [{ id: belief, text: sub20, page: "memory:now" }], added: [booked], motions: [] },
    });
    transcript.wait(20_000);
    sendAndStart(transcript, "Getting the Halcyon offer sorted, and running three times a week.");
    transcript.wait(900);
    writeWhole(transcript, "Then mornings stay for running, and I'll keep the Halcyon side moving.");
    transcript.endTurn("completed");
    transcript.wait(15_000);
    transcript.answerBelief(belief, { answer: "true" });
    transcript.wait(5000);
    transcript.finishOnboarding();
    return transcript;
  },

  () => {
    const transcript = createTranscript({
      name: "70-getting-started-again",
      scenario: 70,
      title: "Getting started again",
      summary:
        "Getting started is done and iCloud is connected. You choose to see it again from Settings. Nothing is " +
        "wiped and no mail is read again: Kumo asks its first question once more and names what it believes from " +
        "memory. You confirm the belief and finish.",
      guarantees: ["G39"],
    });
    transcript.begin("2026-11-12T19:00:00.000Z");
    transcript.world("capability_on", {
      capability: "icloud",
      values: { apple_id: "divy@icloud.com", app_password: "abcd-efgh-ijkl-mnop" },
    });
    transcript.connect();
    transcript.wait(5000);
    const question = "Good to see this again. What's changed since we last did it?";
    const sub20 = "You're training for a sub-20 5K, with parkrun on Saturdays.";
    transcript.world("kumo_works", { calls: [], post: question });
    transcript.world("kumo_works", { calls: [{ tool: "believe", input: { text: sub20, page: "memory:now" } }] });
    transcript.request("POST", "/v0/onboarding/replay");
    const again = { state: "reading" as const };
    transcript.onboarding(again);
    transcript.response(200, again);
    transcript.post(question);
    const belief = transcript.belief();
    transcript.onboarding({
      state: "ready",
      proposal: { beliefs: [{ id: belief, text: sub20, page: "memory:now" }], added: [], motions: [] },
    });
    transcript.wait(30_000);
    transcript.answerBelief(belief, { answer: "true" });
    transcript.wait(5000);
    transcript.finishOnboarding();
    return transcript;
  },

  () => {
    const transcript = createTranscript({
      name: "71-problems-until-fixed",
      scenario: 71,
      title: "Problems, until they're fixed",
      summary:
        "With the app open, you switch Reports on but don't finish its setup, so the server lists it as a " +
        "problem, saying how to fix it. GitHub then rejects the token you give, and the problem says so. A good " +
        "token fixes it, and the problem clears on its own.",
      guarantees: ["G40"],
    });
    const settingUp = {
      id: "capability:reports",
      area: "capabilities",
      title: "Reports needs setting up",
      detail: "It's switched on, but its setup isn't finished, so it can't do anything yet.",
      fix: "Finish its setup in Settings › Capabilities › Reports, or switch it off.",
    };
    const rejected = {
      id: "capability:reports",
      area: "capabilities",
      title: "Reports isn't working",
      detail: "GitHub rejected the token.",
      fix: "Open Settings › Capabilities › Reports and do what it says.",
    };
    transcript.begin(todayAt);
    transcript.connect();
    transcript.wait(2000);
    transcript.request("PUT", "/v0/capabilities/reports", { body: { on: true } });
    transcript.problems([settingUp]);
    transcript.wait(60);
    transcript.response(200, reports("setup", false), { headers: { "Ito-Protocol": protocol } });
    transcript.wait(15_000);
    transcript.request("PUT", "/v0/capabilities/reports/setup", { body: { values: { token: "github_pat_revoked" } } });
    transcript.problems([rejected]);
    transcript.wait(60);
    transcript.response(200, reports("needs_you", true, "GitHub rejected the token."), {
      headers: { "Ito-Protocol": protocol },
    });
    transcript.wait(5000);
    capabilityCall(transcript, "GET", "/v0/problems", undefined, 200, { problems: [rejected] });
    transcript.wait(20_000);
    transcript.request("PUT", "/v0/capabilities/reports/setup", { body: { values: { token: "github_pat_example" } } });
    transcript.problems([]);
    transcript.wait(60);
    transcript.response(200, reports("on", true), { headers: { "Ito-Protocol": protocol } });
    return transcript;
  },

  () => {
    const transcript = createTranscript({
      name: "73-that-was-wrong",
      scenario: 73,
      title: "That was wrong",
      summary:
        "Kumo bins a mail from Acme as a promotion. You open Kumo's work and say it was wrong: the mail goes back " +
        "to your inbox, and Kumo keeps what to do differently on the track it belongs to, which Done says.",
      guarantees: ["G43"],
    });
    transcript.begin("2026-11-11T10:00:00.000Z");
    transcript.world("capability_on", {
      capability: "outlook",
      values: { address: "sam@outlook.example", token: "replay-token" },
    });
    transcript.connect();
    transcript.wait(1000);
    transcript.world("attention_decides", {
      decision: "promotion",
      stakes: "low",
      folder: "",
      reason: "Acme selling something",
      confidence: 0.86,
    });
    transcript.world("mail_arrives", {
      account: "outlook",
      message_id: "order-5531@acme.com",
      from: "Acme <hello@acme.com>",
      to: ["sam@outlook.example"],
      subject: "Your Acme order is on its way",
      text: "Good news! Your desk lamp ships today. Fancy 20% off your next order?",
    });
    transcript.mailRead();
    const text = 'Binned "Your Acme order is on its way" from Acme';
    const binned = transcript.addDone({
      text,
      reason: "Acme selling something",
      mail: {
        account: "outlook",
        message_id: "order-5531@acme.com",
        from: "Acme",
        subject: "Your Acme order is on its way",
      },
      undo: true,
    });
    transcript.wait(90_000);
    transcript.getWork({ handled: [binned], cleared: [] });
    const correctedAt = "2026-11-11T10:02:00.000Z";
    transcript.time(correctedAt);
    const words = "That was my order, not an offer";
    transcript.world("kumo_works", { calls: [] });
    transcript.request("POST", `/v0/done/${String(binned.id)}/wrong`, { body: { text: words } });
    const corrected = { ...binned, text: `Undone: ${text}`, undo: false, corrected_at: correctedAt };
    const noted = transcript.addDone({ text: `You said “${text}” was wrong: ${words}`, reason: "Done." });
    transcript.wait(60);
    transcript.response(200, { entry: corrected });
    transcript.wait(2000);
    transcript.getWork({ handled: [noted, corrected], cleared: [] });
    return transcript;
  },

  () => {
    const transcript = createTranscript({
      name: "74-the-day-made-visible",
      scenario: 74,
      title: "The day made visible",
      summary:
        "A free Sunday. Kumo plans the day on its own calendar: a run from the training block, groceries, prep " +
        "for Thursday's interview and winding down, plus its guess at the evening. Each shows in Coming up as it " +
        "lands, the guess marked as one, with why. You tap the guess: not right, you'll be building. It becomes " +
        "yours on Kumo's calendar, no longer a guess.",
      guarantees: ["G33", "G44"],
    });
    transcript.begin("2026-11-15T07:20:00.000Z");
    transcript.world("capability_on", {
      capability: "icloud",
      values: { apple_id: "divy@icloud.com", app_password: "abcd-efgh-ijkl-mnop" },
    });
    transcript.connect();
    transcript.wait(1000);
    const kumo = { name: "Kumo", kumo: true };
    const blocks = [
      {
        kind: "plan",
        title: "Easy run, week 1 of 6",
        start: "2026-11-15T10:30:00.000Z",
        end: "2026-11-15T11:00:00.000Z",
        activity: "training",
        why: "Week 1 of the sub-20 block: easy miles",
      },
      {
        kind: "plan",
        title: "Groceries",
        start: "2026-11-15T12:00:00.000Z",
        end: "2026-11-15T12:45:00.000Z",
        activity: "errands",
        why: "So there's food in for proper meals this week",
      },
      {
        kind: "plan",
        title: "Interview prep, 2h",
        start: "2026-11-15T15:00:00.000Z",
        end: "2026-11-15T17:00:00.000Z",
        activity: "studying",
        why: "The Northwind interview is on Thursday",
      },
      {
        kind: "guess",
        title: "Chilling",
        start: "2026-11-15T19:00:00.000Z",
        end: "2026-11-15T22:00:00.000Z",
        activity: "chilling",
        why: "Sunday evenings you usually switch off.",
      },
      {
        kind: "plan",
        title: "Wind down",
        start: "2026-11-15T23:45:00.000Z",
        end: "2026-11-16T00:30:00.000Z",
        activity: "rest",
        why: "In bed by 00:30 so Monday works",
      },
    ];
    const items = blocks.map(({ kind, title, start, end, activity, why }, index) => {
      transcript.world("agent_calls", { tool: "plan_block", input: blocks[index] });
      return transcript.calendarItem({
        uid: transcript.eventUid(),
        title,
        start,
        end,
        all_day: false,
        calendar: kumo,
        status: "confirmed",
        ...(kind === "guess" && { guess: { activity: activity as "chilling", why } }),
      });
    });
    for (const index of items.keys()) transcript.comingUp(items.slice(0, index + 1));
    transcript.wait(40 * 60 * 1000);
    const evening = items[3];
    if (!evening) throw new Error("no evening guess");
    const building = Object.fromEntries(
      Object.entries({ ...evening, title: "Building" }).filter(([field]) => field !== "guess"),
    ) as typeof evening;
    transcript.answerGuess(evening, { activity: "building" }, building);
    return transcript;
  },

  () => {
    const transcript = createTranscript({
      name: "78-a-wake-up",
      scenario: 78,
      title: "A wake-up",
      summary:
        "Kumo sets itself a wake-up for when Thursday's technical ends, so it can ask how it went. Setting it is " +
        "quiet: it only joins Kumo's plans on the Desk. At 15:30 it comes due, Kumo looks and messages you, and " +
        "Done says so. The plan has gone from the Desk.",
      guarantees: ["G33", "G49", "G50"],
    });
    transcript.begin("2026-11-12T09:00:00.000Z");
    transcript.connect();
    transcript.registerDevice();
    transcript.wait(1000);
    const plain = "Ask how the technical went";
    const what = "Ask how the Halcyon technical went";
    const why = "It ends at 15:30, and you wanted to talk it through while it's fresh.";
    const title = "Halcyon technical, Thu 14:00";
    transcript.world("agent_calls", {
      tool: "set_wake_up",
      input: {
        title: plain,
        what,
        why,
        at: "2026-11-12T15:30:00Z",
        asked: false,
        source: { kind: "calendar", title, event_uid: halcyonTechnical.uid },
      },
    });
    transcript.wakeUp({
      at: halcyonTechnical.end,
      title: plain,
      what,
      why,
      by: "kumo",
      source: { kind: "calendar", title, event: { uid: halcyonTechnical.uid } },
    });
    transcript.wait(2000);
    transcript.listWakeUps();
    const asked = "How did the technical go? Tell me while it's fresh, and I'll note what to work on.";
    transcript.world("kumo_works", { calls: [], post: asked });
    transcript.time(halcyonTechnical.end);
    transcript.post(asked);
    transcript.addDone({ text: `Woke up for “${plain}” and messaged you`, reason: "Done." });
    transcript.plans([]);
    return transcript;
  },

  () => {
    const transcript = createTranscript({
      name: "79-kumos-plans-are-yours",
      scenario: 79,
      title: "Kumo's plans are yours",
      summary:
        "You asked Kumo to look at each weekday morning with you, and it set itself a follow-up on Clara's reply. " +
        "Both are in Kumo's plans. You move tomorrow's morning look to 10:00 and cancel the follow-up; the Desk " +
        "follows each change.",
      guarantees: ["G33", "G49"],
    });
    transcript.begin("2026-11-10T19:00:00.000Z");
    transcript.connect();
    transcript.wait(1000);
    const morning = {
      plain: "Look at the day with you",
      what: "Shape the day with you if it's unplanned",
      why: "You asked for a look at each weekday morning; your days shift a lot.",
      repeat: { days: ["mon", "tue", "wed", "thu", "fri"], time: "08:30" },
      title: "“Look at my day with me each weekday morning”",
    } as const;
    transcript.world("agent_calls", {
      tool: "set_wake_up",
      input: {
        title: morning.plain,
        what: morning.what,
        why: morning.why,
        repeat: morning.repeat,
        asked: true,
        source: { kind: "chat", title: morning.title },
      },
    });
    const daily = transcript.wakeUp({
      at: "2026-11-11T08:30:00.000Z",
      title: morning.plain,
      what: morning.what,
      why: morning.why,
      repeat: { days: [...morning.repeat.days], time: morning.repeat.time },
      by: "you",
      source: { kind: "chat", title: morning.title },
    });
    transcript.wait(1000);
    const chase = {
      plain: "Chase Clara's reply",
      what: "See whether Clara replied about the call",
      why: "You offered Thursday or Friday; if she's quiet by Wednesday evening, a short nudge keeps it moving.",
      title: "Clara Voss: AI Engineer, FI",
    };
    transcript.world("agent_calls", {
      tool: "set_wake_up",
      input: {
        title: chase.plain,
        what: chase.what,
        why: chase.why,
        at: "2026-11-11T18:00:00Z",
        asked: false,
        source: { kind: "mail", title: chase.title, account: "outlook", message_id: "role-1@northwind.example" },
      },
    });
    const followUp = transcript.wakeUp({
      at: "2026-11-11T18:00:00.000Z",
      title: chase.plain,
      what: chase.what,
      why: chase.why,
      by: "kumo",
      source: {
        kind: "mail",
        title: chase.title,
        mail: { message_id: "role-1@northwind.example", account: "outlook" },
      },
    });
    transcript.wait(30_000);
    transcript.listWakeUps();
    transcript.wait(5000);
    transcript.request("PATCH", `/v0/wakeups/${daily.id}`, { body: { at: "2026-11-11T10:00:00.000Z" } });
    const later = { ...daily, at: "2026-11-11T10:00:00.000Z" };
    transcript.plans([later, followUp]);
    transcript.response(200, { wake_up: later });
    transcript.wait(4000);
    transcript.request("DELETE", `/v0/wakeups/${followUp.id}`);
    transcript.plans([later]);
    transcript.response(204, undefined);
    return transcript;
  },

  () => {
    const transcript = createTranscript({
      name: "80-your-day-changes",
      scenario: 80,
      title: "Your day changes",
      summary:
        "Kumo has a wake-up for after Thursday's technical. Tess moves the technical to 16:00 on your calendar. " +
        "Kumo wakes on the change, moves its wake-up to the new end and tells you in a message.",
      guarantees: ["G50", "G51"],
    });
    transcript.begin("2026-11-12T09:00:00.000Z");
    const event = {
      uid: halcyonTechnical.uid,
      title: halcyonTechnical.title,
      start: halcyonTechnical.start,
      end: halcyonTechnical.end,
      location: halcyonTechnical.location,
    };
    transcript.world("calendar_has", { events: [event] });
    transcript.world("capability_on", {
      capability: "icloud",
      values: { apple_id: "divy@icloud.com", app_password: "abcd-efgh-ijkl-mnop" },
    });
    // Read once more, so the calendar Kumo first saw is all read before the app connects.
    transcript.world("calendar_has", { events: [event] });
    const technical = transcript.calendarItem(halcyonTechnical);
    transcript.comingUp([technical]);
    transcript.connect();
    transcript.registerDevice();
    transcript.wait(1000);
    const plain = "Ask how the technical went";
    const what = "Ask how the Halcyon technical went";
    const why = "It ends at 15:30, and you wanted to talk it through while it's fresh.";
    const title = "Halcyon technical, Thu 14:00";
    transcript.world("agent_calls", {
      tool: "set_wake_up",
      input: {
        title: plain,
        what,
        why,
        at: "2026-11-12T15:30:00Z",
        asked: false,
        source: { kind: "calendar", title, event_uid: event.uid },
      },
    });
    const wakeUp = transcript.wakeUp({
      at: halcyonTechnical.end,
      title: plain,
      what,
      why,
      by: "kumo",
      source: { kind: "calendar", title, event: { uid: event.uid } },
    });
    transcript.wait(2 * 60 * 60 * 1000);
    const moved = { ...event, start: "2026-11-12T16:00:00.000Z", end: "2026-11-12T17:30:00.000Z" };
    const told = "Tess moved your technical to 4, so I'll ask how it went after half five.";
    transcript.world("kumo_works", {
      calls: [{ tool: "move_wake_up", input: { id: wakeUp.id, at: "2026-11-12T17:30:00Z" } }],
      post: told,
    });
    transcript.world("calendar_has", { events: [moved] });
    transcript.comingUp([{ ...technical, start: moved.start, end: moved.end }]);
    transcript.plans([{ ...wakeUp, at: moved.end }]);
    transcript.post(told);
    return transcript;
  },

  () => {
    const transcript = createTranscript({
      name: "81-when-kumo-cant-work",
      scenario: 81,
      title: "When Kumo can't work",
      summary:
        "A wake-up comes due while Kumo's model isn't answering. Nothing robotic is sent in its place: the " +
        "wake-up waits a quarter of an hour, and once the trouble has lasted ten minutes it shows as a problem. " +
        "When the model answers again, Kumo looks, messages you, and the problem clears.",
      guarantees: ["G40", "G52"],
    });
    transcript.begin("2026-11-12T15:20:00.000Z");
    transcript.connect();
    transcript.registerDevice();
    transcript.wait(1000);
    const plain = "Ask how the technical went";
    const what = "Ask how the Halcyon technical went";
    const why = "It ends at 15:30, and you wanted to talk it through while it's fresh.";
    const source = { kind: "chat" as const, title: "“Ask me how it went after”" };
    transcript.world("agent_calls", {
      tool: "set_wake_up",
      input: { title: plain, what, why, at: "2026-11-12T15:30:00Z", asked: true, source },
    });
    const wakeUp = transcript.wakeUp({ at: halcyonTechnical.end, title: plain, what, why, by: "you", source });
    const reason = "The model service answered 503 Service Unavailable.";
    transcript.world("kumo_cant_work", { reason });
    transcript.time(halcyonTechnical.end);
    transcript.plans([{ ...wakeUp, at: "2026-11-12T15:45:00.000Z" }]);
    transcript.time("2026-11-12T15:40:00.000Z");
    transcript.problems([
      {
        id: "kumo:work",
        area: "kumo",
        title: "Kumo can't work in the background",
        detail: `Its model didn't answer, so what it was doing waits until it does: ${reason}`,
        fix: "Kumo catches up on its own. If it goes on, check Settings › Model, or sign in again with ito login on the server.",
      },
    ]);
    const asked = "How did the technical go?";
    transcript.world("kumo_works", { calls: [], post: asked });
    transcript.time("2026-11-12T15:45:00.000Z");
    transcript.post(asked);
    transcript.problems([]);
    transcript.addDone({ text: `Woke up for “${plain}” and messaged you`, reason: "Done." });
    transcript.plans([]);
    return transcript;
  },

  () => {
    const transcript = createTranscript({
      name: "82-learning-an-area",
      scenario: 82,
      title: "Learning an area",
      summary:
        "Kumo opens a learning track for writing as you, and after weeks of drafts you sent as it wrote them, moves " +
        "it to spot checks. Its next draft to Clara is recorded on the track. You say it was wrong: too formal. The " +
        "track steps back to learning, with your correction as evidence, and Kumo's work shows it.",
      guarantees: ["G43", "G53"],
    });
    transcript.begin("2026-11-12T10:00:00.000Z");
    transcript.connect();
    transcript.wait(1000);
    const name = "Writing as you";
    const note = "How you write to recruiters and friends.";
    transcript.world("agent_calls", { tool: "open_track", input: { name, note } });
    const track = {
      id: transcript.track(),
      name,
      stage: "learning",
      since: "2026-11-12T10:00:01.000Z",
      note,
      confirmed: 0,
      corrected: 0,
      evidence: [] as readonly Readonly<Record<string, unknown>>[],
    };
    transcript.wait(1000);
    transcript.getWork({ handled: [], cleared: [], tracks: [track] });
    transcript.wait(60_000);
    const why = "Three weeks of drafts you sent as I wrote them";
    transcript.world("agent_calls", { tool: "move_track", input: { track: track.id, stage: "spot_checks", why } });
    const movedAt = "2026-11-12T10:01:02.000Z";
    const moved = {
      ...track,
      stage: "spot_checks",
      since: movedAt,
      evidence: [{ at: movedAt, kind: "moved", text: why, stage: "spot_checks" }],
    };
    transcript.wait(60_000);
    const text = "Drafted a reply to Clara Voss at Northwind";
    transcript.world("agent_calls", {
      tool: "done",
      input: { text, reason: "She asked for times next week.", track: track.id },
    });
    const drafted = transcript.addDone({ text, reason: "She asked for times next week.", track: track.id });
    transcript.wait(30 * 60 * 1000);
    transcript.getWork({ handled: [drafted], cleared: [], tracks: [moved] });
    const correctedAt = "2026-11-12T10:33:02.000Z";
    transcript.time(correctedAt);
    const words = "Too formal for Clara";
    transcript.world("kumo_works", { calls: [] });
    transcript.request("POST", `/v0/done/${String(drafted.id)}/wrong`, { body: { text: words } });
    const noted = transcript.addDone({ text: `You said “${text}” was wrong: ${words}`, reason: "Done." });
    transcript.wait(60);
    const corrected = { ...drafted, corrected_at: correctedAt };
    transcript.response(200, { entry: corrected });
    transcript.wait(2000);
    transcript.getWork({
      handled: [noted, corrected],
      cleared: [],
      tracks: [
        {
          ...moved,
          stage: "learning",
          since: correctedAt,
          corrected: 1,
          evidence: [
            {
              at: correctedAt,
              kind: "corrected",
              text: `You said “${text}” was wrong: ${words}`,
              stage: "learning",
              done: drafted.id,
            },
            ...moved.evidence,
          ],
        },
      ],
    });
    return transcript;
  },

  () => {
    const transcript = createTranscript({
      name: "83-travelling",
      scenario: 83,
      title: "Travelling",
      summary:
        "Your phone tells the box its time zone and, roughly, where it is: London. The Desk shows the weather there " +
        "and today's sunset. You fly to New York. The box keeps only the latest place, rounded; your weekday " +
        "morning look moves to 09:00 New York time at once, Kumo looks at the rest of its plans, and the Desk's " +
        "weather is New York's.",
      guarantees: ["G54", "G55"],
    });
    const london = { latitude: 51.5, longitude: -0.1 };
    const newYork = { latitude: 40.7, longitude: -74 };
    transcript.begin("2026-11-14T08:00:00.000Z");
    transcript.world("web_has", {
      url: weather(london),
      json: {
        utc_offset_seconds: 0,
        current: { temperature_2m: 9.4, weather_code: 61, is_day: 1 },
        daily: { sunset: ["2026-11-14T16:12"] },
      },
    });
    transcript.world("web_has", {
      url: weather(newYork),
      json: {
        utc_offset_seconds: -18_000,
        current: { temperature_2m: 12.6, weather_code: 1, is_day: 1 },
        daily: { sunset: ["2026-11-14T16:42"] },
      },
    });
    transcript.connect();
    transcript.registerDevice();
    transcript.wait(1000);
    const look = {
      plain: "Look at the day with you",
      what: "Shape the day with you if it's unplanned",
      why: "You asked for a look at each weekday morning.",
      repeat: { days: ["mon", "tue", "wed", "thu", "fri"], time: "09:00" },
      title: "“Look at my day with me each weekday morning”",
    } as const;
    transcript.world("agent_calls", {
      tool: "set_wake_up",
      input: {
        title: look.plain,
        what: look.what,
        why: look.why,
        repeat: look.repeat,
        asked: true,
        source: { kind: "chat", title: look.title },
      },
    });
    const morning = transcript.wakeUp({
      at: "2026-11-16T09:00:00.000Z",
      title: look.plain,
      what: look.what,
      why: look.why,
      repeat: { days: [...look.repeat.days], time: look.repeat.time },
      by: "you",
      source: { kind: "chat", title: look.title },
    });
    transcript.wait(1000);
    transcript.whereabouts({
      time_zone: "Europe/London",
      area: { latitude: 51.5072, longitude: -0.1276, name: "London" },
    });
    transcript.ambient({
      temperature: 9,
      condition: "rain",
      is_day: true,
      sunset: "2026-11-14T16:12:00.000Z",
      place: "London",
    });
    transcript.time("2026-11-14T15:00:00.000Z");
    transcript.world("kumo_works", { calls: [] });
    transcript.whereabouts({
      time_zone: "America/New_York",
      area: { latitude: 40.7128, longitude: -74.006, name: "New York" },
    });
    transcript.plans([{ ...morning, at: "2026-11-16T14:00:00.000Z" }]);
    transcript.ambient({
      temperature: 13,
      condition: "partly_cloudy",
      is_day: true,
      sunset: "2026-11-14T21:42:00.000Z",
      place: "New York",
    });
    transcript.wait(5000);
    transcript.request("GET", "/v0/server");
    transcript.response(200, {
      name: "studio",
      version: serverVersion,
      protocol,
      lead: { name: "Kumo" },
      time_zone: "America/New_York",
      whereabouts: {
        time_zone: "America/New_York",
        area: { ...newYork, name: "New York" },
        as_of: "2026-11-14T15:00:00.000Z",
      },
      agent: {},
      setup: { notifications: true, memory_backup: false },
      capabilities: [],
    });
    return transcript;
  },

  () => {
    const transcript = createTranscript({
      name: "84-kumos-line-and-mood",
      scenario: 84,
      title: "Kumo's line and mood",
      summary:
        "With the Northwind prep under way, Kumo puts a short line at the top of the Desk with a focused face. " +
        "When the deck is done it changes both: proud. Neither notifies.",
      guarantees: ["G33", "G56"],
    });
    transcript.begin("2026-11-12T09:30:00.000Z");
    transcript.connect();
    transcript.registerDevice();
    transcript.wait(1000);
    const working = { text: "Quiet morning. The Northwind deck is two-thirds done.", mood: "focused" };
    transcript.world("agent_calls", { tool: "set_desk_line", input: working });
    transcript.deskLine({ ...working, at: "2026-11-12T09:30:01.000Z" });
    transcript.wait(3 * 60 * 60 * 1000);
    const done = { text: "The Northwind deck is done, a day early.", mood: "proud" };
    transcript.world("agent_calls", { tool: "set_desk_line", input: done });
    transcript.deskLine({ ...done, at: "2026-11-12T12:30:01.000Z" });
    return transcript;
  },

  () => {
    const transcript = createTranscript({
      name: "87-chapters-and-what-kumo-learnt",
      scenario: 87,
      title: "Chapters and what Kumo learnt",
      summary:
        "You're home from Florence. Kumo keeps the trip as a chapter of your life, a short story that began and " +
        "ended, linked to the journal days it draws on, and learns something about you on the way. Tidying a page " +
        "teaches it nothing, so it adds no line. The Library shows the chapter in its own row, what Kumo learnt " +
        "lately, newest first, and the chapter's page with when Kumo noticed it and what it drew on.",
      guarantees: ["G58"],
    });
    const seededAt = "2026-11-10T18:00:00.000Z";
    const mira = {
      address: "memory:people/mira",
      title: "Mira",
      gist: "Your oldest friend, from school",
      aliases: ["Mimi"],
      links: [],
      markdown: "Your oldest friend; you met at school in Pune (as of 20 Oct).\n",
      note: "Oldest friend, from school",
      circle: "friends",
    };
    const days = [
      {
        address: "memory:journal/2026-11-05",
        title: "5 November 2026",
        gist: "Florence: the Uffizi at opening",
        aliases: [],
        links: [],
        markdown: "### 21:40\n\nThe Uffizi at opening with Mira, then a long lunch.\n",
        note: "The Uffizi",
      },
      {
        address: "memory:journal/2026-11-06",
        title: "6 November 2026",
        gist: "Florence: rain, and a bookshop café",
        aliases: [],
        links: [],
        markdown: "### 22:05\n\nRain all day, so a bookshop café near Santo Spirito instead.\n",
        note: "The rainy day",
      },
    ];
    const half = {
      address: "memory:goals/half-marathon",
      title: "Half marathon",
      gist: "A half in March",
      aliases: [],
      links: [],
      markdown: "A half marathon in March (as of 2 Nov).\n",
      note: "The March half",
      learnt: "Half marathons suit you more than 5Ks.",
    };
    const trips = {
      address: "memory:topics/trips",
      title: "Trips",
      gist: "How you like to travel",
      aliases: [],
      links: [],
      markdown: "You like a plan for the first days of a trip (as of 2 Nov).\n",
      note: "How you travel",
    };
    const chapter = {
      address: "memory:chapters/florence-with-mira",
      title: "Florence with Mira",
      gist: "Six days in Florence for Mira's birthday",
      aliases: [],
      links: [mira.address, ...days.map(({ address }) => address)],
      markdown:
        "You'd been promising Mira Florence since spring, and went for her birthday week. The first days were " +
        "all plans; then the rain cancelled everything, and a bookshop café near Santo Spirito turned out the " +
        "best day.\n\n## What changed\n\n- You want an empty day in every trip now.\n",
    };
    const learnt = "You want an empty day in every trip now: the unplanned one tends to be the best.";
    transcript.begin(seededAt);
    transcript.world("memory_holds", { pages: [mira, ...days, half, trips] });
    transcript.wait(60 * 60 * 1000);
    transcript.connect();
    transcript.wait(2000);
    sendAndStart(
      transcript,
      "Home from Florence! The rainy day in that bookshop café was the best one. Every trip gets an empty day now.",
    );
    transcript.wait(700);
    const written = transcript.change();
    agentCalls(transcript, "write_page", {
      address: chapter.address,
      title: chapter.title,
      gist: chapter.gist,
      note: "Noticed Florence with Mira",
      began: "2026-11-04",
      ended: "2026-11-09",
      links: chapter.links,
      body: chapter.markdown,
    });
    memoryStep(
      transcript,
      "updated",
      [{ address: chapter.address, title: chapter.title }],
      { title: "Updating Florence with Mira", endedTitle: "Updated Florence with Mira" },
      written,
    );
    transcript.wait(400);
    const taught = transcript.change();
    agentCalls(transcript, "edit_page", {
      address: trips.address,
      version: "seeded",
      old_text: "You like a plan for the first days of a trip (as of 2 Nov).",
      new_text: "You like a plan for the first days of a trip, and an empty day in every one (as of 10 Nov).",
      note: "An empty day in every trip",
      learnt,
    });
    memoryStep(
      transcript,
      "updated",
      [{ address: trips.address, title: trips.title }],
      { title: "Updating Trips", endedTitle: "Updated Trips" },
      taught,
    );
    transcript.wait(400);
    const tidied = transcript.change();
    agentCalls(transcript, "edit_page", {
      address: mira.address,
      version: "seeded",
      old_text: "(as of 20 Oct)",
      new_text: "(as of 20 October)",
      note: "Tidied the date",
    });
    memoryStep(
      transcript,
      "updated",
      [{ address: mira.address, title: mira.title }],
      { title: "Updating Mira", endedTitle: "Updated Mira" },
      tidied,
    );
    transcript.wait(300);
    writeWhole(transcript, "Welcome home. I've kept Florence as a chapter, rainy day and all.");
    transcript.endTurn("completed");
    transcript.wait(5000);
    const turnAt = Date.parse(seededAt) + 60 * 60 * 1000 + 2000;
    const writtenAt = new Date(turnAt + 700).toISOString();
    const taughtAt = new Date(turnAt + 1100).toISOString();
    memoryCall(transcript, "/v0/memory/chapters", {
      chapters: [
        {
          address: chapter.address,
          title: chapter.title,
          gist: chapter.gist,
          began: "2026-11-04",
          ended: "2026-11-09",
          changed_at: writtenAt,
        },
      ],
    });
    transcript.wait(1000);
    memoryCall(transcript, "/v0/memory/learnt", {
      lines: [
        { text: learnt, at: taughtAt, address: trips.address, change: taught },
        { text: half.learnt, at: seededAt, address: half.address, change: transcript.change() },
      ],
    });
    transcript.wait(2000);
    memoryCall(transcript, `/v0/memory/page?address=${chapter.address}`, {
      ...pageBody(chapter, writtenAt, [mira, ...days]),
      chapter: {
        began: "2026-11-04",
        ended: "2026-11-09",
        noticed: "2026-11-10",
        drawn_from: { journal_days: 2, photos: 0 },
      },
    });
    transcript.wait(2000);
    memoryCall(transcript, "/v0/memory/shelves", {
      shelves: [
        { shelf: "people", count: 1 },
        { shelf: "groups", count: 0 },
        { shelf: "goals", count: 1 },
        { shelf: "projects", count: 0 },
        { shelf: "places", count: 0 },
        { shelf: "topics", count: 1 },
        { shelf: "journal", count: 2 },
      ],
    });
    return transcript;
  },

  () => {
    const transcript = createTranscript({
      name: "85-a-long-quiet-stretch",
      scenario: 85,
      title: "A long quiet stretch",
      summary:
        "Kumo works for minutes with nothing to show, as it does while it writes a long document in one tool " +
        "call. Nothing fails on its own: the turn keeps running and its status stays on what it was last doing. " +
        "When the model's stream drops mid-reply, the half-written reply is discarded, since the model writes it " +
        "again from the start, and the status says it's reconnecting. Stop ends the turn whenever you choose, " +
        "keeping the note it wrote.",
      guarantees: ["G6", "G7", "G10"],
    });
    yesterday(transcript);
    transcript.begin(todayAt, { cursor: "latest" });
    transcript.connect();
    transcript.wait(2000);
    const { turn } = sendAndStart(transcript, "Write my whole Lisbon trip into one document I can print.");
    transcript.wait(300);
    transcript.step("thinking", thinking);
    transcript.wait(1500);
    transcript.endStep();
    transcript.reply("note");
    transcript.write("I'll put every day in one document, with the bookings at the end.", { pieces: 3 });
    transcript.endMessage("completed");
    transcript.wait(4 * 60_000);
    transcript.status("writing", "Writing");
    transcript.reply();
    transcript.write("Your Lisbon document is ready: four days, from the tram up to", { pieces: 3 });
    transcript.wait(2000);
    transcript.endMessage("discarded");
    transcript.status("waiting", "Reconnecting to the model");
    transcript.wait(3 * 60_000);
    transcript.stop(turn);
    transcript.status("stopping", "Stopping");
    transcript.wait(150);
    transcript.endTurn("stopped");
    return transcript;
  },

  () => {
    const transcript = createTranscript({
      name: "86-when-kumos-paused",
      scenario: 86,
      title: "When Kumo's paused",
      summary:
        "A wake-up comes due just as Kumo's model reaches its plan's usage limit. Background work pauses until " +
        "the limit resets, shown at once as a problem that says when; nothing is retried meanwhile. When it " +
        "resets, Kumo catches up once on what it missed and tells you in one message, and the problem clears.",
      guarantees: ["G40", "G57"],
    });
    transcript.begin("2026-11-12T15:20:00.000Z");
    transcript.connect();
    transcript.registerDevice();
    transcript.wait(1000);
    const plain = "Ask how the technical went";
    const what = "Ask how the Halcyon technical went";
    const why = "It ends at 15:30, and you wanted to talk it through while it's fresh.";
    const source = { kind: "chat" as const, title: "“Ask me how it went after”" };
    transcript.world("agent_calls", {
      tool: "set_wake_up",
      input: { title: plain, what, why, at: "2026-11-12T15:30:00Z", asked: true, source },
    });
    transcript.wakeUp({ at: halcyonTechnical.end, title: plain, what, why, by: "you", source });
    transcript.world("usage_limit_reached", { resets_at: "2026-11-12T18:00:00.000Z" });
    transcript.time(halcyonTechnical.end);
    transcript.problems([
      {
        id: "kumo:paused",
        area: "kumo",
        title: "Kumo's paused until 18:00",
        detail:
          "Your plan's usage limit was reached, so wake-ups and mail wait until it resets. Then Kumo catches up " +
          "once, and tells you in one message what it missed.",
        fix:
          "Nothing to do: Kumo picks up on its own. To go on sooner, add usage to your plan; Kumo starts again as " +
          "soon as a message in the chat goes through.",
      },
    ]);
    const caughtUp =
      "I was paused from 15:30 by your plan's usage limit, so I missed asking after the Halcyon technical. " +
      "How did it go?";
    transcript.world("kumo_works", { calls: [], answer: caughtUp });
    transcript.time("2026-11-12T18:00:00.000Z");
    transcript.problems([]);
    transcript.addDone({ text: `Woke up late for “${plain}”`, reason: "Caught up after Kumo's pause", quiet: true });
    transcript.plans([]);
    transcript.post(caughtUp);
    return transcript;
  },

  () => {
    const transcript = createTranscript({
      name: "88-reply-in-a-thread",
      scenario: 88,
      title: "Reply in a thread",
      summary:
        "Yesterday you replied to one of Kumo's messages, which started a thread under it, and Kumo named it. " +
        "The snapshot carries the thread with the message it hangs from. In the thread, a reply quotes the " +
        "message it answers. You move a message that belongs in the main chat, rename the thread and mark it " +
        "done; replying opens it again.",
      guarantees: ["G29"],
    });
    yesterday(transcript);
    transcript.wait(60_000);
    const morning = transcript.exchange(
      "Lunch with Lena is at 12:30 on Saturday.",
      "Then Saturday morning's yours. An easy 5k first?",
    );
    transcript.wait(30_000);
    const pace = transcript.exchange(
      "Yes, slow. What pace?",
      "Slower than 6:30 a km, and stop at five even if you feel good.",
      [],
      { replyTo: morning.agent },
    );
    const thread = transcript.threadOf(pace.user) ?? "";
    transcript.changeThread(thread, { title: "Easy 5k" });
    transcript.begin(todayAt);
    transcript.connect();
    transcript.wait(2000);
    transcript.world("thread_opened", { thread });
    transcript.getThread(thread);
    transcript.wait(3000);
    const legs = transcript.send("Done. Legs were heavy but I did it", { thread, replyTo: pace.agent });
    transcript.inThread(thread, () => {
      transcript.startTurn([legs]);
      transcript.wait(300);
      transcript.step("thinking", thinking);
      transcript.wait(900);
      writeWhole(transcript, "Heavy legs after a long week are normal, and you went anyway. 5.1 km, logged.");
      transcript.endTurn("completed");
    });
    transcript.wait(4000);
    const aside = transcript.send("And remind me to call Mum tonight", { thread });
    transcript.inThread(thread, () => {
      transcript.startTurn([aside]);
      transcript.wait(300);
      writeWhole(transcript, "I'll nudge you at seven.");
      transcript.endTurn("completed");
    });
    transcript.wait(5000);
    transcript.moveMessage(aside);
    transcript.wait(3000);
    transcript.patchThread(thread, { title: "Saturday run" });
    transcript.wait(1000);
    transcript.patchThread(thread, { state: "done" });
    transcript.wait(60_000);
    const again = transcript.send("One more: should I stretch after?", { thread });
    transcript.inThread(thread, () => {
      transcript.startTurn([again]);
      transcript.wait(300);
      writeWhole(transcript, "Five minutes, gently: calves and hamstrings. Nothing that hurts.");
      transcript.endTurn("completed");
    });
    return transcript;
  },

  () => {
    const transcript = createTranscript({
      name: "89-kumo-comes-back-to-a-thread",
      scenario: 89,
      title: "Kumo comes back to a thread",
      summary:
        "You start a thread of your own from Threads, and Kumo names it after answering. Later its background work " +
        "posts the news there: the thread's line moves to the end of the main chat with a dot and the news, and the " +
        "notification says which thread. Opening it clears the dot; once you're sorted, Kumo marks it done, and " +
        "searching Threads finds it by a word in it.",
      guarantees: ["G29", "G15"],
    });
    yesterday(transcript);
    transcript.begin(todayAt, { cursor: "latest" });
    transcript.connect();
    transcript.registerDevice();
    transcript.wait(2000);
    const ask = transcript.send("Can you get me a haircut on Saturday morning, near home?", { newThread: true });
    const thread = transcript.threadOf(ask) ?? "";
    transcript.inThread(thread, () => {
      transcript.startTurn([ask]);
      transcript.world("thread_named", { title: "Haircut" });
      transcript.wait(300);
      transcript.step("thinking", thinking);
      transcript.wait(1500);
      writeWhole(
        transcript,
        "I've asked Theo on the high street for 11:00 or 11:30. I'll tell you here when he answers.",
      );
      transcript.endTurn("completed");
    });
    transcript.changeThread(thread, { title: "Haircut" });
    transcript.wait(2 * 60 * 60 * 1000);
    const news = "Theo confirmed you for 11:30 on Saturday. It's in your calendar.";
    transcript.world("agent_calls", { tool: "post", input: { text: news, thread } });
    transcript.post(news, { thread });
    transcript.wait(30_000);
    transcript.world("notification_tapped", { thread });
    transcript.getThread(thread);
    transcript.seeThread(thread);
    transcript.wait(5000);
    const thanks = transcript.send("Perfect, thanks", { thread });
    transcript.inThread(thread, () => {
      transcript.startTurn([thanks]);
      transcript.wait(300);
      writeWhole(transcript, "Enjoy. Bring the photo you showed me last time.");
      const result = "Theo, Saturday 11:30";
      transcript.world("agent_calls", { tool: "update_thread", input: { state: "done", result }, thread });
      transcript.changeThread(thread, { state: "done", result });
      transcript.wait(200);
      transcript.endTurn("completed");
    });
    transcript.wait(60_000);
    transcript.listThreads("theo");
    return transcript;
  },

  () => {
    const transcript = createTranscript({
      name: "90-a-reply-that-shows",
      scenario: 90,
      title: "A reply that shows",
      summary:
        "You ask what to order at a restaurant. Kumo answers with shape: a phone-sized table of the menu with its " +
        "verdict on each dish as a chip, its picks in order with a picture, a price and a line each, the total for " +
        "two, and a question with choices. A friend's name links to her page in memory.",
      guarantees: ["G31"],
    });
    transcript.begin("2026-11-21T12:40:00.000Z");
    transcript.connect();
    transcript.wait(2000);
    sendAndStart(transcript, "What should we get at Hearth? Two of us, not too heavy.");
    transcript.wait(600);
    const dishes = [
      ["noodles", "Clay pot glass noodles"],
      ["laab", "Langoustine laab"],
      ["skewers", "Lamb skewers"],
      ["greens", "Wild ginger greens"],
      ["rice", "Sticky rice"],
    ] as const;
    const pictures = dishes.map(([name, dish]) => {
      const url = `https://photos.example.org/hearth-${name}.jpg`;
      transcript.world("web_has", { url, file: "riverside.jpg" });
      const attachment = transcript.keptImage("riverside.jpg", `hearth-${name}.jpg`);
      agentCalls(transcript, "keep_image", { url }, { attachment });
      transcript.wait(300);
      return {
        attachment,
        alt: dish,
        source_url: `https://commons.example.org/wiki/File:${name}.jpg`,
        credit: "Photo by J. Example, CC BY 4.0",
      };
    });
    const [noodles, laab, skewers, greens, rice] = pictures;
    writeWhole(
      transcript,
      [
        "Good menu. It's northern Thai, cooked over wood, all small plates to share: four or five between two, " +
          "plus rice.",
        "",
        "```ari:table",
        JSON.stringify({
          columns: ["Dish", "My take"],
          rows: [
            {
              name: "Clay pot glass noodles",
              detail: "Pork belly, brown crab, white pepper",
              verdict: { label: "Must try", tone: "strong" },
            },
            {
              name: "Langoustine laab",
              detail: "Minced, toasted rice, herbs, lime",
              verdict: { label: "Must try", tone: "strong" },
            },
            {
              name: "Lamb & cumin skewers",
              detail: "Aged lamb, charred over wood",
              verdict: { label: "Recommended", tone: "good" },
            },
            {
              name: "Jungle curry",
              detail: "Pork, fiery, no coconut",
              verdict: { label: "If you like heat", tone: "quiet" },
            },
            {
              name: "Isaan sausage",
              detail: "Fermented pork, ginger, peanut",
              verdict: { label: "Skip today", tone: "quiet" },
            },
            { name: "Sticky rice", detail: "Steamed in a basket", verdict: { label: "Best value", tone: "neutral" } },
          ],
        }),
        "```",
        "",
        "```ari:picks",
        JSON.stringify({
          title: "What I'd order",
          picks: [
            {
              name: "Clay pot glass noodles",
              detail: "£9.50",
              why: "What people come for: smoky, peppery, crab all through it.",
              image: noodles,
            },
            {
              name: "Langoustine laab",
              detail: "£11",
              why: "Bright and sharp, so it cuts the richness of the noodles.",
              image: laab,
            },
            {
              name: "Lamb skewers",
              detail: "£8",
              why: "Two skewers, easy to split, properly charred.",
              image: skewers,
            },
            {
              name: "Wild ginger greens",
              detail: "£6.50",
              why: "Something green, since you said not too heavy.",
              image: greens,
            },
            {
              name: "Sticky rice × 2",
              detail: "£7",
              why: "For the laab's juices. You'll want the second.",
              image: rice,
            },
          ],
        }),
        "```",
        "",
        "```ari:number",
        JSON.stringify({
          label: "Estimated for two",
          value: "£47",
          context: "Five plates and rice. £53 with the 12.5% service.",
        }),
        "```",
        "",
        "Want a drink matched to it, or is that the lot?",
        "",
        "```ari:choices",
        JSON.stringify({ options: ["Add drinks", "Lighter swap", "That's the lot"] }),
        "```",
      ].join("\n"),
    );
    transcript.endTurn("completed");
    transcript.wait(1500);
    transcript.fetchAttachment(noodles?.attachment ?? "");
    transcript.wait(30_000);
    sendAndStart(transcript, "That's the lot");
    transcript.wait(700);
    writeWhole(transcript, "Enjoy. Say hi to [Maya](memory:people/maya-lind).");
    transcript.endTurn("completed");
    return transcript;
  },

  () => {
    const transcript = createTranscript({
      name: "91-a-page-kumo-made",
      scenario: 91,
      title: "A page Kumo made",
      summary:
        "You ask what not to miss at a museum. Kumo makes a page, a guide in walking order with things to spot, and " +
        "answers in a few sentences with a card that opens it. You open it. The next morning Kumo keeps it current: " +
        "a room reopened, so it's back in, with a note that says so. At the museum you tick things off as you spot " +
        "them, and the Made shelf lists the page.",
      guarantees: ["G31", "G59"],
    });
    transcript.begin("2026-11-21T18:10:00.000Z");
    transcript.connect();
    transcript.wait(2000);
    sendAndStart(transcript, "We're at the V&A tomorrow for two hours. What shouldn't I miss?");
    transcript.wait(800);
    transcript.step("web_search", searching("V&A highlights two hours"));
    transcript.wait(1500);
    transcript.endStep();
    const keep = (name: string, alt: string) => {
      const url = `https://photos.example.org/${name}.jpg`;
      transcript.world("web_has", { url, file: "riverside.jpg" });
      const attachment = transcript.keptImage("riverside.jpg", `${name}.jpg`);
      agentCalls(transcript, "keep_image", { url }, { attachment });
      transcript.wait(300);
      return {
        attachment,
        alt,
        source_url: `https://commons.example.org/wiki/File:${name}.jpg`,
        credit: "Photo by A. Example, CC BY-SA 4.0",
      };
    };
    const cover = keep("va-dome", "The V&A's dome over Cromwell Road");
    const casts = keep("cast-courts", "The Cast Courts, with Trajan's Column in two halves");
    const castCourts = {
      ...guideRoom("cast-courts", "Cast Courts", "Room 46a–b · 25 min", [
        ["trajans-column", "Trajan's Column", "Cut in two to fit under the roof. Find the join."],
        ["fig-leaf", "David's fig leaf", "Not on him: it hangs in a case behind, made for royal visits."],
      ]),
      image: casts,
      text: "Plaster copies of Europe's great monuments, made so people who couldn't travel could still stand in front of them.",
    };
    const southAsia = guideRoom("south-asia", "South Asia", "Room 41 · 20 min", [
      ["tipus-tiger", "Tipu's Tiger", "A wooden tiger with an organ inside. It growls."],
    ]);
    const fashion = guideRoom("fashion", "Fashion", "Room 40 · 20 min", [
      ["mantua", "The silk mantua", "A court dress so wide you went through doors sideways."],
    ]);
    const halfway = {
      id: "halfway",
      title: "Halfway",
      numbered: false,
      text: [
        "```ari:place",
        JSON.stringify({
          name: "The Morris Room",
          address: "V&A, Cromwell Road, London",
          note: "the first museum café",
        }),
        "```",
      ].join("\n"),
    };
    const intro = "Two hours, three rooms, in walking order from the Cromwell Road door. Coffee halfway.";
    const first = { intro, check: "Spotted", sections: [castCourts, southAsia, fashion, halfway] };
    const page = {
      id: "va-guide",
      title: "Your guide to the V&A",
      summary: "3 rooms · 4 things to spot",
      cover,
      for_day: "2026-11-22",
    };
    agentCalls(transcript, "make_made_page", { ...page, content: first }, { made: "va-guide", version: 1 });
    const made = transcript.made("created", { ...page, version: 1 }, "Made it");
    transcript.wait(500);
    writeWhole(
      transcript,
      [
        "Two hours is three rooms if you skip the paid show. I've made you a guide, in walking order from the " +
          "Cromwell Road door, with things to spot in each.",
        "",
        "```ari:made",
        JSON.stringify({ made: "va-guide" }),
        "```",
      ].join("\n"),
    );
    transcript.endTurn("completed");
    transcript.wait(4000);
    memoryCall(transcript, "/v0/made/va-guide", { made: made.made, content: first, state: {}, changes: [made.change] });
    transcript.wait(14 * 60 * 60 * 1000);
    const cartoons = {
      ...guideRoom("raphael-cartoons", "Raphael Cartoons", "Room 48a · 15 min", [
        ["miraculous-draught", "The Miraculous Draught of Fishes", "Look for the cranes on the shore."],
      ]),
      badge: "Back in",
    };
    const second = { intro, check: "Spotted", sections: [castCourts, southAsia, cartoons, fashion, halfway] };
    const note = "The Raphael Cartoons reopened this morning, so they're back in.";
    agentCalls(
      transcript,
      "change_made_page",
      { id: "va-guide", version: 1, summary: "4 rooms · 5 things to spot", content: second, note },
      { made: "va-guide", version: 2 },
    );
    const changed = transcript.made("changed", { ...page, summary: "4 rooms · 5 things to spot", version: 2 }, note);
    transcript.wait(6 * 60 * 60 * 1000 + 22 * 60 * 1000);
    transcript.patchMade("va-guide", { ticks: { "trajans-column": "2026-11-22T14:32:00.000Z" } });
    transcript.wait(6 * 60 * 1000);
    const state = transcript.patchMade("va-guide", { ticks: { "fig-leaf": "2026-11-22T14:38:00.000Z" } });
    transcript.wait(1000);
    memoryCall(transcript, "/v0/made/va-guide", {
      made: changed.made,
      content: second,
      state,
      changes: [changed.change, made.change],
    });
    transcript.wait(60 * 60 * 1000);
    memoryCall(transcript, "/v0/made", { made: [changed.made] });
    return transcript;
  },

  () => {
    const transcript = createTranscript({
      name: "92-a-nights-dream",
      scenario: 92,
      title: "A night's dream",
      summary:
        "At 04:00, while you sleep, Kumo dreams: it looks back over Thursday, writes your journal for it, moves " +
        "tomorrow's check on your legs to after your lie-in, and sets one for Saturday's session. It leaves a record " +
        "of what it planned, noticed and saved for you, and nothing notifies. In the morning you open it, it's " +
        "seen, and you take back the Saturday check; the record says so.",
      guarantees: ["G60", "G61", "G33"],
    });
    transcript.begin("2026-11-26T21:30:00.000Z");
    transcript.connect();
    transcript.registerDevice();
    transcript.wait(1000);
    const legs = {
      title: "Ask how the legs feel",
      what: "Ask how the legs feel after the long run",
      why: "Fourteen kilometres is a jump; check recovery before Saturday's session.",
      source: { kind: "chat", title: "The long run with Leo" },
    } as const;
    agentCalls(transcript, "set_wake_up", { ...legs, at: "2026-11-27T08:00:00Z", asked: false });
    const check = transcript.wakeUp({ ...legs, at: "2026-11-27T08:00:00.000Z", by: "kumo" });
    transcript.wait(2000);
    agentCalls(transcript, "note_day", {
      text: "Ran 14 km along the river with Leo, the longest since the summer; pastries at the market after.",
    });
    agentCalls(transcript, "note_day", { text: "Best run in months.", yours: true });
    agentCalls(transcript, "note_day", { text: "Sleeping in tomorrow; nothing before ten.", yours: true });
    const entry =
      "A long run along the river with Leo this morning: 14 km, my longest since the summer. Best run in months. " +
      "We stopped for pastries at the market on the way back.";
    const saturday = {
      title: "Check Saturday's session",
      what: "Check Saturday's session still suits the legs",
      why: "After Thursday's 14 km, Saturday's intervals may want to be easy miles instead.",
      source: { kind: "chat", title: "The long run with Leo" },
    } as const;
    const moved = "Moved the check on your legs to 09:30, after your lie-in";
    const noticed = "Your long runs are back: 14 km, the first since the summer";
    transcript.world("kumo_dreams", {
      calls: [
        {
          tool: "journal",
          input: {
            day: "2026-11-26",
            text: entry,
            gist: "14 km with Leo; my longest run since the summer",
            note: "Thursday",
          },
        },
        { tool: "move_wake_up", input: { id: check.id, at: "2026-11-27T09:30:00Z" } },
        { tool: "set_wake_up", input: { ...saturday, at: "2026-11-28T07:00:00Z", asked: false } },
        {
          tool: "record_dream",
          input: {
            headline: "Thursday's long run, written up; Friday starts late",
            lines: [
              { group: "saved", text: "Wrote Thursday's journal", page: "memory:journal/2026-11-26" },
              { group: "planned", text: moved, wake_up: check.id },
              { group: "noticed", text: noticed },
            ],
          },
        },
      ],
      answer: "Dreamt.",
    });
    transcript.time("2026-11-27T04:00:00.000Z");
    transcript.dreamStep("gathering", "Reading back over the day");
    transcript.dreamStep("journal", "Writing Thursday's journal");
    transcript.dreamStep("planning", `Moving “${legs.title}”`);
    const later = { ...check, at: "2026-11-27T09:30:00.000Z" };
    transcript.plans([later]);
    transcript.dreamStep("planning", `Planning “${saturday.title}”`);
    const session = transcript.wakeUp({ ...saturday, at: "2026-11-28T07:00:00.000Z", by: "kumo" });
    const dream = transcript.dreamId();
    const wrote = transcript.addDone({ text: "Wrote Thursday's journal", dream, undo: true });
    const movedDone = transcript.addDone({ text: moved, dream, undo: true });
    const sessionText = `Set “${saturday.title}” for Sat 28 Nov 07:00`;
    const sessionDone = transcript.addDone({ text: sessionText, dream, undo: true });
    const record = transcript.dreamFinished({
      id: dream,
      day: "2026-11-26",
      trigger: "scheduled",
      started_at: "2026-11-27T04:00:00.000Z",
      ended_at: "2026-11-27T04:00:00.000Z",
      headline: "Thursday's long run, written up; Friday starts late",
      lines: [
        {
          group: "saved",
          text: "Wrote Thursday's journal",
          page: "memory:journal/2026-11-26",
          done: String(wrote.id),
          undo: true,
        },
        { group: "planned", text: moved, wake_up: check.id, done: String(movedDone.id), undo: true },
        { group: "noticed", text: noticed },
        { group: "planned", text: sessionText, wake_up: session.id, done: String(sessionDone.id), undo: true },
      ],
    });
    transcript.time("2026-11-27T07:40:00.000Z");
    transcript.request("GET", "/v0/dream");
    transcript.response(200, { time: "04:00", next_at: "2026-11-28T04:00:00.000Z", latest: record });
    transcript.wait(4000);
    const seen = { ...record, seen_at: "2026-11-27T07:40:04.000Z" };
    transcript.request("POST", `/v0/dreams/${dream}/seen`);
    transcript.response(200, { dream: seen });
    transcript.wait(6000);
    transcript.request("POST", `/v0/done/${String(sessionDone.id)}/undo`);
    transcript.plans([later]);
    transcript.response(200, {
      entry: { ...sessionDone, text: `Undone: ${sessionText}`, undo: false },
    });
    transcript.wait(1000);
    transcript.request("GET", "/v0/dream");
    transcript.response(200, {
      time: "04:00",
      next_at: "2026-11-28T04:00:00.000Z",
      latest: {
        ...seen,
        lines: seen.lines.map((line) =>
          line.done === String(sessionDone.id) ? { ...line, undo: false, undone: true } : line,
        ),
      },
    });
    return transcript;
  },

  () => {
    const transcript = createTranscript({
      name: "93-dream-now",
      scenario: 93,
      title: "Dream now",
      summary:
        "You're off to bed early, so you ask Kumo to dream now. It dreams at once, moves Friday's planning to " +
        "09:00 so you can sleep in, and leaves its record. Dream now is an extra: the night's dream still runs at " +
        "04:00, looking back only over what came since. In the morning you move the dream time to 03:30.",
      guarantees: ["G60", "G61"],
    });
    transcript.begin("2026-11-26T23:15:00.000Z");
    transcript.connect();
    transcript.wait(1000);
    const planning = {
      title: "Shape Friday",
      what: "Shape Friday with you",
      why: "You asked for a look at the day each morning; Friday is wide open.",
      source: { kind: "chat", title: "“Look at my day with me each morning”" },
    } as const;
    agentCalls(transcript, "set_wake_up", { ...planning, at: "2026-11-27T08:30:00Z", asked: true });
    const look = transcript.wakeUp({ ...planning, at: "2026-11-27T08:30:00.000Z", by: "you" });
    transcript.wait(2000);
    transcript.request("GET", "/v0/dream");
    transcript.response(200, { time: "04:00", next_at: "2026-11-27T04:00:00.000Z" });
    transcript.wait(2000);
    const moved = "Moved Friday's planning to 09:00, so you can sleep in";
    transcript.world("kumo_dreams", {
      calls: [
        { tool: "move_wake_up", input: { id: look.id, at: "2026-11-27T09:00:00Z" } },
        {
          tool: "record_dream",
          input: {
            headline: "An early night: Friday starts at nine",
            lines: [{ group: "planned", text: moved, wake_up: look.id }],
          },
        },
      ],
      answer: "Dreamt.",
    });
    transcript.request("POST", "/v0/dream");
    const reading = transcript.dreamStep("gathering", "Reading back over the day");
    transcript.response(202, {
      time: "04:00",
      next_at: "2026-11-27T04:00:00.000Z",
      dreaming: { since: "2026-11-26T23:15:05.000Z", trigger: "manual", steps: [reading] },
    });
    transcript.dreamStep("planning", `Moving “${planning.title}”`);
    transcript.plans([{ ...look, at: "2026-11-27T09:00:00.000Z" }]);
    const dream = transcript.dreamId();
    const done = transcript.addDone({ text: moved, dream, undo: true });
    const record = transcript.dreamFinished({
      id: dream,
      day: "2026-11-26",
      trigger: "manual",
      started_at: "2026-11-26T23:15:05.000Z",
      ended_at: "2026-11-26T23:15:05.000Z",
      headline: "An early night: Friday starts at nine",
      lines: [{ group: "planned", text: moved, wake_up: look.id, done: String(done.id), undo: true }],
    });
    transcript.wait(2000);
    transcript.request("GET", "/v0/dream");
    transcript.response(200, { time: "04:00", next_at: "2026-11-27T04:00:00.000Z", latest: record });
    // The night's dream runs as ever, looking back only since Dream now.
    const quiet = "Nothing new since your early dream: Friday still starts at nine";
    transcript.world("kumo_dreams", {
      calls: [{ tool: "record_dream", input: { lines: [{ group: "noticed", text: quiet }] } }],
      answer: "Dreamt.",
    });
    transcript.time("2026-11-27T04:00:00.000Z");
    transcript.dreamStep("gathering", "Reading back over the day");
    const night = transcript.dreamFinished({
      id: transcript.dreamId(),
      day: "2026-11-26",
      trigger: "scheduled",
      started_at: "2026-11-27T04:00:00.000Z",
      ended_at: "2026-11-27T04:00:00.000Z",
      lines: [{ group: "noticed", text: quiet }],
    });
    transcript.time("2026-11-27T07:30:00.000Z");
    transcript.request("GET", "/v0/dream");
    transcript.response(200, { time: "04:00", next_at: "2026-11-28T04:00:00.000Z", latest: night });
    transcript.wait(5000);
    transcript.request("PUT", "/v0/dream/time", { body: { time: "03:30" } });
    transcript.response(200, { time: "03:30", next_at: "2026-11-28T03:30:00.000Z", latest: night });
    return transcript;
  },

  () => {
    const transcript = createTranscript({
      name: "94-your-day-in-your-words",
      scenario: 94,
      title: "Your day in your words",
      summary:
        "During Thursday Kumo only keeps notes for the dream: the run with Leo, your own words about it, and a " +
        "lunch with Mira you mention that was really on Tuesday. That night it writes Thursday's journal as your " +
        "own diary, in the first person, and adds the lunch to Tuesday's entry where it happened. In the morning " +
        "you read both days in the Library.",
      guarantees: ["G61", "G22"],
    });
    const tuesday = {
      address: "memory:journal/2026-11-24",
      title: "24 November 2026",
      gist: "A quiet day; I finished the deck",
      aliases: [],
      links: [],
      markdown: "A quiet day at home. I finished the Halcyon deck and went to bed early.\n",
      note: "Tuesday",
    };
    transcript.begin("2026-11-26T17:40:00.000Z");
    transcript.world("memory_holds", { pages: [tuesday] });
    transcript.connect();
    transcript.wait(1000);
    agentCalls(transcript, "note_day", {
      text: "Ran 14 km along the river with Leo, the longest since the summer; pastries at the market after.",
    });
    transcript.wait(60_000);
    agentCalls(transcript, "note_day", { text: "Best run in months.", yours: true });
    transcript.wait(60_000);
    agentCalls(transcript, "note_day", {
      text: "Had lunch with Mira on Tuesday; she's moving to Lisbon in the spring.",
      day: "2026-11-24",
    });
    const thursdayText =
      "A long run along the river with Leo this morning: 14 km, my longest since the summer. Best run in months. " +
      "We stopped for pastries at the market on the way back.";
    const tuesdayText =
      "A quiet day at home. I finished the Halcyon deck, then had lunch with Mira, who told me she's moving to " +
      "Lisbon in the spring. Early to bed.";
    const thursdayGist = "14 km with Leo; my longest run since the summer";
    const tuesdayGist = "Finished the deck; Mira's moving to Lisbon";
    transcript.world("kumo_dreams", {
      calls: [
        { tool: "journal", input: { day: "2026-11-26", text: thursdayText, gist: thursdayGist, note: "Thursday" } },
        {
          tool: "journal",
          input: { day: "2026-11-24", text: tuesdayText, gist: tuesdayGist, note: "Lunch with Mira" },
        },
        {
          tool: "record_dream",
          input: {
            headline: "Thursday written up, and Tuesday filled in",
            lines: [
              { group: "saved", text: "Wrote Thursday's journal", page: "memory:journal/2026-11-26" },
              { group: "saved", text: "Added your lunch with Mira to Tuesday", page: tuesday.address },
            ],
          },
        },
      ],
      answer: "Dreamt.",
    });
    transcript.time("2026-11-27T04:00:00.000Z");
    transcript.dreamStep("gathering", "Reading back over the day");
    transcript.dreamStep("journal", "Writing Thursday's journal");
    transcript.dreamStep("journal", "Writing Tuesday's journal");
    const dream = transcript.dreamId();
    const thursday = transcript.addDone({ text: "Wrote Thursday's journal", dream, undo: true });
    const added = transcript.addDone({ text: "Added your lunch with Mira to Tuesday", dream, undo: true });
    transcript.dreamFinished({
      id: dream,
      day: "2026-11-26",
      trigger: "scheduled",
      started_at: "2026-11-27T04:00:00.000Z",
      ended_at: "2026-11-27T04:00:00.000Z",
      headline: "Thursday written up, and Tuesday filled in",
      lines: [
        {
          group: "saved",
          text: "Wrote Thursday's journal",
          page: "memory:journal/2026-11-26",
          done: String(thursday.id),
          undo: true,
        },
        {
          group: "saved",
          text: "Added your lunch with Mira to Tuesday",
          page: tuesday.address,
          done: String(added.id),
          undo: true,
        },
      ],
    });
    transcript.time("2026-11-27T08:10:00.000Z");
    memoryCall(transcript, "/v0/memory/page?address=memory:journal/2026-11-26", {
      address: "memory:journal/2026-11-26",
      title: "26 November 2026",
      gist: thursdayGist,
      shelf: "journal",
      aliases: [],
      links: [],
      changed_at: "2026-11-27T04:00:00.000Z",
      markdown: `${thursdayText}\n`,
    });
    transcript.wait(3000);
    memoryCall(transcript, `/v0/memory/page?address=${tuesday.address}`, {
      address: tuesday.address,
      title: tuesday.title,
      gist: tuesdayGist,
      shelf: "journal",
      aliases: [],
      links: [],
      changed_at: "2026-11-27T04:00:00.000Z",
      markdown: `${tuesdayText}\n`,
    });
    return transcript;
  },

  () => {
    const transcript = createTranscript({
      name: "95-one-plan-across-threads",
      scenario: 95,
      title: "One plan across threads",
      summary:
        "Over a morning you tell Kumo four things in three places: in the main chat that you're working from " +
        "Leeds this week, in a thread that Thursday's demo has no slides yet, in another that the handover to " +
        "Omar is done, and back in the main chat that the Kestrel review is still due. Each conversation has the " +
        "others in mind. Kumo keeps one plan without being told each time: time for the slides once the " +
        "afternoon frees up, the review after, a guess at your evening, and one check-in it moves rather than " +
        "doubles.",
      guarantees: ["G62"],
    });
    transcript.begin("2026-11-24T08:29:00.000Z");
    transcript.world("capability_on", {
      capability: "icloud",
      values: { apple_id: "divy@icloud.com", app_password: "abcd-efgh-ijkl-mnop" },
    });
    transcript.connect();
    transcript.wait(1000);
    const kumo = { name: "Kumo", kumo: true };

    transcript.time("2026-11-24T08:30:00.000Z");
    const leeds = "Morning! Change of plan: I'm working from my sister's in Leeds this week, back Friday.";
    const leedsReply = "Leeds it is. I'll plan your week around being there, and keep the London runs for Friday.";
    sendAndStart(transcript, leeds);
    transcript.wait(400);
    writeWhole(transcript, leedsReply);
    transcript.endTurn("completed");

    transcript.time("2026-11-24T09:10:00.000Z");
    const demo = "The Northwind demo is Thursday at 14:00 and the slides aren't started. Handover's this morning.";
    const demoReply =
      "Then the slides wait for the handover. I'll find you two hours once it's done, and come back to you here.";
    const asked = transcript.send(demo, { newThread: true });
    const demoThread = transcript.threadOf(asked) ?? "";
    transcript.world("kumo_has_in_mind", {
      thread: demoThread,
      today: ["The main chat:", `- 08:30 they: ${leeds}`, `- 08:30 you: ${leedsReply}`],
    });
    const find = {
      title: "Find time for the slides",
      what: "See whether the handover's done; if it is, put two hours for the slides on my calendar",
      why: "The Northwind demo is Thursday at 14:00 and the slides aren't started; the handover takes this morning.",
      source: { kind: "chat" as const, title: "Thursday's demo" },
    };
    const findWakeUp = transcript.inThread(demoThread, () => {
      transcript.startTurn([asked]);
      transcript.world("thread_named", { title: "Thursday's demo" });
      transcript.wait(300);
      transcript.world("agent_calls", {
        tool: "set_wake_up",
        input: { ...find, at: "2026-11-24T11:30:00Z", asked: false },
        thread: demoThread,
      });
      const set = transcript.wakeUp({ at: "2026-11-24T11:30:00.000Z", ...find, by: "kumo" });
      transcript.wait(300);
      writeWhole(transcript, demoReply);
      transcript.endTurn("completed");
      return set;
    });
    transcript.changeThread(demoThread, { title: "Thursday's demo" });

    // It comes due before the handover's over: Kumo looks at today so far, and moves itself rather than nag.
    const stillOn = "The handover's still going, so I'll look again at 12:30.";
    transcript.world("kumo_has_in_mind", {
      background: true,
      today: [
        `“Thursday's demo” (${demoThread}), a thread:`,
        `- 09:10 they: ${demo}`,
        "The main chat:",
        `- 08:30 they: ${leeds}`,
        "Still to come today, soonest first:",
        "- 11:30 wake-up: Find time for the slides",
      ],
    });
    transcript.world("kumo_works", {
      calls: [{ tool: "move_wake_up", input: { id: findWakeUp.id, at: "2026-11-24T12:30:00Z" } }],
      answer: stillOn,
    });
    transcript.time("2026-11-24T11:30:00.000Z");
    const later = { ...findWakeUp, at: "2026-11-24T12:30:00.000Z" };
    transcript.plans([later]);
    transcript.addDone({ text: "Moved “Find time for the slides” to Tue 24 Nov, 12:30", reason: stillOn });

    transcript.time("2026-11-24T11:40:00.000Z");
    const handedOver = "Handover to Omar is done, he has everything.";
    const handoverReply =
      "Nicely done. That frees your afternoon: the slides' first pass is on my calendar from 2 to 4, and I'll check in after.";
    const told = transcript.send(handedOver, { newThread: true });
    const handoverThread = transcript.threadOf(told) ?? "";
    transcript.world("kumo_has_in_mind", {
      thread: handoverThread,
      today: [
        `“Thursday's demo” (${demoThread}), a thread:`,
        `- 09:10 they: ${demo}`,
        `- 09:10 you: ${demoReply}`,
        "The main chat:",
        `- 08:30 they: ${leeds}`,
        "What you did today, from your Done list (written to them), newest first:",
        `- 11:30 Moved “Find time for the slides” to Tue 24 Nov, 12:30: ${stillOn}`,
        "Still to come today, soonest first:",
        "- 12:30 wake-up: Find time for the slides",
      ],
    });
    const slidesBlock = {
      kind: "plan",
      title: "Slides, first pass",
      start: "2026-11-24T14:00:00.000Z",
      end: "2026-11-24T16:00:00.000Z",
      activity: "working",
      why: "The Northwind demo is Thursday at 14:00",
    };
    const slides = transcript.calendarItem({
      uid: transcript.eventUid(),
      title: slidesBlock.title,
      start: slidesBlock.start,
      end: slidesBlock.end,
      all_day: false,
      calendar: kumo,
      status: "confirmed",
    });
    const checkIn = {
      title: "Check in on the slides",
      what: "Ask how the first pass went, and offer a run-through if they're nearly there",
    };
    const result = "Handed over to Omar";
    transcript.inThread(handoverThread, () => {
      transcript.startTurn([told]);
      transcript.world("thread_named", { title: "Handover" });
      transcript.wait(300);
      transcript.world("agent_calls", { tool: "plan_block", input: slidesBlock, thread: handoverThread });
      transcript.comingUp([slides]);
      transcript.world("agent_calls", {
        tool: "move_wake_up",
        input: { id: findWakeUp.id, ...checkIn, at: "2026-11-24T16:00:00Z" },
        thread: handoverThread,
      });
      transcript.plans([{ ...later, ...checkIn, at: "2026-11-24T16:00:00.000Z" }]);
      transcript.wait(300);
      writeWhole(transcript, handoverReply);
      transcript.world("agent_calls", {
        tool: "update_thread",
        input: { state: "done", result },
        thread: handoverThread,
      });
      transcript.changeThread(handoverThread, { state: "done", result });
      transcript.wait(200);
      transcript.endTurn("completed");
    });
    transcript.changeThread(handoverThread, { title: "Handover" });

    transcript.time("2026-11-24T12:30:00.000Z");
    const review = "Still need to finish the Kestrel review today, it's due tomorrow.";
    const reviewReply =
      "That fits after the slides: 4:15 to 5:15 on my calendar. I've guessed your evening's with your sister, and I'll check in on both at 5:15, once.";
    sendAndStart(transcript, review);
    transcript.world("kumo_has_in_mind", {
      today: [
        `“Handover” (${handoverThread}), a thread, marked done (${result}):`,
        `- 11:40 they: ${handedOver}`,
        `“Thursday's demo” (${demoThread}), a thread:`,
        "Still to come today, soonest first:",
        "- 14:00–16:00 Slides, first pass · your block",
        "- 16:00 wake-up: Check in on the slides",
      ],
      leaves_out: [`- 08:30 they: ${leeds}`],
    });
    transcript.wait(400);
    const reviewBlock = {
      kind: "plan",
      title: "Kestrel review",
      start: "2026-11-24T16:15:00.000Z",
      end: "2026-11-24T17:15:00.000Z",
      activity: "working",
      why: "Due tomorrow; after the slides, while you're still at the desk",
    };
    agentCalls(transcript, "plan_block", reviewBlock);
    const reviewItem = transcript.calendarItem({
      uid: transcript.eventUid(),
      title: reviewBlock.title,
      start: reviewBlock.start,
      end: reviewBlock.end,
      all_day: false,
      calendar: kumo,
      status: "confirmed",
    });
    transcript.comingUp([slides, reviewItem]);
    const eveningGuess = {
      kind: "guess",
      title: "With your sister",
      start: "2026-11-24T19:00:00.000Z",
      end: "2026-11-24T22:00:00.000Z",
      activity: "people",
      why: "You're staying with her this week",
    };
    agentCalls(transcript, "plan_block", eveningGuess);
    const evening = transcript.calendarItem({
      uid: transcript.eventUid(),
      title: eveningGuess.title,
      start: eveningGuess.start,
      end: eveningGuess.end,
      all_day: false,
      calendar: kumo,
      status: "confirmed",
      guess: { activity: "people", why: eveningGuess.why },
    });
    transcript.comingUp([slides, reviewItem, evening]);
    const both = {
      title: "Check in on slides and review",
      what: "Ask how the slides and the Kestrel review went; offer a run-through tonight if the slides are close",
    };
    agentCalls(transcript, "move_wake_up", { id: findWakeUp.id, ...both, at: "2026-11-24T17:15:00Z" });
    const one = { ...later, ...both, at: "2026-11-24T17:15:00.000Z" };
    transcript.plans([one]);
    transcript.wait(300);
    writeWhole(transcript, reviewReply);
    transcript.endTurn("completed");
    transcript.wait(5000);
    transcript.listWakeUps();
    return transcript;
  },

  () => {
    const transcript = createTranscript({
      name: "96-today-so-far",
      scenario: 96,
      title: "Today so far",
      summary:
        "A morning across the main chat and a thread about Mira's birthday. When Kumo wakes at noon to check " +
        "the pottery class, it has the whole day in mind: each conversation by name, what it did, and what's " +
        "next. It checks in once, in the thread, and when you write in the main chat afterwards, Kumo has that " +
        "check-in in mind too, without the main chat's own messages, which it already has.",
      guarantees: ["G62"],
    });
    transcript.begin("2026-11-25T07:59:00.000Z");
    transcript.connect();
    transcript.wait(1000);

    transcript.time("2026-11-25T08:00:00.000Z");
    const dentist = "Quillfield Dental moved my check-up to Friday at 10.";
    const dentistReply = "Friday at 10 it is. I'll remind you on Thursday evening.";
    sendAndStart(transcript, dentist);
    transcript.wait(300);
    const remind = {
      title: "Remind you of the dentist",
      what: "Remind them of Friday's 10:00 check-up at Quillfield Dental",
      why: "They moved it to Friday at 10 and asked nothing more; the evening before is when it helps.",
      source: { kind: "chat" as const, title: "Dentist moved to Friday" },
    };
    agentCalls(transcript, "set_wake_up", { ...remind, at: "2026-11-26T19:00:00Z", asked: false });
    const reminder = transcript.wakeUp({ at: "2026-11-26T19:00:00.000Z", ...remind, by: "kumo" });
    transcript.wait(300);
    writeWhole(transcript, dentistReply);
    transcript.endTurn("completed");

    transcript.time("2026-11-25T09:00:00.000Z");
    const ideas = "Ideas for Mira's birthday? She's been into pottery lately.";
    const ideasReply =
      "A wheel class for two at Kiln on Saturday: you'd make something together. Their bookings open at noon, so I'll look then.";
    const asked = transcript.send(ideas, { newThread: true });
    const thread = transcript.threadOf(asked) ?? "";
    const look = {
      title: "Check Kiln's Saturday places",
      what: "See whether Kiln's Saturday wheel class has two places, and tell them in Mira's thread",
      why: "Kiln opens bookings at noon, and Saturday is Mira's birthday.",
      source: { kind: "chat" as const, title: "Mira's birthday" },
    };
    transcript.inThread(thread, () => {
      transcript.startTurn([asked]);
      transcript.world("thread_named", { title: "Mira's birthday" });
      transcript.wait(300);
      transcript.world("agent_calls", {
        tool: "set_wake_up",
        input: { ...look, at: "2026-11-25T12:00:00Z", asked: false },
        thread,
      });
      transcript.wakeUp({ at: "2026-11-25T12:00:00.000Z", ...look, by: "kumo" });
      transcript.wait(300);
      writeWhole(transcript, ideasReply);
      transcript.endTurn("completed");
    });
    transcript.changeThread(thread, { title: "Mira's birthday" });

    transcript.time("2026-11-25T10:15:00.000Z");
    const added = { text: "Moved your check-up to Friday on your calendar", reason: "Quillfield Dental moved it" };
    agentCalls(transcript, "done", added);
    transcript.addDone(added);

    const places = "Kiln has two places left in Saturday's 11:00 wheel class, £38 each. Want me to hold them?";
    transcript.world("kumo_has_in_mind", {
      background: true,
      today: [
        `“Mira's birthday” (${thread}), a thread:`,
        `- 09:00 they: ${ideas}`,
        "The main chat:",
        `- 08:00 they: ${dentist}`,
        `- 08:00 you: ${dentistReply}`,
        "What you did today, from your Done list (written to them), newest first:",
        `- 10:15 ${added.text}: ${added.reason}`,
        "Still to come today, soonest first:",
        `- 12:00 wake-up: ${look.title}`,
      ],
      leaves_out: [`wake-up: ${remind.title}`],
    });
    transcript.world("kumo_works", { calls: [{ tool: "post", input: { text: places, thread } }] });
    transcript.time("2026-11-25T12:00:00.000Z");
    transcript.post(places, { thread });
    transcript.addDone({ text: `Woke up for “${look.title}” and messaged you`, reason: "Done." });
    transcript.plans([reminder]);

    transcript.time("2026-11-25T12:20:00.000Z");
    const thanks = "Thanks for sorting the dentist.";
    sendAndStart(transcript, thanks);
    transcript.world("kumo_has_in_mind", {
      today: [
        `“Mira's birthday” (${thread}), a thread:`,
        `- 12:00 you messaged them: ${places}`,
        "What you did today, from your Done list (written to them), newest first:",
        `- 12:00 Woke up for “${look.title}” and messaged you: Done.`,
        `- 10:15 ${added.text}: ${added.reason}`,
      ],
      leaves_out: [`- 08:00 they: ${dentist}`],
    });
    transcript.wait(300);
    writeWhole(transcript, "Any time. I'll remind you on Thursday evening.");
    transcript.endTurn("completed");
    return transcript;
  },

  () => {
    const transcript = createTranscript({
      name: "97-understanding-you",
      scenario: 97,
      title: "Understanding you",
      summary:
        "Kumo asks two things it would like you to explain, on its Planning with you track, each with what it " +
        "already understands, the missing piece and why it would help. They wait quietly in Understanding you: no " +
        "Desk card, no notification. You say Not now to one. You answer the other with two taps and a line: it's " +
        "evidence on the track, and Kumo files what it learned in the background, with no follow-up. Kumo settles " +
        "the one you set aside once you answer it in the chat, and never asks the same thing twice.",
      guarantees: ["G63"],
    });
    transcript.begin("2026-11-27T09:00:00.000Z");
    transcript.connect();
    transcript.registerDevice();
    transcript.time("2026-11-27T09:00:01.000Z");
    const name = "Planning with you";
    const trackNote = "How you like your days and weekends planned.";
    agentCalls(transcript, "open_track", { name, note: trackNote });
    const track = {
      id: transcript.track(),
      name,
      stage: "learning",
      since: "2026-11-27T09:00:01.000Z",
      note: trackNote,
      confirmed: 0,
      corrected: 0,
      evidence: [] as readonly Readonly<Record<string, unknown>>[],
    };
    transcript.wait(500);
    transcript.getUnderstanding({ tracks: [track], questions: [], recent: [] });
    const ask = (
      at: string,
      fields: {
        readonly understood: string;
        readonly missing: string;
        readonly why: string;
        readonly options: readonly string[];
      },
    ) => {
      transcript.time(at);
      agentCalls(transcript, "add_question", { track: track.id, ...fields });
      const question = {
        id: transcript.questionId(),
        track: track.id,
        state: "open",
        ...fields,
        asked_at: at,
        changed_at: at,
      };
      transcript.question(question);
      return question;
    };
    const restful = ask("2026-11-27T09:00:02.000Z", {
      understood: "You keep Sunday mornings free, and your long run is on Saturdays.",
      missing: "What makes a weekend feel restful rather than busy?",
      why: "So the weekends I plan leave you rested, not just full.",
      options: ["Unplanned time", "Seeing friends", "Being outdoors", "A long lie-in"],
    });
    const packed = ask("2026-11-27T09:00:03.000Z", {
      understood: "Packed weeks are when your runs slip first, and you've said you sleep badly after late calls.",
      missing: "When a week is packed, what should I protect first?",
      why: "So I know what to keep when something has to give.",
      options: ["Training", "Sleep", "Evenings with friends"],
    });
    transcript.time("2026-11-27T09:01:03.000Z");
    transcript.getUnderstanding({ tracks: [track], questions: [restful, packed], recent: [] });

    transcript.time("2026-11-27T09:01:08.000Z");
    transcript.request("POST", `/v0/understanding/questions/${packed.id}/not-now`);
    const later = { ...packed, changed_at: "2026-11-27T09:01:08.000Z", later_at: "2026-11-27T09:01:08.000Z" };
    transcript.question(later);
    transcript.wait(60);
    transcript.response(200, { question: later });

    transcript.time("2026-11-27T09:01:30.000Z");
    const filed = "Weekends start slow: nothing booked before noon, and time outdoors.";
    transcript.world("kumo_works", { calls: [], answer: filed });
    const answer = {
      picked: ["Unplanned time", "Being outdoors"],
      text: "A slow morning and a long walk, with nothing booked before noon.",
    };
    transcript.request("POST", `/v0/understanding/questions/${restful.id}/answer`, { body: answer });
    const answeredAt = "2026-11-27T09:01:30.000Z";
    const answered = { ...restful, state: "answered", changed_at: answeredAt, answer: { at: answeredAt, ...answer } };
    transcript.question(answered);
    const kept = { ...answered, filed };
    transcript.question(kept);
    transcript.wait(60);
    transcript.response(202, { question: answered });

    transcript.time("2026-11-27T09:02:00.000Z");
    const evidence = {
      at: answeredAt,
      kind: "answered",
      text:
        "You answered “What makes a weekend feel restful rather than busy?”: Unplanned time, Being outdoors; " +
        "“A slow morning and a long walk, with nothing booked before noon.”",
      question: restful.id,
    };
    const answeredTrack = { ...track, evidence: [evidence] };
    transcript.getWork({ handled: [], cleared: [], tracks: [answeredTrack] });
    transcript.wait(1000);
    transcript.getUnderstanding({ tracks: [answeredTrack], questions: [later], recent: [kept] });

    const settledAt = "2026-11-27T12:40:00.000Z";
    transcript.time(settledAt);
    const note = "You said in the chat that sleep comes first when a week is packed.";
    agentCalls(transcript, "settle_question", { question: packed.id, note });
    const settled = {
      id: packed.id,
      track: track.id,
      state: "settled",
      understood: packed.understood,
      missing: packed.missing,
      why: packed.why,
      options: packed.options,
      asked_at: packed.asked_at,
      changed_at: settledAt,
      note,
    };
    transcript.question(settled);
    transcript.time("2026-11-28T04:10:00.000Z");
    agentCalls(transcript, "add_question", {
      track: track.id,
      understood: "You run long on Saturdays.",
      missing: "What makes a weekend restful for you, rather than busy?",
      why: "So I plan weekends that rest you.",
    });
    transcript.time("2026-11-28T08:30:00.000Z");
    transcript.getUnderstanding({ tracks: [answeredTrack], questions: [], recent: [settled, kept] });
    return transcript;
  },

  () => {
    const transcript = createTranscript({
      name: "98-sharing-with-kumo",
      scenario: 98,
      title: "Sharing with Kumo",
      summary:
        "From another app's share sheet you share a job ad's link, with a note. The server reads the page for its " +
        "title and summary, and Kumo puts the share in your open thread about that role, where it answers with " +
        "what it made of it and what it did. Then you share a screenshot of a booking, which belongs to no thread, " +
        "so Kumo starts one it names and answers there. Each reply notifies, naming its thread. The share sheet " +
        "sends the first share again, and nothing changes.",
      guarantees: ["G64"],
    });
    transcript.time("2026-11-26T17:05:00.000Z");
    transcript.post(
      "Sam at Halcyon wrote back: they'd like to talk about the platform team, and a recruiter call is next. " +
        "I'll keep the role here.",
      { newThread: "Halcyon role" },
    );
    const role = transcript.latestThread();
    transcript.begin("2026-11-27T08:40:00.000Z", { cursor: "latest" });
    transcript.connect();
    transcript.registerDevice();
    transcript.wait(3000);
    const url = "https://careers.halcyon.example/jobs/platform-engineer";
    const html = [
      "<!doctype html><html><head>",
      "<title>Platform Engineer, Infrastructure | Halcyon Careers</title>",
      '<meta property="og:title" content="Platform Engineer, Infrastructure">',
      '<meta property="og:description" content="Build and run the systems every Halcyon team ships on. London, ',
      'hybrid, three days a week in the office.">',
      '<meta property="og:site_name" content="Halcyon Careers">',
      "</head><body><h1>Platform Engineer</h1></body></html>",
    ].join("");
    const note = "This is the one Sam mentioned";
    const link = transcript.share({ url, html, note, joins: role });
    transcript.inThread(role, () => {
      transcript.startTurn([link.id]);
      transcript.wait(300);
      transcript.step("thinking", thinking);
      transcript.wait(1500);
      writeWhole(
        transcript,
        "That's the one Sam meant: Platform Engineer, Infrastructure, building what every Halcyon team ships on, " +
          "in London and hybrid. I've kept it here with the role, and I'll use it to prep you before the " +
          "recruiter call.",
      );
      const result = "Platform Engineer · recruiter call next";
      transcript.world("agent_calls", { tool: "update_thread", input: { result }, thread: role });
      transcript.changeThread(role, { result });
      transcript.wait(200);
      transcript.endTurn("completed");
    });
    transcript.wait(20 * 60 * 1000);
    const screenshot = transcript.upload("library-shelves.png", { name: "screenshot.png" });
    transcript.wait(500);
    const booking = transcript.share({ attachments: [screenshot], startsThread: "Dentist check-up" });
    transcript.inThread(booking.thread, () => {
      transcript.startTurn([booking.id]);
      transcript.wait(300);
      transcript.step("thinking", thinking);
      transcript.wait(1200);
      const title = "Remind about the dentist";
      const what = "Remind them of the dentist tomorrow";
      const why = "Their check-up at Quillfield Dental is on Tuesday 2 December at 09:40; they shared the booking.";
      const source = { kind: "chat" as const, title: "Quillfield Dental booking" };
      transcript.world("agent_calls", {
        tool: "set_wake_up",
        input: { title, what, why, at: "2026-12-01T19:00:00Z", asked: false, source },
        thread: booking.thread,
      });
      transcript.wakeUp({ at: "2026-12-01T19:00:00.000Z", title, what, why, by: "kumo", source });
      transcript.wait(300);
      writeWhole(
        transcript,
        "A check-up at Quillfield Dental on Tuesday 2 December at 09:40. I'll remind you the evening before.",
      );
      const result = "Tue 2 Dec, 09:40";
      transcript.world("agent_calls", { tool: "update_thread", input: { result }, thread: booking.thread });
      transcript.changeThread(booking.thread, { result });
      transcript.wait(200);
      transcript.endTurn("completed");
    });
    transcript.wait(5000);
    transcript.shareAgain({ id: link.id, url, note, thread: role });
    return transcript;
  },

  () => {
    const transcript = createTranscript({
      name: "100-full-access",
      scenario: 100,
      title: "Full access",
      summary:
        "Kumo can't install what the browser needs from inside its sandbox, so you give it full access in " +
        "Settings, with Face ID. The command that turns it on says it's meant; every app hears the change, Kumo's " +
        "work notes it, and from its next turn Kumo runs without the sandbox, saying what it's about to do. You " +
        "turn it off again once it's done, and the sandbox is back from the turn after.",
      guarantees: ["G66"],
    });
    const headers = { headers: { "Ito-Protocol": protocol } };
    transcript.begin("2026-11-27T14:00:00.000Z");
    transcript.connect();
    transcript.wait(2000);
    transcript.request("GET", "/v0/access");
    transcript.wait(40);
    transcript.response(200, { mode: "sandboxed" }, headers);
    transcript.wait(4000);
    transcript.request("POST", "/v0/access/full", { body: { confirm: true } });
    const full = { mode: "full", since: "2026-11-27T14:00:06.040Z" } as const;
    transcript.access(full);
    transcript.addDone({
      text: "Full access on: Kumo runs without its sandbox from its next turn",
      reason: "You turned it on in Settings",
    });
    transcript.wait(40);
    transcript.response(200, full, headers);
    transcript.wait(5000);
    sendAndStart(transcript, "The browser won't start. Install what it needs and get it going.");
    transcript.wait(300);
    transcript.step("thinking", thinking);
    transcript.wait(900);
    transcript.endStep();
    transcript.reply("note");
    transcript.write("I'll install Ito's packages in its checkout, then Chromium for the browser.", { pieces: 2 });
    transcript.endMessage("completed");
    transcript.wait(40);
    transcript.step("command", {
      title: "Installing packages",
      endedTitle: "Installed packages",
      fields: { command: "npm ci --omit=dev", cwd: "/home/you/ito-core", actions: [{ type: "run" }] },
    });
    transcript.wait(18_000);
    transcript.endStep({ fields: { exit_code: 0, output: "added 412 packages in 18s\n" } });
    transcript.step("command", {
      title: "Running a command",
      endedTitle: "Ran a command",
      fields: {
        command: "npx playwright install chromium",
        cwd: "/home/you/ito-core",
        actions: [{ type: "run" }],
      },
    });
    transcript.wait(24_000);
    transcript.endStep({ fields: { exit_code: 0, output: "Chromium downloaded to ~/.cache/ms-playwright\n" } });
    writeWhole(
      transcript,
      "Done: Ito's packages are installed, and Chromium with them. Switch the browser on again in Settings › " +
        "Capabilities and it'll start.",
      3,
    );
    transcript.endTurn("completed");
    transcript.wait(10 * 60 * 1000);
    transcript.request("DELETE", "/v0/access/full");
    transcript.access({ mode: "sandboxed" });
    transcript.addDone({
      text: "Full access off: Kumo's back in its sandbox from its next turn",
      reason: "You turned it off in Settings",
    });
    transcript.wait(40);
    transcript.response(200, { mode: "sandboxed" }, headers);
    return transcript;
  },
];

mkdirSync(transcriptDirectory, { recursive: true });
const spec = loadSpec();
for (const play of scenarios) {
  const transcript = play();
  spec.checkLines(transcript.header.name, transcript.lines());
  writeFileSync(path.join(transcriptDirectory, `${transcript.header.name}.jsonl`), transcript.toJsonl());
  console.log(`wrote  ${transcript.header.name}.jsonl`);
}
