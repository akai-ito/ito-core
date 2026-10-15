import { describe, expect, it } from "vitest";
import { toAskFields } from "#asks/tool.ts";

describe("the ask tool's input", () => {
  it("takes a question with options, allowing a typed answer unless told otherwise", () => {
    expect(
      toAskFields({ question: " Which Juno? ", options: [{ label: "Clapham", acts: true }, { label: "Soho" }] }),
    ).toEqual({
      ok: true,
      value: {
        kind: "question",
        question: "Which Juno?",
        options: [{ label: "Clapham" }, { label: "Soho" }],
        allows_text: true,
        secret: false,
      },
    });
    expect(toAskFields({ question: "Pick one", options: [{ label: "A" }], allows_text: false })).toMatchObject({
      value: { allows_text: false },
    });
    expect(toAskFields({ question: "What's the code?", allows_text: false, secret: true })).toMatchObject({
      value: { options: [], allows_text: true, secret: true },
    });
  });

  it("needs exactly one acting option for an approval, and keeps its preview", () => {
    const approval = {
      kind: "approval",
      question: "Shall I book this?",
      preview: "Juno, Clapham, Saturday at 7:30",
      options: [{ label: "Book it", acts: true }, { label: "Not now" }],
    };
    expect(toAskFields(approval)).toMatchObject({
      value: { kind: "approval", preview: "Juno, Clapham, Saturday at 7:30", options: [{ acts: true }, {}] },
    });
    expect(toAskFields({ ...approval, options: [{ label: "Book it" }] })).toEqual({
      ok: false,
      failure: "An approval needs options, exactly one of them with acts: true.",
    });
  });

  it("refuses what Ari can't show", () => {
    expect(toAskFields({ question: "  " })).toEqual({ ok: false, failure: "An ask needs a question." });
    const many = Array.from({ length: 7 }, (_, index) => ({ label: String(index) }));
    expect(toAskFields({ question: "Which?", options: many })).toMatchObject({ ok: false });
    expect(toAskFields({ question: "Which?", options: [{ label: "" }] })).toMatchObject({ ok: false });
  });
});
