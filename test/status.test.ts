import { describe, expect, it } from "vitest";
import { toStepStatus } from "#conversation/status.ts";

const codePointsIn = (text: string): number => text.match(/./gsu)?.length ?? 0;

describe("status details", () => {
  it("collapse whitespace and drop an empty detail", () => {
    expect(toStepStatus("thinking", "Thinking it through", "  Fitting the day\n around the run ")).toEqual({
      kind: "thinking",
      label: "Thinking it through",
      detail: "Fitting the day around the run",
    });
    expect(toStepStatus("thinking", "Thinking it through", " \n ")).toEqual({
      kind: "thinking",
      label: "Thinking it through",
    });
    expect(toStepStatus("web_search", "Searching the web for cafés", "ignored")).toEqual({
      kind: "working",
      label: "Searching the web for cafés",
    });
  });

  it("stay within the schema's 200 characters, cut between whole characters", () => {
    const heading = `${"word ".repeat(39)}👩‍👩‍👧 ${"more ".repeat(20)}`;
    const { detail = "" } = toStepStatus("thinking", "Thinking it through", heading);
    expect(codePointsIn(detail)).toBeLessThanOrEqual(200);
    expect(detail.endsWith("…")).toBe(true);
    expect(detail.isWellFormed()).toBe(true);
    expect(heading.startsWith(detail.slice(0, -1))).toBe(true);
  });
});
