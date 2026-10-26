import { defaultVoice, isKnownVoice, voices } from "#speech/voices.ts";
import { unknownVoice, type Speech } from "#speech/speech.ts";
import { fail, ok } from "#result.ts";

export const createCannedSpeech = (wav: Uint8Array, isReady: () => boolean): Speech => ({
  voices,
  defaultVoice,
  warm: () => Promise.resolve(),
  speak: (_text, voice = defaultVoice) => {
    if (!isKnownVoice(voice)) return Promise.resolve(fail(unknownVoice(voice)));
    return Promise.resolve(isReady() ? ok(wav) : fail({ code: "loading", detail: "Ari's voice is still loading." }));
  },
});
