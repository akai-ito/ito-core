import type { Clock } from "#clock.ts";
import type { VoiceState } from "#protocol/types.ts";
import { fail, type Result } from "#result.ts";
import type { Info, Log } from "#turns/turns.ts";

export type Readiness = { readonly state: VoiceState; readonly reason?: string };

export type SpeechFailure = { readonly code: "unavailable" | "failed"; readonly detail: string };

export type Voiceprint = { readonly vector: readonly number[]; readonly threshold: number };

export type Heard =
  | { readonly kind: "hearing" }
  | { readonly kind: "heard"; readonly text: string }
  | { readonly kind: "turn"; readonly text: string; readonly pcm: Uint8Array }
  | { readonly kind: "barge" }
  | { readonly kind: "dropped" }
  | { readonly kind: "voiceprint"; readonly voiceprint: Voiceprint }
  | { readonly kind: "problem"; readonly reason: string };

// A whole recording, as the voice heard it: pieces with their times in seconds and, where it could tell voices
// apart, who said each (S1, S2… or "you", for the voice that matches their voiceprint).
export type HeardSegment = {
  readonly start: number;
  readonly end: number;
  readonly text: string;
  readonly speaker?: string;
};

export type HeardSpeaker = { readonly id: string; readonly seconds: number; readonly you: boolean };

export type HeardRecording = {
  readonly seconds: number;
  readonly segments: readonly HeardSegment[];
  readonly speakers: readonly HeardSpeaker[];
  readonly model: string;
};

// Why a recording wasn't transcribed: the voice isn't there now, so it waits; the file can't be read; it was
// cancelled; or something else went wrong.
export type TranscriptionFailure = {
  readonly code: "unavailable" | "unreadable" | "cancelled" | "failed";
  readonly detail: string;
};

export type Progress = (doneSeconds: number, totalSeconds: number | undefined) => void;

export type Listening = {
  readonly hear: (pcm: Uint8Array) => void;
  readonly saying: (text: string | undefined) => void;
  readonly flush: () => Promise<void>;
  readonly stop: () => Promise<void>;
};

export type VoiceLoop = {
  readonly readiness: () => Readiness;
  readonly speak: (text: string, voice: string) => Promise<Result<Uint8Array, SpeechFailure>>;
  readonly listen: (
    session: string,
    voiceprint: Voiceprint | undefined,
    onHeard: (heard: Heard) => void,
  ) => Promise<Result<Listening, string>>;
  readonly refreshVocabulary: () => Promise<void>;
  readonly forgetVoiceprint: () => Promise<void>;
  readonly transcribe: (
    job: string,
    file: string,
    voiceprint: Voiceprint | undefined,
    onProgress: Progress,
  ) => Promise<Result<HeardRecording, TranscriptionFailure>>;
  readonly cancelTranscription: (job: string) => Promise<void>;
  readonly close: () => Promise<void>;
};

export const heardRate = 16_000;

export const spokenRate = 24_000;

export type VoiceContext = {
  readonly onReadiness: (readiness: Readiness) => void;
  readonly vocabulary: () => Promise<readonly string[]>;
  readonly clock: Clock;
  readonly info: Info;
  readonly log: Log;
};

export const toWav = (pcm: Uint8Array, rate: number): Uint8Array => {
  const bytes = new Uint8Array(44 + pcm.length);
  const view = new DataView(bytes.buffer);
  const text = (offset: number, value: string): void => {
    bytes.set(new TextEncoder().encode(value), offset);
  };
  text(0, "RIFF");
  view.setUint32(4, 36 + pcm.length, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, pcm.length, true);
  bytes.set(pcm, 44);
  return bytes;
};

export const noVoice = (reason: string): VoiceLoop => ({
  readiness: () => ({ state: "failed", reason }),
  speak: () => Promise.resolve(fail({ code: "unavailable", detail: reason })),
  listen: () => Promise.resolve(fail(reason)),
  refreshVocabulary: () => Promise.resolve(),
  forgetVoiceprint: () => Promise.resolve(),
  transcribe: () => Promise.resolve(fail({ code: "unavailable", detail: reason })),
  cancelTranscription: () => Promise.resolve(),
  close: () => Promise.resolve(),
});
