import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { systemClock } from "#clock.ts";
import { toMessageId, toTurnId } from "#conversation/ids.ts";
import { randomIdentifiers } from "#identifiers.ts";
import { openDatabase } from "#store/database.ts";
import { createStore } from "#store/store.ts";
import { createTopicTool } from "#topics/tool.ts";

const home = mkdtempSync(path.join(os.tmpdir(), "ito-topics-"));

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("topics", () => {
  it("marks one topic a turn, on the message that changed the subject, with a short label", async () => {
    const store = createStore(openDatabase(path.join(home, "ito.db")), systemClock, randomIdentifiers);
    const tool = createTopicTool(store);
    const idle = await tool.call({ label: "Florence trip" });
    const accepted = store.acceptMessage(toMessageId("m_florence"), "Can you help me plan Florence?");
    store.startTurn(toTurnId("t_florence"), [toMessageId("m_florence")]);

    const wordy = await tool.call({ label: "Our trip to Florence in November" });
    const marked = await tool.call({ label: " Florence   trip " });
    const again = await tool.call({ label: "Siena" });

    expect(idle).toEqual({ text: "Topics are marked while you answer a message.", isError: true });
    expect(wordy).toEqual({ text: "A topic's label is one to four words, such as Florence trip.", isError: true });
    expect(marked).toEqual({ text: "Marked the topic Florence trip." });
    expect(again).toEqual({ text: "This turn's topic is already Florence trip.", isError: true });
    expect(store.snapshot("no_cursor").event.topics).toMatchObject([
      { label: "Florence trip", position: accepted.ok ? accepted.value.message.position : -1 },
    ]);
  });
});
