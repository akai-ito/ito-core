import { describe, expect, it } from "vitest";
import { toStepTitle } from "#conversation/steps.ts";
import type { StepFacts } from "#engine/engine.ts";
import type { StepKind } from "#protocol/types.ts";

const both = (kind: StepKind, facts: StepFacts): readonly string[] => [
  toStepTitle(kind, facts, "present"),
  toStepTitle(kind, facts, "past"),
];

describe("step titles", () => {
  it("name common commands in everyday words", () => {
    expect(both("command", { command: "sleep 10" })).toEqual(["Waiting 10 seconds", "Waited 10 seconds"]);
    expect(both("command", { command: "curl -s https://example.com" })).toEqual([
      "Fetching a web page",
      "Fetched a web page",
    ]);
    expect(both("command", { command: "git log --oneline -5" })).toEqual([
      "Looking at the project's history",
      "Looked at the project's history",
    ]);
    expect(both("command", { command: "CI=1 npm install" })).toEqual(["Installing packages", "Installed packages"]);
    expect(both("command", { command: "./do-something.sh" })).toEqual(["Running a command", "Ran a command"]);
  });

  it("take what a command read, searched or listed from its actions", () => {
    expect(both("command", { actions: [{ type: "read", path: "notes/saturday.md" }] })).toEqual([
      "Reading saturday.md",
      "Read saturday.md",
    ]);
    const reads = [
      { type: "read", path: "a.md" },
      { type: "read", path: "b.md" },
      { type: "read", path: "c.md" },
    ] as const;
    expect(both("command", { actions: [...reads] })).toEqual(["Reading 3 files", "Read 3 files"]);
    expect(both("command", { actions: [{ type: "search", query: "cafe" }] })).toEqual([
      "Searching for “cafe”",
      "Searched for “cafe”",
    ]);
    expect(both("command", { actions: [{ type: "list", path: "notes/" }] })).toEqual([
      "Looking through notes",
      "Looked through notes",
    ]);
  });

  it("describe file changes, searches, waits and plans", () => {
    expect(both("file_change", { files: [{ path: "src/plan.md", change: "added" }] })).toEqual([
      "Creating plan.md",
      "Created plan.md",
    ]);
    const files = [
      { path: "a.md", change: "modified" },
      { path: "b.md", change: "deleted" },
    ] as const;
    expect(both("file_change", { files: [...files] })).toEqual(["Editing 2 files", "Edited 2 files"]);
    expect(both("web_search", { url: "https://www.bbc.co.uk/news", pattern: "opening hours" })).toEqual([
      "Looking for “opening hours” on bbc.co.uk",
      "Looked for “opening hours” on bbc.co.uk",
    ]);
    expect(both("web_search", { url: "https://example.com/page" })).toEqual([
      "Opening example.com",
      "Opened example.com",
    ]);
    expect(both("web_search", { query: "cafés near Battersea Park open at 9" })).toEqual([
      "Searching the web for cafés near Battersea Park open at 9",
      "Searched the web for cafés near Battersea Park open at 9",
    ]);
    expect(both("wait", { wait_ms: 1000 })).toEqual(["Waiting 1 second", "Waited 1 second"]);
    expect(both("plan", { items: [{ text: "Book", state: "pending" }] })).toEqual([
      "Planning 1 step",
      "Planned 1 step",
    ]);
  });

  it("keep web search titles short and plain", () => {
    const queries = [
      "site:nationaltrail.co.uk Thames Path London Richmond Hampton Court Greenwich",
      "Thames Path walking guide",
    ];
    expect(
      both("web_search", {
        query: `site:nationaltrail.co.uk Thames Path London Richmond Hampton Court Greenwich ...`,
        queries,
      }),
    ).toEqual([
      "Searching nationaltrail.co.uk for Thames Path London Richmond Hampton Court Greenwich",
      "Searched nationaltrail.co.uk for Thames Path London Richmond Hampton Court Greenwich",
    ]);
    expect(both("web_search", { query: 'site:www.parkrun.org.uk "Battersea" start time OR "start times"' })).toEqual([
      "Searching parkrun.org.uk for Battersea start time start times",
      "Searched parkrun.org.uk for Battersea start time start times",
    ]);
    expect(both("web_search", { query: "site:a.com OR site:b.com opening hours -reddit" })).toEqual([
      "Searching the web for opening hours",
      "Searched the web for opening hours",
    ]);
    expect(
      toStepTitle(
        "web_search",
        { query: "best quiet cafés with good coffee and space to work near the river in south west London" },
        "present",
      ),
    ).toBe("Searching the web for best quiet cafés with good coffee and space to work near the…");
    expect(both("web_search", { query: "site:nationaltrail.co.uk" })).toEqual([
      "Searching nationaltrail.co.uk",
      "Searched nationaltrail.co.uk",
    ]);
  });

  it("name Ito's own report tool plainly, by what it did", () => {
    const report = { capability: "ito", operation: "report_gap" };
    expect(toStepTitle("tool", report, "present")).toBe("Reporting it to Ito");
    expect(toStepTitle("tool", { ...report, url: "https://github.com/akai-ito/ito-core/issues/7" }, "past")).toBe(
      "Reported it to Ito",
    );
    expect(
      toStepTitle("tool", { ...report, url: "https://github.com/akai-ito/ito-core/issues/7#issuecomment-1" }, "past"),
    ).toBe("Added to an Ito issue");
    expect(both("tool", { capability: "weather", operation: "forecast" })).toEqual(["Using weather", "Used weather"]);
  });
});
