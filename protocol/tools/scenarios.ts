import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Correction, Error as ErrorBody } from "#protocol/types.ts";
import { loadSpec } from "./spec.ts";
import { transcriptDirectory } from "./transcript-files.ts";
import { demoModels } from "#engine/scripted/models.ts";
import { defaultVoice, voices } from "#voice/voices.ts";
import type { Term } from "#memory/vocabulary.ts";
import { florenceId, florenceTrip } from "./florence.ts";
import { createTranscript, type Transcript } from "./transcript.ts";

const protocol = "0.13";
const serverVersion = "0.13.0";
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
  description: "A fine-grained token for akai-ito/ito-core, with Issues set to read and write.",
};

const reports = (state: string, isTokenSet: boolean, detail?: string): Readonly<Record<string, unknown>> => ({
  id: "reports",
  kind: "hand",
  title: "Reports",
  summary: "Files the gaps Ari hits as public issues on Ito's repositories.",
  symbol: "exclamationmark.bubble",
  version: "0.1",
  state,
  ...(detail !== undefined && { detail }),
  fields: [{ ...reportsTokenField, set: isTokenSet }],
  uses: { hosts: ["api.github.com"], folders: [] },
});

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
  title: "Florence with Janki",
  summary: "6–9 Nov · 4 to book",
  status: "active" as const,
  pinned: true,
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

const startFlorence = (transcript: Transcript, cover: string): ReturnType<Transcript["motion"]> => {
  agentCalls(transcript, "start_motion", {
    id: florenceId,
    kind: florenceCard.kind,
    title: florenceCard.title,
    summary: florenceCard.summary,
    content: florenceTrip(cover),
    note: "Started the trip",
  });
  const started = transcript.motion("started", { ...florenceCard, cover, version: 1 }, "Started the trip");
  motionStep(transcript, "started", started.motion, {
    title: "Starting Florence with Janki",
    endedTitle: "Started Florence with Janki",
  });
  return started;
};

const findFlorenceCover = (transcript: Transcript): string => {
  transcript.step("web_search", searching("Florence Duomo photograph"));
  transcript.wait(1500);
  transcript.endStep();
  const url = "https://upload.wikimedia.org/wikipedia/commons/florence-duomo-dusk.jpg";
  transcript.world("web_has", { url, file: "riverside.jpg" });
  const cover = transcript.keptImage("riverside.jpg", "florence-duomo-dusk.jpg");
  agentCalls(transcript, "keep_image", { url }, { attachment: cover });
  return cover;
};

const boraPage = {
  address: "memory:people/bora",
  title: "Bora",
  gist: "Chairs the QRT panel; your Saturday running partner",
  aliases: ["Bora K"],
  links: ["memory:projects/qrt-panel"],
  markdown: "Bora chairs the QRT panel at work, and you run with her on Saturdays (as of 20 Oct).\n",
};

const qrtPage = {
  address: "memory:projects/qrt-panel",
  title: "QRT panel",
  gist: "Reviews your design in November",
  aliases: [],
  links: ["memory:people/bora"],
  markdown: "The QRT panel reviews your design in November; Bora wants one more round first (as of 22 Oct).\n",
};

const correctionOf = (text: string, meant: string, heard: string): Correction => ({
  offset: text.indexOf(meant),
  length: meant.length,
  heard,
});

const spokenWav = { "Content-Type": "audio/wav", "Content-Length": "12044" };

const preview = "Hi, I'm Ari. This is how I sound.";

const speak = (transcript: Transcript, voice?: string): void => {
  transcript.request("POST", "/v0/speech", { body: { text: preview, ...(voice !== undefined && { voice }) } });
  transcript.wait(240);
  transcript.response(200, undefined, { headers: { ...spokenWav, "Ito-Protocol": protocol } });
};

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
        agent: { name: "Ari" },
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
        "Stop names the turn and the cut point on screen; the stopped message keeps exactly that, " +
        "a message sent while stopping starts the next turn, and a Stop that arrives after a reply " +
        "finished changes nothing. When the screen lags, Stop cuts the message still being written " +
        "and a reply that already finished keeps all its text. A Stop while a step runs ends the " +
        "step as stopped, keeping its present-tense title.",
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
    const reply = transcript.reply();
    transcript.write(upTo(saturdayAnswer, "botanic garden,"), { everyMs: 110 });
    const cut = upTo(saturdayAnswer, "keep it light before").length;
    transcript.wait(60);
    transcript.stop(turn, { message: reply, offset: cut });
    transcript.status("stopping", "Stopping");
    transcript.wait(150);
    const morning = transcript.send("Actually, just plan the morning.");
    transcript.queue(morning);
    transcript.wait(250);
    transcript.endMessage("stopped", { length: cut });
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
    const sunday = sendAndStart(transcript, "And Sunday?");
    transcript.wait(900);
    transcript.status("writing", "Writing");
    const late = transcript.reply();
    transcript.write("Sunday: a slow start, then lunch with friends if you're up for it.", { pieces: 3 });
    transcript.endMessage("completed");
    transcript.endTurn("completed");
    transcript.wait(150);
    transcript.stop(sunday.turn, { message: late, offset: 52 });

    transcript.wait(20_000);
    const evening = sendAndStart(transcript, "And Saturday evening?");
    transcript.wait(900);
    writeWhole(transcript, "Evening: dinner at home, then an early night before the long run.", 3);
    transcript.status("writing", "Writing");
    const rainyDay = transcript.reply();
    transcript.write("If it rains, swap the walk for the ", { pieces: 2 });
    transcript.wait(60);
    transcript.stop(evening.turn, { message: rainyDay, offset: 0 });
    transcript.status("stopping", "Stopping");
    transcript.wait(150);
    transcript.endMessage("stopped", { length: 0 });
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
        "The model goes silent mid-reply; after 60 seconds the turn fails with a typed error and " +
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
    transcript.world("engine_stalls");
    transcript.wait(60_000);
    const error: ErrorBody = {
      code: "model_timeout",
      message: "The model didn't respond for 60 seconds.",
      detail: "No progress from the engine for 60 seconds while it was writing.",
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
      title: "Reporting a gap",
      summary:
        "The agent can't load a page it needs, so it gives its best answer, reports the gap to Ito and says so " +
        "in one line. Reports is a capability that's switched on, and the report is a tool step titled by " +
        "what it did, linking the issue it opened.",
      guarantees: ["G10", "G14"],
    });
    yesterday(transcript);
    transcript.begin(todayAt, { cursor: "latest" });
    transcript.world("capability_on", { capability: "reports", values: { token: "github_pat_example" } });
    transcript.connect();
    transcript.wait(2000);
    sendAndStart(transcript, "What time does the Battersea parkrun start?");
    transcript.wait(300);
    transcript.step("web_search", searching("Battersea parkrun start time"));
    transcript.wait(900);
    transcript.step("command", {
      title: "Fetching a web page",
      endedTitle: "Fetched a web page",
      fields: { command: "curl -sf https://www.parkrun.org.uk/battersea/", cwd: "/home/you/.ito/workspace" },
    });
    transcript.wait(700);
    transcript.endStep({ fields: { exit_code: 22, output: "curl: (22) The requested URL returned error: 403\n" } });
    transcript.step("tool", {
      title: "Reporting it to Ito",
      endedTitle: "Reported it to Ito",
      fields: {
        capability: "reports",
        operation: "report",
        arguments: {
          capability: "web search",
          operation: "open a page",
          tried: "Fetched the parkrun event page to read the start time",
          failed: "The page answered 403 to every fetch",
          would_help: "A browser that can load pages behind bot protection",
        },
      },
    });
    transcript.wait(1200);
    transcript.endStep({ fields: { url: "https://github.com/akai-ito/ito-core/issues/42" } });
    writeWhole(
      transcript,
      "Most parkruns start at 9:00, but I couldn't load Battersea's event page to confirm it, and I've " +
        "reported that. Check the page before you go.",
    );
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
        "its first line, Markdown stripped; the second turn fails, and that arrives too. Opening Ari catches up.",
      guarantees: ["G15", "G18"],
    });
    yesterday(transcript);
    transcript.begin(todayAt, { cursor: "latest" });
    transcript.connect();
    transcript.registerDevice();
    transcript.presence(true);
    transcript.wait(2000);
    const { turn } = sendAndStart(transcript, saturdayQuestion);
    transcript.wait(800);
    const bus = transcript.send("Also, does the 37 bus run before 7 on Saturdays?");
    transcript.queue(bus);
    transcript.wait(400);
    transcript.presence(false);
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
    transcript.presence(true);
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
    const juno = askWhichJuno(transcript);
    transcript.endTurn("completed");
    transcript.wait(4000);
    const clapham = transcript.send("Clapham", { answers: juno });
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
    const approval = transcript.ask({
      kind: "approval",
      question: "Shall I book this?",
      preview: "Juno, Clapham\nSaturday 18 October, 7:30pm\nTable for 2, under your name",
      options: [{ label: "Book it", acts: true }, { label: "Not now" }],
      allowsText: false,
    });
    transcript.endTurn("completed");
    transcript.wait(3000);
    const yes = transcript.send("Book it", { answers: approval });
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
        "The agent asks while you're away, so the ask arrives as a time-sensitive notification carrying " +
        "its options. Answering from the notification is an ordinary send naming the ask; the agent carries " +
        "on, and its reply notifies you too.",
      guarantees: ["G15", "G16", "G18"],
    });
    yesterday(transcript);
    transcript.begin(todayAt, { cursor: "latest" });
    transcript.connect();
    transcript.registerDevice();
    transcript.presence(true);
    transcript.wait(2000);
    sendAndStart(transcript, "Book a table at Juno for Friday at 8, for two.");
    transcript.wait(500);
    transcript.presence(false);
    transcript.disconnect("app_closed");
    transcript.wait(300);
    const juno = askWhichJuno(transcript);
    transcript.endTurn("completed");
    transcript.wait(90_000);
    transcript.world("notification_answered", { ask: juno, option: "Soho" });
    const soho = transcript.send("Soho", { answers: juno });
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
    transcript.presence(true);
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
      name: "24-the-reminder",
      scenario: 24,
      title: "The reminder",
      summary:
        "An ask made while you're away notifies you at once. Three hours later, still unanswered, it " +
        "sends one reminder at normal level, and then nothing more. When you answer, nothing is pushed: " +
        "you're looking.",
      guarantees: ["G15", "G16", "G18"],
    });
    yesterday(transcript);
    transcript.begin(todayAt, { cursor: "latest" });
    transcript.connect();
    transcript.registerDevice();
    transcript.presence(true);
    transcript.wait(2000);
    sendAndStart(transcript, "Book Juno for Saturday at 7:30, for two.");
    transcript.wait(400);
    transcript.presence(false);
    transcript.disconnect("app_closed");
    transcript.wait(300);
    const juno = askWhichJuno(transcript);
    transcript.endTurn("completed");
    transcript.remind();
    transcript.wait(5 * 60 * 60 * 1000);
    transcript.world("app_opened");
    transcript.connect();
    transcript.presence(true);
    transcript.wait(4000);
    const clapham = transcript.send("Clapham", { answers: juno });
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
      name: "25-a-secret",
      scenario: 25,
      title: "A secret",
      summary:
        "The agent asks for a code that was texted to you, as a secret. You send it naming the ask: the " +
        "agent receives it, but the conversation keeps an empty message marked secret, in the stream, the " +
        "answer and everywhere after.",
      guarantees: ["G17"],
    });
    yesterday(transcript);
    transcript.begin(todayAt, { cursor: "latest" });
    transcript.connect();
    transcript.wait(2000);
    sendAndStart(transcript, "Book Juno in Clapham for Saturday at 7:30, for two.");
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
    transcript.wait(1600);
    const code = transcript.ask({ question: "Juno texted you a 6-digit code. What is it?", secret: true });
    transcript.endTurn("completed");
    transcript.wait(12_000);
    const answer = transcript.send("481516", { answers: code });
    transcript.startTurn([answer]);
    transcript.wait(300);
    transcript.step("tool", booking("confirm", { reference: "JC4821" }));
    transcript.wait(1200);
    transcript.endStep();
    writeWhole(transcript, "Booked: Juno in Clapham, Saturday at 7:30, a table for two.");
    transcript.endTurn("completed");
    return transcript;
  },

  () => {
    const transcript = createTranscript({
      name: "26-turning-on-notifications",
      scenario: 26,
      title: "Turning on notifications",
      summary:
        "At the first longer task, Ari offers a nudge and you allow notifications. The app registers the " +
        "device with its push token and notification key and says you're looking; when you leave, the " +
        "finished reply notifies you.",
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
    transcript.presence(true);
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
    transcript.presence(false);
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
    transcript.presence(true);
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
        agent: { name: "Ari" },
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
        "Settings lists the capabilities installed with the server. You switch Reports on, its sheet asks for " +
        "a GitHub token, Test connection catches a wrong one, and the right one turns it on. The token never " +
        "comes back, only that one is set.",
      guarantees: ["G21"],
    });
    transcript.begin(todayAt);
    capabilityCall(transcript, "GET", "/v0/capabilities", undefined, 200, { capabilities: [reports("off", false)] });
    transcript.wait(4000);
    capabilityCall(transcript, "PUT", "/v0/capabilities/reports", { on: true }, 200, reports("setup", false));
    transcript.wait(12_000);
    capabilityCall(
      transcript,
      "POST",
      "/v0/capabilities/reports/check",
      { values: { token: "github_pat_wrong" } },
      200,
      { problem: "GitHub rejected that token." },
    );
    transcript.wait(9000);
    capabilityCall(
      transcript,
      "POST",
      "/v0/capabilities/reports/check",
      { values: { token: "github_pat_example" } },
      200,
      {},
    );
    transcript.wait(900);
    capabilityCall(
      transcript,
      "PUT",
      "/v0/capabilities/reports/setup",
      { values: { token: "github_pat_example" } },
      200,
      reports("on", true),
    );
    transcript.wait(300);
    transcript.request("GET", "/v0/server");
    transcript.wait(40);
    transcript.response(
      200,
      {
        name: "studio",
        version: serverVersion,
        protocol,
        agent: { name: "Ari" },
        setup: { notifications: false, memory_backup: false },
        capabilities: [{ id: "reports", version: "0.1" }],
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
        "old state to Earlier, adds to today's journal, and says so. Tapping the update shows the page " +
        "before and after.",
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
    agentCalls(transcript, "journal", {
      text: "Things with Alex are going really well: they're seeing a lot of each other.",
      gist: "Things going really well with Alex",
      note: "Going well with Alex",
    });
    memoryStep(transcript, "journaled", [{ address: "memory:journal/2026-10-26", title: "26 October 2026" }], {
      title: "Adding to today's journal",
      endedTitle: "Added to today's journal",
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
        agent: { name: "Ari", model: "gpt-6-luna", effort: "medium" },
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
    const user = transcript.youSay("walk-question.pcm", "What did Bora say about the QRT panel?", {
      heard: ["What did Bora", "What did Bora say about the"],
    });
    transcript.startTurn([user]);
    transcript.wait(400);
    transcript.step("thinking", thinking);
    transcript.wait(900);
    transcript.endStep();
    transcript.reply("note");
    transcript.write("Let me check what I have on Bora.", { pieces: 1 });
    transcript.endMessage("completed");
    transcript.wait(300);
    transcript.played("s1");
    transcript.wait(1200);
    writeWhole(
      transcript,
      "She wants one more round on your design before the panel sits in November. I've put what she " +
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
      name: "39-ari-learns-a-name",
      scenario: 39,
      title: "Ari learns a name",
      summary:
        "On a call the server mishears a name and a word. You fix both from the chat: the name's mishearing joins " +
        "that person's page and the word becomes a term of its own, so on your next turn the server corrects both " +
        "and says what it changed.",
      guarantees: ["G25"],
    });
    const vocabulary: readonly Term[] = [
      { text: "Bora", kind: "person", weight: 1, phrases: [], heard: ["Bara"] },
      { text: "Bora K", kind: "person", weight: 1, phrases: [], heard: ["Bara"] },
      { text: "QRT", kind: "term", weight: 0.5, phrases: [], heard: ["cutie"] },
    ];
    transcript.begin("2026-10-26T08:10:00.000Z");
    transcript.world("memory_holds", { pages: [boraPage, qrtPage] });
    transcript.connect();
    transcript.wait(2000);
    const call = transcript.startCall();
    transcript.wait(300);
    transcript.openStream(call);
    transcript.wait(5000);
    const first = transcript.youSay("walk-question.pcm", "What did Bara say about the cutie panel?");
    transcript.startTurn([first]);
    transcript.wait(900);
    writeWhole(transcript, "Did you mean Bora and the QRT panel? Tap a word to fix it.", 1);
    transcript.endTurn("completed");
    transcript.wait(3000);
    transcript.played("s1");
    transcript.wait(2500);
    transcript.played("s2");
    transcript.wait(20_000);
    transcript.request("POST", "/v0/vocabulary/corrections", {
      body: {
        corrections: [
          { heard: "Bara", meant: "Bora" },
          { heard: "cutie", meant: "QRT" },
        ],
      },
    });
    transcript.wait(80);
    transcript.response(
      200,
      {
        corrections: [
          { heard: "Bara", meant: "Bora", address: boraPage.address },
          { heard: "cutie", meant: "QRT" },
        ],
      },
      { headers: { "Ito-Protocol": protocol } },
    );
    transcript.wait(5000);
    const second = transcript.youSay("walk-follow-up.pcm", "When does Bara want the cutie notes?", { vocabulary });
    transcript.startTurn([second]);
    transcript.wait(900);
    writeWhole(transcript, "Bora wants them by Friday.", 1);
    transcript.endTurn("completed");
    transcript.wait(2000);
    transcript.played("s3");
    transcript.wait(60_000);
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
        "A walk earlier this morning was a call with one spoken message. Ari on the Mac connects for the first " +
        "time, and its snapshot carries the call before the message it opened, with the recording and the " +
        "corrections.",
      guarantees: ["G13", "G23"],
    });
    transcript.time("2026-10-26T07:30:00.000Z");
    const question = "What did Bora say about the QRT panel?";
    transcript.callExchange(
      question,
      "She wants one more round on your design before the panel sits in November.",
      [correctionOf(question, "Bora", "Bara"), correctionOf(question, "QRT", "cutie")],
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
    writeWhole(transcript, "It's on Wednesday at ten. Maya and Bora will both be there.", 1);
    transcript.endTurn("completed");
    transcript.wait(800);
    const cut = transcript.unplayed();
    const followUp = transcript.youSay("walk-follow-up.pcm", "Actually, can we move it to Thursday?");
    transcript.startTurn([followUp]);
    transcript.wait(50);
    for (const sentence of cut) transcript.played(sentence, true);
    transcript.wait(900);
    writeWhole(transcript, "I'll ask Maya for Thursday.", 1);
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
      name: "52-a-code-on-a-call",
      scenario: 52,
      title: "A code on a call",
      summary:
        "Ari needs a code mid-call. The server never takes a secret by voice: it says to type it in the chat, " +
        "a code said aloud stays an ordinary message, and the ask waits until you type the answer.",
      guarantees: ["G25"],
    });
    transcript.begin("2026-10-28T08:30:00.000Z");
    transcript.connect();
    transcript.wait(1000);
    const call = transcript.startCall();
    transcript.wait(300);
    transcript.openStream(call);
    transcript.wait(3000);
    const asked = transcript.youSay("walk-question.pcm", "Confirm the Juno booking.");
    transcript.startTurn([asked]);
    transcript.wait(1200);
    const code = transcript.ask({ question: "Juno texted you a 6-digit code. What is it?", secret: true });
    transcript.endTurn("completed");
    transcript.wait(2500);
    for (const sentence of transcript.unplayed()) transcript.played(sentence);
    transcript.wait(1500);
    const said = transcript.youSay("walk-follow-up.pcm", "It's four eight one five one six.");
    transcript.startTurn([said]);
    transcript.wait(900);
    writeWhole(transcript, "Type it in the chat, please. I won't take a code by voice.", 1);
    transcript.endTurn("completed");
    transcript.wait(2500);
    for (const sentence of transcript.unplayed()) transcript.played(sentence);
    transcript.wait(8000);
    const answer = transcript.send("481516", { answers: code });
    transcript.startTurn([answer]);
    transcript.wait(900);
    writeWhole(transcript, "Confirmed. You're booked at Juno on Saturday.", 1);
    transcript.endTurn("completed");
    transcript.wait(2500);
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
    const asked = transcript.approval(calendarApproval);
    transcript.wait(5000);
    const allowed = transcript.send("Allow", { answers: asked });
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
        "You tell Ari about a trip. Ari starts a page for it and adds to today's journal, each with a line on " +
        "what the page is now and a note on what changed. The Library leads with those notes, lists journal " +
        "days by their headlines, lists people with the circle Ari keeps for each, and shows the trip's " +
        "linked page by its name.",
      guarantees: ["G22"],
    });
    const seededAt = "2026-10-27T18:00:00.000Z";
    const janki = {
      address: "memory:people/janki",
      title: "Janki",
      gist: "Your oldest friend, from school",
      aliases: ["Janks"],
      links: [],
      markdown: "Your oldest friend; you met at school in Pune (as of 20 Oct).\n",
      note: "Oldest friend, from school",
      circle: "friends",
    };
    const yesterday = {
      address: "memory:journal/2026-10-26",
      title: "26 October 2026",
      gist: "Home from Ljubljana; Bora's first sub-two",
      aliases: [],
      links: [],
      markdown: "### 21:10\n\nHome from Ljubljana. Bora ran her first half marathon under two hours.\n",
      note: "Home from Ljubljana",
    };
    const florence = {
      address: "memory:projects/florence-trip",
      title: "Florence trip",
      gist: "With Janki, 6–9 November; nothing booked yet",
      aliases: [],
      links: [janki.address],
      markdown: "Florence with Janki, 6 to 9 November. Nothing booked yet (as of 27 Oct).\n",
    };
    const today = { address: "memory:journal/2026-10-27", title: "27 October 2026" };
    transcript.begin(seededAt);
    transcript.world("memory_holds", { pages: [janki, yesterday] });
    transcript.wait(10 * 60 * 1000);
    transcript.connect();
    transcript.wait(2000);
    sendAndStart(transcript, "Janki and I are off to Florence together, 6 to 9 November!");
    transcript.wait(700);
    const change = transcript.change();
    agentCalls(transcript, "write_page", {
      address: florence.address,
      title: florence.title,
      gist: florence.gist,
      note: "Florence with Janki, 6–9 Nov",
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
    agentCalls(transcript, "journal", {
      text: "Divy and Janki are off to Florence together, 6 to 9 November.",
      gist: "Florence planned with Janki",
      note: "Florence with Janki",
    });
    memoryStep(transcript, "journaled", [today], {
      title: "Adding to today's journal",
      endedTitle: "Added to today's journal",
    });
    transcript.wait(300);
    writeWhole(transcript, "Florence with Janki, lovely! I've started a page for the trip.");
    transcript.endTurn("completed");
    transcript.wait(5000);
    const writtenAt = new Date(Date.parse(seededAt) + 10 * 60 * 1000 + 2000 + 700).toISOString();
    const journaledAt = new Date(Date.parse(writtenAt) + 400).toISOString();
    memoryCall(transcript, "/v0/memory/recent", {
      changes: [
        { change: transcript.change(), ...today, at: journaledAt, note: "Florence with Janki" },
        {
          change,
          address: florence.address,
          title: florence.title,
          at: writtenAt,
          note: "Florence with Janki, 6–9 Nov",
        },
        {
          change: transcript.change(),
          address: yesterday.address,
          title: yesterday.title,
          at: seededAt,
          note: yesterday.note,
        },
        { change: transcript.change(), address: janki.address, title: janki.title, at: seededAt, note: janki.note },
      ],
    });
    transcript.wait(2000);
    memoryCall(transcript, "/v0/memory/pages?shelf=journal", {
      pages: [
        { ...today, gist: "Florence planned with Janki", changed_at: journaledAt },
        { address: yesterday.address, title: yesterday.title, gist: yesterday.gist, changed_at: seededAt },
      ],
    });
    transcript.wait(2000);
    memoryCall(transcript, "/v0/memory/pages?shelf=people", {
      pages: [
        { address: janki.address, title: janki.title, gist: janki.gist, circle: "friends", changed_at: seededAt },
      ],
    });
    transcript.wait(2000);
    memoryCall(
      transcript,
      `/v0/memory/page?address=${florence.address}`,
      pageBody({ ...florence, links: [] }, writtenAt, [janki]),
    );
    return transcript;
  },

  () => {
    const transcript = createTranscript({
      name: "58-topics",
      scenario: 58,
      title: "Topics",
      summary:
        "Last night you planned Florence, then asked about Bora. Ari marked each change of subject with a quiet " +
        "label on the message that changed it, and none for a follow-up. In the morning the snapshot carries " +
        "both labels, and when you come back to Florence, Ari marks it with the same label.",
      guarantees: ["G29"],
    });
    transcript.time("2026-10-27T19:00:00.000Z");
    transcript.exchange(
      "Can you help me plan Florence with Janki?",
      "Of course! Three days fits the Uffizi, the Duomo and a morning in Siena.",
      [],
      "Florence trip",
    );
    transcript.wait(60_000);
    transcript.exchange(
      "Different thing: what should I tell Bora about the QRT panel?",
      "Tell her the design is ready for one more round, and ask which part worries her most.",
      [],
      "QRT panel",
    );
    transcript.wait(30_000);
    transcript.exchange("And when should I send it?", "Before Friday, so she has the weekend to read it.");
    transcript.begin("2026-10-28T08:00:00.000Z");
    transcript.world("app_opened");
    transcript.connect();
    transcript.wait(3000);
    const back = sendAndStart(transcript, "Back to Florence: which day should we do the Uffizi?");
    transcript.wait(700);
    agentCalls(transcript, "mark_topic", { label: "Florence trip" });
    transcript.topic("Florence trip", back.user);
    transcript.wait(300);
    writeWhole(transcript, "The first morning, before it gets busy. Book the 8:15 slot.");
    transcript.endTurn("completed");
    return transcript;
  },

  () => {
    const transcript = createTranscript({
      name: "59-a-plan-you-can-tick",
      scenario: 59,
      title: "A plan you can tick",
      summary:
        "Ari answers with a plan, a time and a place, as blocks the app draws. You tick the first item, and " +
        "ticking it again changes nothing. Scrolling back later, the reply comes with its tick.",
      guarantees: ["G30"],
    });
    transcript.begin("2026-10-28T12:00:00.000Z");
    transcript.connect();
    transcript.wait(2000);
    sendAndStart(transcript, "Can you plan our three days in Florence? We land on Friday morning.");
    transcript.wait(900);
    transcript.status("writing", "Writing");
    const reply = transcript.reply();
    transcript.write(
      [
        "Here's a gentle shape for it, with the Uffizi first thing on Saturday, before the crowds.",
        "",
        "```ari:plan",
        JSON.stringify({
          title: "Florence",
          items: [
            { id: "book-uffizi", text: "Book the Uffizi for 8:15 on Saturday", when: "This week", done: false },
            { id: "duomo-climb", text: "Climb the Duomo", when: "Fri 6 Nov, afternoon", done: false },
            { id: "siena", text: "Train to Siena", when: "Sun 8 Nov", done: false },
          ],
        }),
        "```",
        "",
        "```ari:time",
        JSON.stringify({
          title: "Uffizi, 8:15 entry",
          start: "2026-11-07T08:15",
          end: "2026-11-07T11:00",
          timezone: "Europe/Rome",
          location: "Uffizi Gallery",
        }),
        "```",
        "",
        "```ari:place",
        JSON.stringify({
          name: "Uffizi Gallery",
          address: "Piazzale degli Uffizi 6, Florence",
          lat: 43.7678,
          lon: 11.2553,
        }),
        "```",
      ].join("\n"),
    );
    transcript.endMessage("completed");
    transcript.endTurn("completed");
    transcript.wait(60_000);
    transcript.tick(reply, 0, "book-uffizi", true);
    transcript.wait(1000);
    transcript.tick(reply, 0, "book-uffizi", true);
    transcript.wait(5 * 60 * 1000);
    const booked = sendAndStart(transcript, "Booked! How do we get from the station to the hotel?");
    transcript.wait(800);
    writeWhole(transcript, "It's a ten-minute walk, flat all the way, past San Lorenzo.");
    transcript.endTurn("completed");
    transcript.wait(2000);
    transcript.listMessages(booked.user, 2);
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
        "You ask Ari to plan a weekend. Ari finds a cover photo, starts the trip as a thing in motion with its days, " +
        "places, travel, stay and to-do list, and answers in a line with a compact line under it. The trip is " +
        "pinned; the app lists it, opens it, and fetches its photo from the server.",
      guarantees: ["G32"],
    });
    transcript.begin("2026-10-29T09:00:00.000Z");
    transcript.connect();
    transcript.wait(2000);
    sendAndStart(
      transcript,
      "Can you plan Florence with Janki? 6 to 9 November. Good food, the Uffizi, maybe Pisa for a day.",
    );
    transcript.wait(800);
    const cover = findFlorenceCover(transcript);
    transcript.wait(2500);
    const { motion, change } = startFlorence(transcript, cover);
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
      content: florenceTrip(cover),
      state: {},
      changes: [change],
    });
    transcript.wait(300);
    transcript.fetchAttachment(cover);
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
        "yourself, every app hears it, and Ari learns of it with your next message. The trip shows what changed.",
      guarantees: ["G32"],
    });
    transcript.begin("2026-10-29T09:00:00.000Z");
    transcript.connect();
    transcript.wait(2000);
    sendAndStart(transcript, "Can you plan Florence with Janki? 6 to 9 November.");
    transcript.wait(800);
    const cover = findFlorenceCover(transcript);
    transcript.wait(2000);
    const started = startFlorence(transcript, cover);
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
      { ...florenceCard, cover, version: 2, summary: "6–9 Nov · 3 to book" },
      note,
    );
    motionStep(
      transcript,
      "updated",
      changed.motion,
      {
        title: "Updating Florence with Janki: booked the Uffizi, 8:15 Saturday",
        endedTitle: "Updated Florence with Janki: booked the Uffizi, 8:15 Saturday",
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
    const state = transcript.patchMotion(florenceId, { todo: { "book-pisa": { done: true } } });
    transcript.wait(3000);
    memoryCall(transcript, `/v0/motion/${florenceId}`, {
      motion: changed.motion,
      content: {
        ...florenceTrip(cover),
        days: (florenceTrip(cover).days as readonly Readonly<Record<string, unknown>>[]).map((day) =>
          day.id === "sat"
            ? {
                ...day,
                stops: (day.stops as readonly Readonly<Record<string, unknown>>[]).map((stop) =>
                  stop.id === "uffizi" ? { ...stop, booking: { status: "booked", ref: "UF-2291" } } : stop,
                ),
              }
            : day,
        ),
        places: (florenceTrip(cover).places as readonly Readonly<Record<string, unknown>>[]).map((place) =>
          place.id === "uffizi-place"
            ? { ...place, status: "booked", booking: { status: "booked", ref: "UF-2291" } }
            : place,
        ),
        todo: (florenceTrip(cover).todo as readonly Readonly<Record<string, unknown>>[]).map((item) =>
          item.id === "book-uffizi" ? { ...item, done: true } : item,
        ),
      },
      state,
      changes: [changed.change, started.change],
    });
    transcript.wait(2000);
    sendAndStart(transcript, "Thanks! What's left?");
    transcript.wait(900);
    writeWhole(transcript, "The Duomo climb and the Pitti Palace. The Pisa train's ticked off.");
    transcript.endTurn("completed");
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
