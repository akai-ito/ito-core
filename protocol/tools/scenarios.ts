import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Error as ErrorBody } from "#protocol/types.ts";
import { loadSpec } from "./spec.ts";
import { transcriptDirectory } from "./transcript-files.ts";
import { createTranscript, type Transcript } from "./transcript.ts";

const protocol = "0.6";
const serverVersion = "0.6.0";
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
  aliases: ["Alex R"],
  links: ["memory:places/dishoom-shoreditch"],
  markdown:
    "Taking things slow; you've been on two dates (as of 15 Oct).\n\n## Earlier\n\n" +
    "- 12 Oct: first date, Dishoom Shoreditch.\n",
};

const alexNow = {
  ...alexBefore,
  markdown:
    "Seeing each other a lot, and it's going really well (as of 26 Oct).\n\n## Earlier\n\n" +
    "- 15 Oct: decided to take things slow.\n- 12 Oct: first date, Dishoom Shoreditch.\n",
};

const lisbonTrip = {
  address: "memory:projects/lisbon-trip",
  title: "Lisbon trip",
  aliases: [],
  links: ["memory:people/alex"],
  markdown: "Four nights in Lisbon, 14 to 18 November. Flights booked; no hotel yet (as of 20 Oct).\n",
};

const nowPage = {
  address: "memory:now",
  title: "Now",
  aliases: [],
  links: [],
  markdown: "A busy fortnight at work, and training for the Valencia half marathon (as of 22 Oct).\n",
};

type SeededPage = typeof alexBefore;

const shelfOf = (address: string): string => address.replace(/^memory:/u, "").split("/", 1)[0] ?? "";

const pageBody = (page: SeededPage, changedAt: string): Readonly<Record<string, unknown>> => ({
  address: page.address,
  title: page.title,
  shelf: shelfOf(page.address),
  aliases: page.aliases,
  links: page.links,
  changed_at: changedAt,
  markdown: page.markdown,
});

const memoryCall = (transcript: Transcript, path: string, answer: unknown): void => {
  transcript.request("GET", path);
  transcript.wait(50);
  transcript.response(200, answer, { headers: { "Ito-Protocol": protocol } });
};

const agentCalls = (transcript: Transcript, tool: string, input: Readonly<Record<string, unknown>>): void => {
  transcript.world("agent_calls", { tool, input });
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
    agentCalls(transcript, "remember", {
      address: alexNow.address,
      title: alexNow.title,
      aliases: alexNow.aliases,
      links: alexNow.links,
      body: alexNow.markdown,
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
        "You ask Ari to forget part of a page. Ari rewrites the page without it, as an ordinary update, and " +
        "the Memory screen shows the page among the most recently changed.",
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
    transcript.world("memory_holds", { pages: [alexNow, nowPage] });
    transcript.wait(30 * 60 * 1000);
    transcript.connect();
    transcript.wait(2000);
    sendAndStart(transcript, "Please forget the bit about our first date.");
    transcript.wait(800);
    const change = transcript.change();
    agentCalls(transcript, "remember", {
      address: alexForgotten.address,
      title: alexForgotten.title,
      aliases: alexForgotten.aliases,
      links: alexForgotten.links,
      body: alexForgotten.markdown,
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
      pages: [
        { address: alexForgotten.address, title: "Alex", changed_at: updatedAt },
        { address: nowPage.address, title: "Now", changed_at: seededAt },
      ],
    });
    transcript.wait(2000);
    memoryCall(transcript, "/v0/memory/shelves", {
      shelves: [
        { shelf: "people", count: 1 },
        { shelf: "goals", count: 0 },
        { shelf: "projects", count: 0 },
        { shelf: "places", count: 0 },
        { shelf: "topics", count: 0 },
        { shelf: "journal", count: 0 },
      ],
    });
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
