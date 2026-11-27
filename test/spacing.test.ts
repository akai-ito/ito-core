import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { randomIdentifiers } from "#identifiers.ts";
import { wordEmbedder } from "#memory/embedder.ts";
import { createMemory } from "#memory/memory.ts";
import { wordsIn } from "#memory/pages.ts";
import { openDatabase } from "#store/database.ts";
import { createMemoryStore } from "#store/memory.ts";
import { createStore } from "#store/store.ts";
import { gluedIn, missingSpaces } from "#tools/spacing.ts";
import { createVirtualClock } from "./support/virtual-clock.ts";

const home = mkdtempSync(path.join(os.tmpdir(), "ito-spacing-"));

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

const openMemory = async () => {
  const directory = mkdtempSync(path.join(home, "home-"));
  const database = openDatabase(path.join(directory, "ito.db"));
  const clock = createVirtualClock(Date.parse("2026-11-27T09:00:00.000Z"));
  const memory = createMemory({
    directory: path.join(directory, "thread"),
    store: createMemoryStore(database),
    settings: createStore(database, clock, randomIdentifiers),
    clock,
    identifiers: randomIdentifiers,
    embedder: wordEmbedder,
    recordStep: () => true,
    approve: () => Promise.resolve(true),
    info: () => true,
    timeZone: () => "Europe/London",
  });
  await memory.ready;
  const call = (name: string, input: unknown) => {
    const tool = memory.tools.find((candidate) => candidate.name === name);
    if (!tool) throw new Error(`No tool ${name}.`);
    return tool.call(input);
  };
  return { memory, call, directory };
};

describe("spaces next to numbers", () => {
  it("finds the ones Kumo squeezed out", () => {
    expect(gluedIn("Mira's flat viewing (as of4 Dec10:30 GMT).")).toEqual(["of4", "Dec10:30"]);
    expect(gluedIn("10K PB41:12; working sets squat,60kg and rows,band pull-aparts.")).toEqual([
      "PB41:12",
      "squat,60kg",
      "rows,band",
    ]);
    expect(gluedIn("Only a week to go until9January.")).toEqual(["until9", "9January"]);
    expect(gluedIn("Booked9Jan14:00–15:00 at Quillfield Dental")).toEqual(["9Jan"]);
    expect(gluedIn("Leo slept 6h10;12 Jan was better, a quiet evening,no screens")).toEqual(["6h10;12", "evening,no"]);
  });

  it("leaves text alone when its spaces are there, whichever spaces they are, and code and links as written", () => {
    expect(
      gluedIn(
        "As of 4 Dec, PB 41:12, squat, 60 kg, until 9 January; 14:00–15:00 GMT. 1,000 runners, 7h05 asleep, " +
          "sub-50 10K, Pixel 9, version 0.171, Halcyon’s offer.",
      ),
    ).toEqual([]);
    expect(gluedIn("As of\u{202F}4 Dec, PB\u{A0}41:12, 60\u{2009}kg")).toEqual([]);
    expect(
      gluedIn(
        "Run `npm ci --omit=dev,quiet` and see [the map](https://example.com/?q=Soho,W1) or memory:journal/2026-12-04.",
      ),
    ).toEqual([]);
  });

  it("counts squeezed text as the words it should be, so dropping spaces never makes a page shorter", () => {
    expect(wordsIn("As of4 Dec, squat,60kg")).toBe(wordsIn("As of 4 Dec, squat, 60 kg"));
    expect(wordsIn("You're keeping the sub-50 target (as of 2 Dec).")).toBe(10);
  });

  it("says what's missing, and what to do", () => {
    expect(missingSpaces(["As of 4 Dec", "Until 9 January"])).toBeUndefined();
    expect(missingSpaces(["As of4 Dec", "Until9January"])).toBe(
      "Not saved: spaces are missing next to numbers in “of4”, “9January”. Write it again with a space on " +
        "each side, as in “as of 4 Dec” and “squat, 60 kg”: nothing has a length cap, so never drop spaces to " +
        "make text fit. Anything meant exactly as written goes in backticks.",
    );
  });

  it("keeps squeezed text out of memory, where Kumo would read it and copy it", async () => {
    const { call, directory } = await openMemory();

    const glued = await call("write_page", {
      address: "memory:goals/strength",
      gist: "Squatting twice a week",
      note: "Training",
      body: "10K PB41:12; squat,60kg (as of2 Dec).",
    });
    const spaced = await call("write_page", {
      address: "memory:goals/strength",
      gist: "Squatting twice a week",
      note: "Training",
      body: "10K PB 41:12; squat, 60 kg (as of 2 Dec).",
    });
    const journal = await call("journal", {
      text: "Easy run, a week until9January.",
      gist: "An easy run",
      note: "Run",
    });

    expect(glued.isError).toBe(true);
    expect(glued.text).toMatch(/^Not saved: spaces are missing next to numbers in “PB41:12”, “of2”, “squat,60kg”\./u);
    expect(spaced.isError).toBeUndefined();
    expect(readFileSync(path.join(directory, "thread", "goals", "strength.md"), "utf8")).toContain(
      "10K PB 41:12; squat, 60 kg (as of 2 Dec).",
    );
    expect(journal.isError).toBe(true);
  });
});
