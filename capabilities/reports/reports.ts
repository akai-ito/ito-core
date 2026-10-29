import { z } from "zod";
import { defineCapability, defineOperation, fail, ok, type Capability, type Values } from "#sdk/capability.ts";
import { toGap } from "./gap.ts";
import { createGitHub, isRejectedToken, type GitHub } from "./github.ts";
import { createReporter, defaultDailyLimit } from "./reporter.ts";

export type ReportsOptions = {
  readonly apiUrl?: string;
  readonly repository?: string;
  readonly dailyLimit?: number;
  readonly now?: () => number;
};

const text = (description: string): z.ZodString => z.string().describe(description);

const gapInput = z.object({
  capability: text("What you were using, such as web search, the shell, files or your instructions."),
  operation: text("What you were doing with it, such as opening a page or running a command."),
  tried: text("What you tried, as operations, with nothing about the person."),
  failed: text("What went wrong: the error, the status or the wrong result."),
  would_help: text("What would have prevented it: a tool, a source, a capability or a change to your instructions."),
});

const tokenOf = (values: Values): string => (typeof values.token === "string" ? values.token.trim() : "");

const githubAppClientId = "Iv23li3oHOYWc4Qelv2h";

export const createReports = ({
  apiUrl = "https://api.github.com",
  repository = "akai-ito/ito-core",
  dailyLimit = defaultDailyLimit,
  now = Date.now,
}: ReportsOptions = {}): Capability => {
  const reporter = createReporter(now, dailyLimit);
  const connect = (token: string, version: string): GitHub =>
    createGitHub({ apiUrl, repository, token, userAgent: `ito/${version}` });

  return defineCapability({
    id: "reports",
    version: "0.1",
    kind: "hand",
    title: "Reports",
    symbol: "exclamationmark.bubble",
    summary: "Files the gaps Ari hits as public issues on Ito's repositories.",
    skill:
      "Report a gap whenever you couldn't find something out or do something, or the person corrected a mistake: " +
      "use the report_gap tool. Reports are public GitHub issues, so describe only operations, never what the " +
      'person said or anything about them. Say "I\'ve reported that" once, and only after the report went through.',
    uses: { hosts: [new URL(apiUrl).host, "github.com"], folders: [] },
    setup: [
      {
        name: "token",
        kind: "secret",
        title: "GitHub token",
        description: `Connect GitHub, so Reports files issues on ${repository} as you.`,
        connect: {
          kind: "oauth_device",
          title: "Connect GitHub",
          deviceUrl: "https://github.com/login/device/code",
          tokenUrl: "https://github.com/login/oauth/access_token",
          clientId: githubAppClientId,
        },
      },
    ],
    check: async (values, server) => {
      const token = tokenOf(values);
      return token === "" ? "Give a GitHub token first." : connect(token, server.version).checkAccess();
    },
    operations: [
      defineOperation({
        name: "report",
        title: "Report a gap to Ito",
        running: "Reporting it to Ito",
        done: "Reported it to Ito",
        description:
          "Report a gap you hit to Ito's developers: something you couldn't find out or do, or a mistake the " +
          "person corrected. The report is a public GitHub issue, so describe only operations: never what the " +
          "person said, their names, places or plans, or anything else about them. Ito adds its version, and adds " +
          "to an existing issue for the same gap instead of opening another.",
        input: gapInput,
        tool: "report_gap",
        run: async (input, { values, server, turn, status }) => {
          const gap = toGap(input);
          if (!gap.ok) return gap;
          const filed = await reporter.report(gap.value, {
            github: connect(tokenOf(values), server.version),
            turn,
            versions: { ito: server.version, engine: server.engine },
          });
          if (!filed.ok) {
            if (isRejectedToken(filed.failure)) status({ state: "needs_you", detail: "GitHub rejected the token." });
            return filed;
          }
          if (filed.value === "over_limit") {
            process.stderr.write(`A gap report went unfiled, past today's limit: ${JSON.stringify(gap.value)}\n`);
            return fail(`Today's ${String(dailyLimit)} reports are used up, so this one went to the log.`);
          }
          const { url, action } = filed.value;
          return ok({
            text: action === "opened" ? `Reported as a new issue: ${url}` : `Added to the existing issue: ${url}`,
            data: { url, action },
          });
        },
      }),
    ],
  });
};
