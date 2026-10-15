import { describe, it } from "vitest";
import { replay } from "./support/replay.ts";
import { transcriptNames } from "./support/transcript-file.ts";

describe("golden transcripts", () => {
  it.each(transcriptNames())("%s replays through the server", async (name) => {
    await replay(name);
  });
});
