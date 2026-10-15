import { describe, it } from "vitest";
import { replay } from "./support/replay.ts";
import { transcriptNames } from "./support/transcript-file.ts";

const servedScenarios = 17;

describe("golden transcripts", () => {
  const served = transcriptNames().filter((name) => Number(name.slice(0, 2)) <= servedScenarios);
  it.each(served)("%s replays through the server", async (name) => {
    await replay(name);
  });
});
