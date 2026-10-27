import type { Clock } from "#clock.ts";
import type { VoiceState } from "#protocol/types.ts";
import { fail, type Result } from "#result.ts";
import type { Info, Log } from "#turns/turns.ts";

export type Readiness = { readonly state: VoiceState; readonly reason?: string };

export type SpeechFailure = { readonly code: "unavailable" | "failed"; readonly detail: string };

export type VoiceLoop = {
  readonly readiness: () => Readiness;
  readonly speak: (text: string, voice: string) => Promise<Result<Uint8Array, SpeechFailure>>;
  readonly refreshVocabulary: () => Promise<void>;
  readonly close: () => Promise<void>;
};

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
  refreshVocabulary: () => Promise.resolve(),
  close: () => Promise.resolve(),
});
