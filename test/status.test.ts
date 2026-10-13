import { describe, expect, it } from "vitest";
import { toStatus } from "#conversation/status.ts";

const codePointsIn = (text: string): number => text.match(/./gsu)?.length ?? 0;

describe("status details", () => {
  it("collapse whitespace and drop an empty detail", () => {
    expect(toStatus({ kind: "web_search", query: "  riverside cafés\n open at 9 " })).toEqual({
      kind: "working",
      label: "Searching the web",
      detail: "riverside cafés open at 9",
    });
    expect(toStatus({ kind: "thinking", heading: " \n " })).toEqual({ kind: "thinking", label: "Thinking" });
  });

  it("stay within the schema's 200 characters, cut between whole characters", () => {
    const query = `${"word ".repeat(39)}👩‍👩‍👧 ${"more ".repeat(20)}`;
    const { detail = "" } = toStatus({ kind: "web_search", query });
    expect(codePointsIn(detail)).toBeLessThanOrEqual(200);
    expect(detail.endsWith("…")).toBe(true);
    expect(detail.isWellFormed()).toBe(true);
    expect(query.startsWith(detail.slice(0, -1))).toBe(true);
  });
});
