import { describe, it } from "vitest";
import { replay } from "./support/replay.ts";
import { transcriptNames } from "./support/transcript-file.ts";

const pending: ReadonlySet<string> = new Set(["69-getting-started"]);

describe("golden transcripts", () => {
  it.each(transcriptNames().filter((name) => !pending.has(name)))("%s replays through the server", async (name) => {
    await replay(name);
  });
  for (const name of pending) it.todo(`${name} replays through the server, once the server does it`);
});
