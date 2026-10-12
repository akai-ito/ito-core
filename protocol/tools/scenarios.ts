import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadSpec, protocolDir } from "./spec.ts";
import { Transcript, type ErrorObject } from "./transcript.ts";

const outDir = join(protocolDir, "transcripts");

const YESTERDAY = "2026-10-11T21:14:00.000Z";
const TODAY = "2026-10-12T08:41:00.000Z";
const TOKEN = "Bearer ito_example_not_a_real_token_00000000000000000000";

const BIKE_Q = "Is it worth fixing the old bike or buying a new one?";
const BIKE_A =
  "Fix it. The frame is sound; new brakes and a chain come to about £90, against roughly £600 " +
  "for a comparable new bike. If the gears still slip after that, revisit.";
const SATURDAY_Q = "Plan my Saturday: long run in the morning, then something calm.";
const SATURDAY_A = [
  "Here's a shape for Saturday:",
  "",
  "- **07:30** Long run, 18 km along the river; flat, and the café opens at 9.",
  "- **10:00** Breakfast, then a slow hour with your book.",
  "- **13:00** Lunch at home; keep it light before the afternoon.",
  "- **15:00** A walk in the botanic garden, phone in your pocket.",
  "",
  "Early night: you're up at 7.",
].join("\n");

function upTo(text: string, marker: string): string {
  const index = text.indexOf(marker);
  if (index < 0) throw new Error(`marker not found: ${marker}`);
  return text.slice(0, index + marker.length);
}

function after(text: string, prefix: string): string {
  if (!text.startsWith(prefix)) throw new Error("not a prefix");
  return text.slice(prefix.length);
}

function yesterday(s: Transcript): void {
  s.time(YESTERDAY);
  s.exchange(BIKE_Q, BIKE_A);
}

function sendAndStart(s: Transcript, text: string): { user: string; turn: string } {
  const user = s.send(text);
  const turn = s.startTurn([user]);
  return { user, turn };
}

function writeWhole(s: Transcript, text: string, pieces?: number): string {
  s.status("writing", "Writing");
  const message = s.reply();
  s.write(text, { pieces });
  s.endMessage("completed");
  return message;
}

const scenarios: (() => Transcript)[] = [
  () => {
    const s = new Transcript({
      name: "01-first-connection",
      scenario: 1,
      title: "First connection",
      summary:
        "Ari checks which protocol the server speaks, is refused a mistyped token, then connects " +
        "with the right one and receives a snapshot of an empty conversation.",
      guarantees: ["G11", "G12"],
    });
    s.begin(TODAY);
    s.request("GET", "/.well-known/ito");
    s.wait(40);
    s.response(200, { product: "ito", protocol: ["0.1"] }, { headers: { "Ito-Protocol": "0.1" } });
    s.wait(20);
    s.request("GET", "/v0/server", {
      headers: { Authorization: "Bearer ito_example_mistyped_token_0000000000000000000" },
    });
    s.wait(40);
    s.response(
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
    s.wait(9000);
    s.request("GET", "/v0/server", { headers: { Authorization: TOKEN } });
    s.wait(40);
    s.response(
      200,
      { name: "studio", version: "0.1.0", protocol: "0.1", agent: { name: "Ari" } },
      { headers: { "Ito-Protocol": "0.1" } },
    );
    s.wait(10);
    s.connect({ headers: { Authorization: TOKEN } });
    return s;
  },

  () => {
    const s = new Transcript({
      name: "02-open-ari",
      scenario: 2,
      title: "Open Ari",
      summary:
        "The next morning Ari shows what it already had, then resumes from its cursor and " +
        "receives only what is new: an exchange you had on the Mac last night.",
      guarantees: ["G2", "G4", "G13"],
    });
    yesterday(s);
    const phoneSaw = s.latestEventId();
    s.time("2026-10-11T22:05:00.000Z");
    s.exchange(
      "What time is sunrise on Saturday?",
      "07:12 in London, so it's light enough to start a run by about 06:50.",
    );
    s.begin("2026-10-12T07:58:00.000Z", { cursor: phoneSaw });
    s.world("app_opened");
    s.connect();
    return s;
  },

  () => {
    const s = new Transcript({
      name: "03-send",
      scenario: 3,
      title: "Send",
      summary:
        "Ari sends a message under the id it chose; the server confirms once the message is on " +
        "disk, before the agent is involved, and every app receives it.",
      guarantees: ["G1", "G2"],
    });
    yesterday(s);
    s.begin(TODAY, { cursor: "latest" });
    s.connect();
    s.wait(2000);
    sendAndStart(s, SATURDAY_Q);
    s.wait(400);
    s.status("thinking", "Thinking");
    s.wait(1500);
    writeWhole(s, SATURDAY_A, 3);
    s.endTurn("completed");
    return s;
  },

  () => {
    const s = new Transcript({
      name: "04-the-agent-stirs",
      scenario: 4,
      title: "The agent stirs",
      summary:
        "The turn starts at once, then the live status follows the work in plain words, with a " +
        "note from the agent along the way, and ends with the turn.",
      guarantees: ["G8", "G10"],
    });
    yesterday(s);
    s.begin(TODAY, { cursor: "latest" });
    s.connect();
    s.wait(2000);
    sendAndStart(s, SATURDAY_Q);
    s.wait(250);
    s.status("thinking", "Thinking");
    s.wait(900);
    s.status("thinking", "Thinking", "Sketching a calm Saturday");
    s.wait(700);
    s.reply("note");
    s.write("I'll check which cafés by the river open early.", { pieces: 2 });
    s.endMessage("completed");
    s.wait(40);
    s.status("working", "Searching the web", "riverside cafés open at 9am");
    s.wait(2600);
    s.status("thinking", "Thinking", "Fitting the day around the run");
    s.wait(1100);
    writeWhole(s, SATURDAY_A, 4);
    s.endTurn("completed");
    return s;
  },

  () => {
    const s = new Transcript({
      name: "05-the-reply-streams",
      scenario: 5,
      title: "The reply streams",
      summary:
        "Reply text arrives as appended pieces, each with its offset, including a burst after the " +
        "network held several back; the finished text is exactly what streamed.",
      guarantees: ["G7"],
    });
    yesterday(s);
    s.begin(TODAY, { cursor: "latest" });
    s.connect();
    s.wait(2000);
    sendAndStart(s, SATURDAY_Q);
    s.wait(300);
    s.status("thinking", "Thinking");
    s.wait(1500);
    s.status("writing", "Writing");
    s.reply();
    const first = upTo(SATURDAY_A, "café opens at 9.\n");
    const second = upTo(after(SATURDAY_A, first), "before the afternoon.\n");
    s.write(first, { every: 110 });
    s.wait(110);
    s.stall(900);
    s.write(second, { every: 110 });
    s.wait(1000);
    s.write(after(SATURDAY_A, first + second), { every: 110 });
    s.endMessage("completed");
    s.endTurn("completed");
    return s;
  },

  () => {
    const s = new Transcript({
      name: "06-you-scroll-up-mid-reply",
      scenario: 6,
      title: "You scroll up mid-reply",
      summary:
        "Nothing changes on the wire while you read back: the reply keeps streaming, and its end " +
        "is an explicit event, so the app can say it finished without guessing.",
      guarantees: ["G8"],
    });
    yesterday(s);
    s.begin(TODAY, { cursor: "latest" });
    s.connect();
    s.wait(2000);
    sendAndStart(s, SATURDAY_Q);
    s.wait(300);
    s.status("thinking", "Thinking");
    s.wait(1200);
    s.status("writing", "Writing");
    s.reply();
    const first = upTo(SATURDAY_A, "slow hour with your book.\n");
    s.write(first, { every: 120 });
    s.world("app_scrolled_up");
    s.wait(120);
    s.write(after(SATURDAY_A, first), { every: 120 });
    s.endMessage("completed");
    s.endTurn("completed");
    return s;
  },

  () => {
    const s = new Transcript({
      name: "07-stop",
      scenario: 7,
      title: "Stop",
      summary:
        "Stop names the turn and the cut point on screen; the stopped message keeps exactly that, " +
        "a message sent while stopping starts the next turn, and a Stop that arrives after a reply " +
        "finished changes nothing.",
      guarantees: ["G3", "G7", "G9"],
    });
    yesterday(s);
    s.begin(TODAY, { cursor: "latest" });
    s.connect();
    s.wait(2000);
    const { turn } = sendAndStart(s, SATURDAY_Q);
    s.wait(300);
    s.status("thinking", "Thinking");
    s.wait(1400);
    s.status("writing", "Writing");
    const reply = s.reply();
    s.write(upTo(SATURDAY_A, "botanic garden,"), { every: 110 });
    const cut = upTo(SATURDAY_A, "keep it light before").length;
    s.wait(60);
    s.stop(turn, { message: reply, offset: cut });
    s.status("stopping", "Stopping");
    s.wait(150);
    const morning = s.send("Actually, just plan the morning.");
    s.queue(morning);
    s.wait(250);
    s.endMessage("stopped", { length: cut });
    s.endTurn("stopped");
    s.wait(5);
    s.startTurn([morning]);
    s.wait(300);
    s.status("thinking", "Thinking");
    s.wait(1100);
    writeWhole(
      s,
      "Morning only:\n\n- **07:30** Long run, 18 km along the river.\n- **09:15** Coffee at the café by the bridge; it opens at 9.",
    );
    s.endTurn("completed");

    s.wait(20000);
    const sunday = sendAndStart(s, "And Sunday?");
    s.wait(900);
    s.status("writing", "Writing");
    const late = s.reply();
    s.write("Sunday: a slow start, then lunch with friends if you're up for it.", { pieces: 3 });
    s.endMessage("completed");
    s.endTurn("completed");
    s.wait(150);
    s.stop(sunday.turn, { message: late, offset: 52 });
    return s;
  },

  () => {
    const s = new Transcript({
      name: "08-copy-and-share",
      scenario: 8,
      title: "Copy and share",
      summary:
        "Message text is the Markdown source, code fence included, available piece by piece while " +
        "it streams, so the app can copy any part of it at any time.",
      guarantees: ["G7"],
    });
    yesterday(s);
    s.begin(TODAY, { cursor: "latest" });
    s.connect();
    s.wait(2000);
    sendAndStart(s, "How do I see what's using port 8080 on my Mac?");
    s.wait(300);
    s.status("thinking", "Thinking");
    s.wait(1200);
    writeWhole(
      s,
      "Run this in Terminal:\n\n```sh\nlsof -nP -iTCP:8080 -sTCP:LISTEN\n```\n\nThe second column is the process ID; `kill <PID>` stops it.",
      6,
    );
    s.endTurn("completed");
    return s;
  },

  () => {
    const s = new Transcript({
      name: "09-scrolling-back",
      scenario: 9,
      title: "Scrolling back",
      summary:
        "Ari pages backwards from the oldest message it has, a page at a time, until the server " +
        "says there is nothing older; pages are bounded by messages, so they never shift.",
      guarantees: ["G3"],
    });
    s.time("2026-09-01T17:30:00.000Z");
    s.exchange(
      "Any good running routes near Battersea?",
      "The river loop from Albert Bridge to Chelsea Bridge is about 5 km, flat and lit after dark. Add Battersea Park's outer path for 8 km.",
    );
    s.time("2026-09-10T06:55:00.000Z");
    const stretch = s.exchange(
      "What's a good stretch after a long run?",
      "Calves and hamstrings first: two minutes each against a wall, then a slow hip-flexor lunge. Skip deep static stretches straight after a race.",
    );
    s.time("2026-09-14T17:02:00.000Z");
    s.exchange(
      "Somewhere quiet for dinner near Clapham, Thursday?",
      "**Bistro Juno**: small, quiet after 8, and they hold tables for 15 minutes. Book through their site; Thursday has space at 19:45.",
    );
    s.time("2026-09-16T20:40:00.000Z");
    const thanks = s.exchange(
      "Thanks, Juno was perfect.",
      "Glad it worked. I'll remember it for next time you want somewhere quiet.",
    );
    yesterday(s);
    s.begin(TODAY, { cursor: "latest", oldestCached: thanks.user });
    s.connect();
    s.wait(3000);
    s.listMessages(thanks.user, 4);
    s.wait(2500);
    s.listMessages(stretch.user, 4);
    return s;
  },

  () => {
    const s = new Transcript({
      name: "10-send-while-it-s-busy",
      scenario: 10,
      title: "Send while it's busy",
      summary:
        "A message sent mid-reply joins the running turn: the reply being written finishes, the " +
        "agent reads the message and adjusts in a new reply. While the agent can't take input, a " +
        "message waits as Next and starts the following turn.",
      guarantees: ["G2", "G3"],
    });
    yesterday(s);
    s.begin(TODAY, { cursor: "latest" });
    s.connect();
    s.wait(2000);
    sendAndStart(s, SATURDAY_Q);
    s.wait(300);
    s.status("thinking", "Thinking");
    s.wait(1400);
    s.status("writing", "Writing");
    s.reply();
    const first = upTo(SATURDAY_A, "slow hour with your book.\n");
    s.write(first, { every: 110 });
    s.wait(80);
    const outdoors = s.send("Make the calm part outdoors");
    s.write(after(SATURDAY_A, first), { every: 110 });
    s.endMessage("completed");
    s.wait(400);
    s.read(outdoors);
    s.status("adjusting", "Adjusting to your message");
    s.wait(900);
    s.status("writing", "Writing");
    s.reply();
    s.write(
      "Moving the calm part outside:\n\n- **13:00** Picnic lunch in the park instead.\n- **15:00** Keep the botanic garden walk; it's outdoors already.",
    );
    s.endMessage("completed");
    s.endTurn("completed");

    s.wait(30000);
    sendAndStart(s, "Also find somewhere for breakfast by the river.");
    s.wait(200);
    s.world("engine_compacting", { until: s.stepAtOffset(2900) });
    s.status("waiting", "Tidying up its notes");
    s.wait(700);
    const seats = s.send("With outdoor seats, ideally.");
    s.queue(seats);
    s.wait(2169);
    s.status("working", "Searching the web", "breakfast by the river, London");
    s.wait(2400);
    writeWhole(s, "**The Boathouse** opens at 8 and faces the water, ten minutes' walk from where your run ends.");
    s.endTurn("completed");
    s.wait(5);
    s.startTurn([seats]);
    s.wait(600);
    writeWhole(s, "It does: six tables on the terrace, first come, first served.");
    s.endTurn("completed");
    return s;
  },

  () => {
    const s = new Transcript({
      name: "11-signal-drops-mid-reply",
      scenario: 11,
      title: "Signal drops mid-reply",
      summary:
        "The connection drops twice mid-reply. Each time Ari resumes from its cursor and receives " +
        "exactly the pieces it missed; the second time the reply finished while it was away, so " +
        "the rest and the end arrive at once.",
      guarantees: ["G4", "G7"],
    });
    yesterday(s);
    s.begin(TODAY, { cursor: "latest" });
    s.connect();
    s.wait(2000);
    sendAndStart(s, SATURDAY_Q);
    s.wait(300);
    s.status("thinking", "Thinking");
    s.wait(1300);
    s.status("writing", "Writing");
    s.reply();
    const first = upTo(SATURDAY_A, "Breakfast, then a slow ");
    s.write(first, { every: 110 });
    s.wait(50);
    s.disconnect("offline");
    s.wait(70);
    const second = upTo(after(SATURDAY_A, first), "Lunch at home;");
    s.write(second, { every: 110 });
    s.wait(5200);
    s.world("online");
    s.connect();
    s.wait(110);
    const third = upTo(after(SATURDAY_A, first + second), "phone in your");
    s.write(third, { every: 110 });
    s.wait(40);
    s.disconnect("offline");
    s.wait(70);
    s.write(after(SATURDAY_A, first + second + third), { every: 110 });
    s.endMessage("completed");
    s.endTurn("completed");
    s.wait(19000);
    s.world("online");
    s.connect();
    return s;
  },

  () => {
    const s = new Transcript({
      name: "12-send-while-offline",
      scenario: 12,
      title: "Send while offline",
      summary:
        "Two messages written offline go out in order once the signal returns. The first response " +
        "is lost, so Ari sends the first message again and gets the same message back, unchanged; " +
        "the second joins the turn the first started.",
      guarantees: ["G1", "G2", "G3"],
    });
    yesterday(s);
    s.begin(TODAY, { cursor: "latest" });
    s.connect();
    s.wait(1000);
    s.disconnect("offline");
    s.wait(9000);
    s.world("online");
    s.connect();
    s.wait(5);
    const juno = "Also, can you check if Juno is open on Sunday?";
    const first = s.send(juno, { lost: true });
    s.startTurn([first]);
    s.wait(300);
    s.status("thinking", "Thinking");
    s.wait(1700);
    s.send(juno, { id: first });
    const second = s.send("And book for two at 8 if so");
    s.wait(600);
    s.read(second);
    s.status("working", "Searching the web", "Bistro Juno Sunday opening hours");
    s.wait(2600);
    writeWhole(
      s,
      "Juno is open on Sunday from 18:00, and they have a table for two at 20:00. I can't book for you yet; their booking page is bistrojuno.example/book.",
    );
    s.endTurn("completed");
    return s;
  },

  () => {
    const s = new Transcript({
      name: "13-ari-is-closed-mid-reply",
      scenario: 13,
      title: "Ari is closed mid-reply",
      summary:
        "Ari closes mid-reply and the agent keeps working on the server. When you return, Ari " +
        "resumes from its cursor and receives the rest of the reply and its end at once.",
      guarantees: ["G4", "G6"],
    });
    yesterday(s);
    s.begin(TODAY, { cursor: "latest" });
    s.connect();
    s.wait(2000);
    sendAndStart(s, SATURDAY_Q);
    s.wait(300);
    s.status("thinking", "Thinking");
    s.wait(1300);
    s.status("writing", "Writing");
    s.reply();
    const first = upTo(SATURDAY_A, "café opens at 9.\n");
    s.write(first, { every: 110 });
    s.wait(50);
    s.disconnect("app_closed");
    s.wait(60);
    s.write(after(SATURDAY_A, first), { every: 110 });
    s.endMessage("completed");
    s.endTurn("completed");
    s.wait(660000);
    s.world("app_opened");
    s.connect();
    return s;
  },

  () => {
    const s = new Transcript({
      name: "14-the-server-restarts-or-is-restored",
      scenario: 14,
      title: "The server restarts, or is restored",
      summary:
        "The server restarts mid-reply and, on startup, ends the cut-off turn, keeping its text as " +
        "interrupted; Ari learns it by resuming. Another day the server is restored from a backup, " +
        "Ari's cursor is unknown to it, and Ari receives a snapshot of what the server has.",
      guarantees: ["G1", "G5", "G8"],
    });
    yesterday(s);
    const backup = s.latestEventId();
    if (!backup) throw new Error("no backup point");
    s.begin(TODAY, { cursor: "latest" });
    s.connect();
    s.wait(2000);
    sendAndStart(s, SATURDAY_Q);
    s.wait(300);
    s.status("thinking", "Thinking");
    s.wait(1300);
    s.status("writing", "Writing");
    s.reply();
    s.write(upTo(SATURDAY_A, "slow hour with your book.\n"), { every: 110 });
    s.wait(80);
    s.restart();
    s.wait(1500);
    s.connect();
    s.wait(86400000);
    s.restore(backup);
    s.wait(2000);
    s.connect();
    return s;
  },

  () => {
    const s = new Transcript({
      name: "15-something-fails",
      scenario: 15,
      title: "Something fails",
      summary:
        "The model goes silent mid-reply; after 60 seconds the turn fails with a typed error and " +
        "the text so far is kept. Try again, tapped twice, starts one new attempt that answers the " +
        "same message.",
      guarantees: ["G2", "G8", "G10"],
    });
    yesterday(s);
    s.begin(TODAY, { cursor: "latest" });
    s.connect();
    s.wait(2000);
    const { turn } = sendAndStart(s, SATURDAY_Q);
    s.wait(300);
    s.status("thinking", "Thinking");
    s.wait(1300);
    s.status("writing", "Writing");
    s.reply();
    s.write(upTo(SATURDAY_A, "café opens at 9."), { every: 110 });
    s.world("engine_stalls");
    s.wait(60000);
    const error: ErrorObject = {
      code: "model_timeout",
      message: "The model didn't respond for 60 seconds.",
      detail: "No progress from Codex for 60 seconds while it was writing; the request to the model was still open.",
    };
    s.endMessage("failed", { error });
    s.endTurn("failed", error);
    s.wait(6000);
    s.retry(turn);
    s.wait(300);
    s.retry(turn);
    s.wait(300);
    s.status("thinking", "Thinking");
    s.wait(1200);
    writeWhole(s, SATURDAY_A, 4);
    s.endTurn("completed");
    return s;
  },
];

mkdirSync(outDir, { recursive: true });
const spec = loadSpec();
for (const build of scenarios) {
  const transcript = build();
  spec.checkLines(transcript.header.name, transcript.allLines);
  writeFileSync(join(outDir, `${transcript.header.name}.jsonl`), transcript.toJsonl());
  console.log(`wrote  ${transcript.header.name}.jsonl`);
}
