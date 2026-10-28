import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { VoiceprintState } from "#protocol/types.ts";
import type { Voiceprint } from "#voice/loop.ts";

export type Voiceprints = {
  readonly load: () => Voiceprint | undefined;
  readonly save: (voiceprint: Voiceprint) => void;
  readonly forget: () => void;
  readonly state: () => VoiceprintState;
};

export const createVoiceprints = (file: string): Voiceprints => ({
  load: () => (existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Voiceprint) : undefined),
  save: (voiceprint) => {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(voiceprint));
  },
  forget: () => {
    rmSync(file, { force: true });
  },
  state: () => (existsSync(file) ? "learnt" : "learning"),
});
