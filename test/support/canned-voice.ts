import { fail, ok } from "#result.ts";
import type { Readiness, VoiceLoop } from "#voice/loop.ts";

export const createCannedVoice = (wav: Uint8Array, readiness: () => Readiness): VoiceLoop => ({
  readiness,
  speak: () => {
    const { state, reason = "" } = readiness();
    return Promise.resolve(state === "ready" ? ok(wav) : fail({ code: "unavailable", detail: reason }));
  },
  refreshVocabulary: () => Promise.resolve(),
  close: () => Promise.resolve(),
});
