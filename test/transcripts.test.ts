import { describe, it } from "vitest";
import { replay } from "./support/replay.ts";
import { transcriptNames } from "./support/transcript-file.ts";

const pushingScenarios: ReadonlySet<number> = new Set([18, 21, 24, 26]);

describe("golden transcripts", () => {
  const served = transcriptNames().filter((name) => !pushingScenarios.has(Number(name.slice(0, 2))));
  it.each(served)("%s replays through the server", async (name) => {
    await replay(name);
  });
});
