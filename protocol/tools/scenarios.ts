import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Error as ErrorBody } from "#protocol/types.ts";
import { loadSpec } from "./spec.ts";
import { transcriptDirectory } from "./transcript-files.ts";
import { createTranscript, type Transcript } from "./transcript.ts";

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

const writeWhole = (transcript: Transcript, text: string, pieces?: number): void => {
  transcript.status("writing", "Writing");
  transcript.reply();
  transcript.write(text, { pieces });
  transcript.endMessage("completed");
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
    transcript.response(200, { product: "ito", protocol: ["0.1"] }, { headers: { "Ito-Protocol": "0.1" } });
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
      { headers: { "Ito-Protocol": "0.1" } },
    );
    transcript.wait(9000);
    transcript.request("GET", "/v0/server", { headers: { Authorization: authorization } });
    transcript.wait(40);
    transcript.response(
      200,
      { name: "studio", version: "0.1.0", protocol: "0.1", agent: { name: "Ari" } },
      { headers: { "Ito-Protocol": "0.1" } },
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
    transcript.status("thinking", "Thinking");
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
        "The turn starts at once, then the live status follows the work in plain words, with a " +
        "note from the agent along the way, and ends with the turn.",
      guarantees: ["G8", "G10"],
    });
    yesterday(transcript);
    transcript.begin(todayAt, { cursor: "latest" });
    transcript.connect();
    transcript.wait(2000);
    sendAndStart(transcript, saturdayQuestion);
    transcript.wait(250);
    transcript.status("thinking", "Thinking");
    transcript.wait(900);
    transcript.status("thinking", "Thinking", "Sketching a calm Saturday");
    transcript.wait(700);
    transcript.reply("note");
    transcript.write("I'll check which cafés by the river open early.", { pieces: 2 });
    transcript.endMessage("completed");
    transcript.wait(40);
    transcript.status("working", "Searching the web", "riverside cafés open at 9am");
    transcript.wait(2600);
    transcript.status("thinking", "Thinking", "Fitting the day around the run");
    transcript.wait(1100);
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
    transcript.status("thinking", "Thinking");
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
    transcript.status("thinking", "Thinking");
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
        "finished changes nothing.",
      guarantees: ["G3", "G7", "G9"],
    });
    yesterday(transcript);
    transcript.begin(todayAt, { cursor: "latest" });
    transcript.connect();
    transcript.wait(2000);
    const { turn } = sendAndStart(transcript, saturdayQuestion);
    transcript.wait(300);
    transcript.status("thinking", "Thinking");
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
    transcript.status("thinking", "Thinking");
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
    transcript.status("thinking", "Thinking");
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
        "says there is nothing older; pages are bounded by messages, so they never shift.",
      guarantees: ["G3"],
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
    transcript.status("thinking", "Thinking");
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
    transcript.status("waiting", "Tidying up its notes");
    transcript.wait(700);
    const seats = transcript.send("With outdoor seats, ideally.");
    transcript.queue(seats);
    transcript.wait(2169);
    transcript.status("working", "Searching the web", "breakfast by the river, London");
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
    transcript.status("thinking", "Thinking");
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
    transcript.status("thinking", "Thinking");
    transcript.wait(1700);
    transcript.send(juno, { id: first });
    const second = transcript.send("And book for two at 8 if so");
    transcript.wait(600);
    transcript.read(second);
    transcript.status("working", "Searching the web", "Bistro Juno Sunday opening hours");
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
    transcript.status("thinking", "Thinking");
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
    transcript.status("thinking", "Thinking");
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
        "same message.",
      guarantees: ["G2", "G8", "G10"],
    });
    yesterday(transcript);
    transcript.begin(todayAt, { cursor: "latest" });
    transcript.connect();
    transcript.wait(2000);
    const { turn } = sendAndStart(transcript, saturdayQuestion);
    transcript.wait(300);
    transcript.status("thinking", "Thinking");
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
    transcript.status("thinking", "Thinking");
    transcript.wait(1200);
    writeWhole(transcript, saturdayAnswer, 4);
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
