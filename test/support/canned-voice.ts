import { fail, ok } from "#result.ts";
import type { Readiness, VoiceLoop } from "#voice/loop.ts";

export const createCannedVoice = (pcm: Uint8Array, readiness: () => Readiness): VoiceLoop => ({
  readiness,
  speak: () => {
    const { state, reason = "" } = readiness();
    return Promise.resolve(state === "ready" ? ok(pcm) : fail({ code: "unavailable", detail: reason }));
  },
  listen: () => Promise.resolve(fail("The canned voice doesn't listen.")),
  refreshVocabulary: () => Promise.resolve(),
  close: () => Promise.resolve(),
});
