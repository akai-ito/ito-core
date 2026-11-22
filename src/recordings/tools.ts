import type { Recording, Transcript } from "#protocol/types.ts";
import type { Recordings } from "#recordings/recordings.ts";
import { clockTime, toSeconds, toTurns, turnLine, type Turn } from "#recordings/transcripts.ts";
import { textOf } from "#tools/input.ts";
import type { Tool, ToolResult } from "#tools/mcp.ts";

// Kumo's hands on the recordings: reading a transcript a page at a time or for a topic, correcting what it misheard,
// and deleting one when they ask.

// About ten thousand words a page, which an hour's interview takes a few of.
const pageCharacters = 40_000;
const mostFound = 40;

const failed = (text: string): ToolResult => ({ text, isError: true });

const minutes = (seconds: number): string =>
  seconds < 90 ? `${String(Math.round(seconds))} seconds` : `${String(Math.round(seconds / 60))} minutes`;

// Where a recording stands, as a sentence that follows its name.
const standing = (recording: Recording): string => {
  switch (recording.state) {
    case "queued": {
      return `waiting to be transcribed.${recording.reason === undefined ? "" : ` ${recording.reason}`}`;
    }
    case "transcribing": {
      const { done_seconds: done, total_seconds: total } = recording.progress ?? { done_seconds: 0 };
      const so = total === undefined ? minutes(done) : `${minutes(done)} of ${minutes(total)}`;
      return `being transcribed, ${so} so far. You'll be told when it's ready.`;
    }
    case "ready": {
      const voices = recording.speakers ?? 0;
      return `transcribed: ${minutes(recording.duration_seconds ?? 0)}, ${voices === 1 ? "one voice" : `${String(voices)} voices`}.`;
    }
    case "failed": {
      return `couldn't be transcribed: ${recording.error?.detail ?? recording.error?.message ?? "it failed."}`;
    }
    case "deleted": {
      return "deleted.";
    }
  }
};

const header = (transcript: Transcript): string => {
  const voices = transcript.speakers
    .map(
      ({ id, name, seconds, you }) => `${name} (${id}${you ? ", matched their voiceprint" : ""}, ${minutes(seconds)})`,
    )
    .join(", ");
  return [
    `${transcript.name} (${transcript.attachment}), ${clockTime(transcript.duration_seconds)} long.`,
    voices === ""
      ? "The voices couldn't be told apart."
      : `Voices, told apart by how they sound, a best guess: ${voices}.`,
    ...(transcript.corrections.length > 0
      ? [`Corrected: ${transcript.corrections.map(({ heard, meant }) => `"${heard}" to "${meant}"`).join(", ")}.`]
      : []),
    "What follows is what the speech model heard, not a summary: quote it with its times for what was said, and keep",
    "your reading of it separate and marked as yours. Propose actions and memory updates for them to choose; don't",
    "make any from it until they say.",
    "",
  ].join("\n");
};

// A page of turns from the one under a time on, cut between turns so none is split.
const page = (turns: readonly Turn[], from: number): { readonly lines: readonly string[]; readonly next?: Turn } => {
  const rest = turns.slice(
    Math.max(
      0,
      turns.findLastIndex((turn) => turn.start <= from),
    ),
  );
  const taken = rest.reduce<{ readonly lines: readonly string[]; readonly size: number; readonly isFull: boolean }>(
    (sofar, turn) => {
      if (sofar.isFull) return sofar;
      const line = turnLine(turn);
      return sofar.size + line.length > pageCharacters && sofar.lines.length > 0
        ? { ...sofar, isFull: true }
        : { lines: [...sofar.lines, line], size: sofar.size + line.length + 1, isFull: false };
    },
    { lines: [], size: 0, isFull: false },
  );
  const next = rest[taken.lines.length];
  return { lines: taken.lines, ...(next && { next }) };
};

const listText = (recordings: readonly Recording[]): string =>
  recordings.length === 0
    ? "They haven't sent a recording."
    : [
        "Recordings they sent, newest first:",
        ...recordings
          .slice(0, 10)
          .map((recording) => `- ${recording.name} (${recording.attachment}) is ${standing(recording)}`),
      ].join("\n");

export const createRecordingTools = (recordings: Recordings): readonly Tool[] => [
  {
    name: "read_recording",
    title: "Read a recording's transcript",
    description:
      "Read the transcript of a recording they sent, such as an interview or a meeting: what was said, with times " +
      "and who said it. The server transcribes every recording they send; this is how you hear it, since you can't " +
      "listen to audio. Without an attachment, it lists their recordings and where each stands. A long one comes a " +
      "page at a time: give from to read on, or find to see only the turns that mention something.",
    inputSchema: {
      type: "object",
      properties: {
        attachment: { type: "string", description: "The recording's attachment id, such as f_…." },
        from: { type: "string", description: "Where to start, as a time in the recording, such as 23:40." },
        find: { type: "string", description: "Words to look for; only the turns that have them come back." },
      },
      additionalProperties: false,
    },
    call: (input) => {
      const attachment = textOf(input, "attachment").trim();
      if (attachment === "") return Promise.resolve({ text: listText(recordings.list()) });
      const read = recordings.transcript(attachment);
      if (!read.ok) {
        return Promise.resolve(
          read.failure.code === "not_transcribed"
            ? { text: `${read.failure.recording.name} is ${standing(read.failure.recording)}` }
            : failed(`There's no recording ${attachment}: read_recording without an attachment lists them.`),
        );
      }
      recordings.markRead(attachment);
      const transcript = read.value;
      const turns = toTurns(transcript);
      const sought = textOf(input, "find").trim().toLocaleLowerCase();
      if (sought !== "") {
        const found = turns.filter(({ text }) => text.toLocaleLowerCase().includes(sought));
        return Promise.resolve({
          text:
            header(transcript) +
            (found.length === 0
              ? `No turn mentions "${sought}".`
              : [
                  `${String(found.length)} turns mention "${sought}"${found.length > mostFound ? `; the first ${String(mostFound)}` : ""}:`,
                  ...found.slice(0, mostFound).map(turnLine),
                ].join("\n")),
        });
      }
      const given = textOf(input, "from").trim();
      const from = given === "" ? 0 : toSeconds(given);
      if (from === undefined) return Promise.resolve(failed(`${given} isn't a time: give one such as 23:40.`));
      const { lines, next } = page(turns, from);
      return Promise.resolve({
        text:
          header(transcript) +
          lines.join("\n") +
          (next ? `\n\n(It goes on: read on with from "${clockTime(next.start)}".)` : "\n\n(That's the end.)"),
      });
    },
  },
  {
    name: "correct_transcript",
    title: "Correct a recording's transcript",
    description:
      "Correct what a transcript misheard, such as a name or a term, everywhere it appears, or name a voice, such " +
      "as S1 as Interviewer, when they tell you. The words as heard are kept underneath.",
    inputSchema: {
      type: "object",
      properties: {
        attachment: { type: "string", description: "The recording's attachment id." },
        heard: { type: "string", description: "The words as the transcript has them." },
        meant: { type: "string", description: "What was really said." },
        speaker: { type: "string", description: "A voice's id, such as S1." },
        name: { type: "string", description: "What to call that voice." },
      },
      required: ["attachment"],
      additionalProperties: false,
    },
    call: (input) => {
      const attachment = textOf(input, "attachment").trim();
      const heard = textOf(input, "heard").trim();
      const meant = textOf(input, "meant").trim();
      const speaker = textOf(input, "speaker").trim();
      const name = textOf(input, "name").trim();
      const replace = heard === "" || meant === "" ? [] : [{ heard, meant }];
      const speakers = speaker === "" || name === "" ? [] : [{ id: speaker, name }];
      if (replace.length === 0 && speakers.length === 0) {
        return Promise.resolve(failed("Give heard and meant to correct words, or speaker and name to name a voice."));
      }
      const corrected = recordings.correct(attachment, { replace, speakers });
      if (corrected.ok) {
        const done = [
          ...replace.map(() => `"${heard}" now reads "${meant}"`),
          ...speakers.map(() => `${speaker} is now ${name}`),
        ];
        return Promise.resolve({ text: `Corrected: ${done.join("; ")}.` });
      }
      switch (corrected.failure.code) {
        case "not_found": {
          return Promise.resolve(failed(`There's no recording ${attachment}.`));
        }
        case "not_transcribed": {
          return Promise.resolve(failed(`It isn't transcribed: it's ${standing(corrected.failure.recording)}`));
        }
        case "unknown_speaker": {
          return Promise.resolve(failed(`There's no voice ${corrected.failure.speaker} in it.`));
        }
      }
    },
  },
  {
    name: "delete_recording",
    title: "Delete a recording",
    description:
      "Delete a recording's audio and transcript from the server, only when they ask. What you wrote from it stays, " +
      "so offer to change what you remember from it too.",
    inputSchema: {
      type: "object",
      properties: { attachment: { type: "string", description: "The recording's attachment id." } },
      required: ["attachment"],
      additionalProperties: false,
    },
    call: async (input) => {
      const attachment = textOf(input, "attachment").trim();
      const removed = await recordings.remove(attachment);
      return removed.ok
        ? { text: `Deleted ${removed.value.name}: its audio and transcript are gone from the server.` }
        : failed(`There's no recording ${attachment}.`);
    },
  },
];
