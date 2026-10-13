import { readdirSync } from "node:fs";
import path from "node:path";
import { protocolDirectory } from "#protocol/schemas.ts";

export const transcriptDirectory = path.join(protocolDirectory, "transcripts");

export const byCodeUnits = (left: unknown, right: unknown): number => {
  const leftText = String(left);
  const rightText = String(right);
  return leftText < rightText ? -1 : leftText > rightText ? 1 : 0;
};

export const listTranscriptFiles = (): readonly string[] =>
  readdirSync(transcriptDirectory)
    .filter((file) => file.endsWith(".jsonl"))
    .toSorted(byCodeUnits);
