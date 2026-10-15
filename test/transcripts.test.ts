import { describe, it } from "vitest";
import { replay } from "./support/replay.ts";
import { transcriptNames } from "./support/transcript-file.ts";

const unservedScenarios: ReadonlySet<number> = new Set([27, 28, 29, 30, 31]);

describe("golden transcripts", () => {
  const served = transcriptNames().filter((name) => !unservedScenarios.has(Number(name.slice(0, 2))));
  it.each(served)("%s replays through the server", async (name) => {
    await replay(name);
  });
});
