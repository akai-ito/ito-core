import { describe, expect, it } from "vitest";
import { declined, toApprovalFields, toElicitationResponse } from "#engine/codex/approvals.ts";
import type { McpServerElicitationRequestParams } from "#engine/codex/bindings/v2/McpServerElicitationRequestParams.ts";
import type { Ask } from "#protocol/types.ts";
import { isAllowing } from "#turns/turns.ts";

const calendar: McpServerElicitationRequestParams = {
  threadId: "thread",
  turnId: "turn",
  serverName: "codex_apps",
  mode: "form",
  message: "Allow Google Calendar to create an event?",
  _meta: {
    codex_approval_kind: "mcp_tool_call",
    tool_params_display: [
      { name: "title", value: "Call Mum" },
      { name: "start", value: "Sunday 1 November, 2pm" },
    ],
  },
  requestedSchema: { type: "object", properties: {} },
};

const approval: Ask = {
  id: "a_1",
  turn: "t_1",
  kind: "approval",
  question: "Allow Google Calendar to create an event?",
  options: [{ label: "Allow", acts: true }, { label: "Don't" }],
  allows_text: true,
  at: "2026-10-28T08:00:00.000Z",
  position: 3,
};

describe("an app's approval, from Codex to Ari and back", () => {
  it("becomes an approval with the action as its preview", () => {
    expect(toApprovalFields(calendar)).toEqual({
      kind: "approval",
      question: "Allow Google Calendar to create an event?",
      options: [{ label: "Allow", acts: true }, { label: "Don't" }],
      allows_text: true,
      preview: "title: Call Mum\nstart: Sunday 1 November, 2pm",
    });
  });

  it("isn't offered for a link Codex wants opened", () => {
    expect(
      toApprovalFields({ ...calendar, mode: "url", url: "https://example.com", elicitationId: "e" }),
    ).toBeUndefined();
  });

  it("accepts with the form's required choices filled, or declines", () => {
    const withChoice: McpServerElicitationRequestParams = {
      ...calendar,
      requestedSchema: {
        type: "object",
        properties: { scope: { type: "string", enum: ["once", "session"] } },
        required: ["scope"],
      },
    };

    expect(toElicitationResponse(calendar, true)).toEqual({ action: "accept", content: {}, _meta: null });
    expect(toElicitationResponse(withChoice, true)).toEqual({
      action: "accept",
      content: { scope: "once" },
      _meta: null,
    });
    expect(toElicitationResponse(calendar, false)).toEqual(declined);
  });

  it("allows only on the acting option or a plain yes", () => {
    expect(isAllowing("Allow", approval)).toBe(true);
    expect(isAllowing("Yes, go ahead.", approval)).toBe(true);
    expect(isAllowing("Don't", approval)).toBe(false);
    expect(isAllowing("Do it at 3 instead", approval)).toBe(false);
  });
});
