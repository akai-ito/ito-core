import type { TurnId } from "#conversation/ids.ts";
import { toGap } from "#reports/gap.ts";
import type { Reporter } from "#reports/reporter.ts";
import type { Tool } from "#tools/mcp.ts";

export const reportToolName = "report_gap";

const text = (description: string): Readonly<Record<string, string>> => ({ type: "string", description });

export const createReportTool = (reporter: Reporter, currentTurn: () => TurnId | undefined): Tool => ({
  name: reportToolName,
  title: "Report a gap to Ito",
  description:
    "Report a gap you hit to Ito's developers: something you couldn't find out or do, or a mistake the person " +
    "corrected. The report is a public GitHub issue, so describe only operations: never what the person said, " +
    "their names, places or plans, or anything else about them. Ito adds its version, and adds to an existing " +
    "issue for the same gap instead of opening another.",
  inputSchema: {
    type: "object",
    properties: {
      capability: text("What you were using, such as web search, the shell, files or your instructions."),
      operation: text("What you were doing with it, such as opening a page or running a command."),
      tried: text("What you tried, as operations, with nothing about the person."),
      failed: text("What went wrong: the error, the status or the wrong result."),
      would_help: text(
        "What would have prevented it: a tool, a source, a capability or a change to your instructions.",
      ),
    },
    required: ["capability", "operation", "tried", "failed", "would_help"],
    additionalProperties: false,
  },
  call: async (input) => {
    const gap = toGap(input);
    if (!gap.ok) return { text: gap.failure, isError: true };
    const filed = await reporter.report(currentTurn(), gap.value);
    if (!filed.ok) return { text: filed.failure, isError: true };
    const { url, action } = filed.value;
    return {
      text: action === "opened" ? `Reported as a new issue: ${url}` : `Added to the existing issue: ${url}`,
      structured: { url, action },
    };
  },
});
