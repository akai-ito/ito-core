import { describe, expect, it } from "vitest";
import { stepOf, type StepLookups } from "#dream/steps.ts";

const lookups: StepLookups = {
  pageTitle: (address) => (address === "memory:people/leo" ? "Leo" : undefined),
  threadTitle: (id) => (id === "t_1" ? "Thursday's demo" : undefined),
  wakeUpTitle: (id) => (id === "w_1" ? "Ask how the legs feel" : undefined),
  eventTitle: (uid) => (uid === "block-run" ? "Easy run" : undefined),
  dayName: (day) => (day === "2026-11-23" ? "Monday" : day),
};

describe("a dream's steps", () => {
  it("say what Kumo is doing from the tool it calls, in the group it belongs to", () => {
    expect(stepOf("edit_page", { address: "memory:people/leo" }, lookups)).toEqual({
      group: "tidying",
      text: "Tidying Leo",
    });
    expect(stepOf("forget_page", { address: "memory:topics/old-bike-notes" }, lookups)).toEqual({
      group: "tidying",
      text: "Folding away old bike notes",
    });
    expect(stepOf("journal", { day: "2026-11-23", text: "…" }, lookups)).toEqual({
      group: "journal",
      text: "Writing Monday's journal",
    });
    expect(stepOf("move_wake_up", { id: "w_1", at: "2026-11-24T09:00:00Z" }, lookups)).toEqual({
      group: "planning",
      text: "Moving “Ask how the legs feel”",
    });
    expect(stepOf("change_event", { uid: "block-run" }, lookups)).toEqual({
      group: "planning",
      text: "Moving Easy run",
    });
    expect(stepOf("read_thread", { thread: "t_1" }, lookups)).toEqual({
      group: "gathering",
      text: "Rereading “Thursday's demo”",
    });
  });

  it("have none for a call with nothing to show, such as the record", () => {
    expect(stepOf("record_dream", { lines: [] }, lookups)).toBeUndefined();
    expect(stepOf("post", { text: "Morning" }, lookups)).toBeUndefined();
  });
});
