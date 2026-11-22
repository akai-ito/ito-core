import type { Recording, Transcript, TranscriptCorrection } from "#protocol/types.ts";
import type { HeardRecording } from "#voice/loop.ts";

// A transcript as it's kept: what the speech model heard, never changed, and the corrections and names laid over it.
// What the app and Kumo read is always the two together.

export type StoredTranscript = {
  readonly heard: HeardRecording;
  readonly corrections: readonly TranscriptCorrection[];
  readonly names: Readonly<Record<string, string>>;
  readonly madeAt: string;
};

// Parakeet, the model the voice runs, hears English.
export const transcriptLanguages: readonly string[] = ["en"];

const escaped = (text: string): string => text.replaceAll(/[$()*+.?[\\\]^{|}]/gu, String.raw`\$&`);

// The words as heard, whole and in any case, so "Myra" doesn't change "Myrage".
const wordsLike = (heard: string): RegExp =>
  new RegExp(String.raw`(?<![\p{L}\p{N}])${escaped(heard.trim())}(?![\p{L}\p{N}])`, "giu");

export const corrected = (text: string, corrections: readonly TranscriptCorrection[]): string =>
  corrections.reduce((current, { heard, meant }) => current.replace(wordsLike(heard), () => meant), text);

const isSameWords = (left: string, right: string): boolean =>
  left.trim().toLocaleLowerCase() === right.trim().toLocaleLowerCase();

// A newer correction of the same words replaces the older one, and correcting words to themselves undoes it.
export const withCorrection = (
  corrections: readonly TranscriptCorrection[],
  next: TranscriptCorrection,
): readonly TranscriptCorrection[] => [
  ...corrections.filter(({ heard }) => !isSameWords(heard, next.heard)),
  ...(next.heard.trim() === next.meant.trim() ? [] : [{ heard: next.heard.trim(), meant: next.meant.trim() }]),
];

export const speakerName = (id: string, names: Readonly<Record<string, string>>): string => {
  const given = names[id];
  if (given !== undefined) return given;
  if (id === "you") return "You";
  return /^S\d+$/u.test(id) ? `Speaker ${id.slice(1)}` : id;
};

export const toTranscript = (recording: Recording, stored: StoredTranscript): Transcript => ({
  attachment: recording.attachment,
  name: recording.name,
  duration_seconds: stored.heard.seconds,
  language: transcriptLanguages[0] ?? "en",
  model: stored.heard.model,
  speakers: stored.heard.speakers.map(({ id, seconds, you }) => ({
    id,
    name: speakerName(id, stored.names),
    seconds,
    you,
  })),
  segments: stored.heard.segments.map((segment) => ({
    ...segment,
    text: corrected(segment.text, stored.corrections),
  })),
  corrections: [...stored.corrections],
  made_at: stored.madeAt,
});

const twoDigits = (value: number): string => String(value).padStart(2, "0");

// 0:04, 12:30 or 1:02:09.
export const clockTime = (seconds: number): string => {
  const whole = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const rest = twoDigits(whole % 60);
  return hours > 0 ? `${String(hours)}:${twoDigits(minutes)}:${rest}` : `${String(minutes)}:${rest}`;
};

// A time Kumo or the app gives, such as "12:30", "1:02:09" or "750", in seconds.
export const toSeconds = (given: string): number | undefined => {
  const parts = given.trim().split(":");
  return parts.length > 3 || parts.some((part) => !/^\d+(?:\.\d+)?$/u.test(part))
    ? undefined
    : parts.reduce((total, part) => total * 60 + Number(part), 0);
};

export type Turn = { readonly start: number; readonly speaker?: string; readonly text: string };

// Pieces in a row from the same voice read as one turn.
export const toTurns = (transcript: Transcript): readonly Turn[] => {
  const names = new Map(transcript.speakers.map(({ id, name }) => [id, name]));
  return transcript.segments.reduce<readonly Turn[]>((turns, segment) => {
    const speaker = segment.speaker === undefined ? undefined : (names.get(segment.speaker) ?? segment.speaker);
    const last = turns.at(-1);
    return last && last.speaker === speaker
      ? [...turns.slice(0, -1), { ...last, text: `${last.text} ${segment.text}` }]
      : [...turns, { start: segment.start, ...(speaker !== undefined && { speaker }), text: segment.text }];
  }, []);
};

export const turnLine = ({ start, speaker, text }: Turn): string =>
  `[${clockTime(start)}] ${speaker === undefined ? "" : `${speaker}: `}${text}`;

export const toText = (transcript: Transcript): string => `${toTurns(transcript).map(turnLine).join("\n")}\n`;
