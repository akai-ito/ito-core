import { describe, it } from "vitest";
import { replay } from "./support/replay.ts";
import { transcriptNames } from "./support/transcript-file.ts";

const unbuiltScenarios: ReadonlySet<number> = new Set([32, 33]);

describe("golden transcripts", () => {
  const served = transcriptNames().filter((name) => !unbuiltScenarios.has(Number(name.slice(0, 2))));
  it.each(served)("%s replays through the server", async (name) => {
    await replay(name);
  });
});
