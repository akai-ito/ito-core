import type { Voice } from "#protocol/types.ts";
import type { Settings } from "#store/store.ts";

export const defaultVoice = "af_heart";

export const voices: readonly Voice[] = [
  { id: "af_heart", name: "Heart", accent: "american" },
  { id: "af_alloy", name: "Alloy", accent: "american" },
  { id: "af_aoede", name: "Aoede", accent: "american" },
  { id: "af_bella", name: "Bella", accent: "american" },
  { id: "af_jessica", name: "Jessica", accent: "american" },
  { id: "af_kore", name: "Kore", accent: "american" },
  { id: "af_nicole", name: "Nicole", accent: "american" },
  { id: "af_nova", name: "Nova", accent: "american" },
  { id: "af_river", name: "River", accent: "american" },
  { id: "af_sarah", name: "Sarah", accent: "american" },
  { id: "af_sky", name: "Sky", accent: "american" },
  { id: "am_adam", name: "Adam", accent: "american" },
  { id: "am_echo", name: "Echo", accent: "american" },
  { id: "am_eric", name: "Eric", accent: "american" },
  { id: "am_fenrir", name: "Fenrir", accent: "american" },
  { id: "am_liam", name: "Liam", accent: "american" },
  { id: "am_michael", name: "Michael", accent: "american" },
  { id: "am_onyx", name: "Onyx", accent: "american" },
  { id: "am_puck", name: "Puck", accent: "american" },
  { id: "am_santa", name: "Santa", accent: "american" },
  { id: "bf_emma", name: "Emma", accent: "british" },
  { id: "bf_isabella", name: "Isabella", accent: "british" },
  { id: "bm_george", name: "George", accent: "british" },
  { id: "bm_lewis", name: "Lewis", accent: "british" },
  { id: "bf_alice", name: "Alice", accent: "british" },
  { id: "bf_lily", name: "Lily", accent: "british" },
  { id: "bm_daniel", name: "Daniel", accent: "british" },
  { id: "bm_fable", name: "Fable", accent: "british" },
];

export const voiceSetting = "voice_choice";

export const isKnownVoice = (voice: string): boolean => voices.some(({ id }) => id === voice);

export const unknownVoice = (voice: string): string =>
  `There's no voice called ${voice}: choose one from GET /v0/voices.`;

export const chosenVoice = (settings: Settings): string => {
  const chosen = settings.setting(voiceSetting);
  return chosen !== undefined && isKnownVoice(chosen) ? chosen : defaultVoice;
};
