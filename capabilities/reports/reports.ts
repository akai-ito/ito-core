import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import {
  defineCapability,
  defineOperation,
  fail,
  ok,
  type Capability,
  type Result,
  type Status,
  type Values,
} from "#sdk/capability.ts";
import { createGitHub, isRejectedToken, type GitHub } from "./github.ts";
import {
  mediaPath,
  toBody,
  toOptions,
  toPreview,
  toQuestion,
  uploadPath,
  uploadsFolder,
  type Report,
  type Stored,
} from "./report.ts";

export type ReportsOptions = {
  readonly apiUrl?: string;
  readonly repository?: string;
  readonly mediaRepository?: string;
  readonly now?: () => Date;
};

const text = (description: string): z.ZodString => z.string().trim().min(1).describe(description);

const screenshot = z.object({
  file: text(`A picture they sent, as saved in your folder, such as ${uploadsFolder}/IMG_2041.png.`),
  shows: text("What it shows, in a few words, such as “the Library shelves”."),
});

const reportInput = z.object({
  title: text(
    "For a new issue: a short, plain title in their terms, such as “Library shelves need icons, not clipped names”.",
  ).optional(),
  body: text(
    "Markdown. Their feedback: what they noticed, why it matters to them, what they'd prefer. Something you " +
      "couldn't do: what you were doing for them, what got in the way, what would have helped. Nothing private.",
  ),
  screenshots: z.array(screenshot).optional(),
  issue: z.number().int().positive().optional().describe("The issue this adds to, such as 59, instead of a new one."),
});

const tokenOf = (values: Values): string => (typeof values.token === "string" ? values.token.trim() : "");

const githubAppClientId = "Iv23li3oHOYWc4Qelv2h";

const rejectedToken: Status = { state: "needs_you", detail: "GitHub rejected the token." };

export const createReports = ({
  apiUrl = "https://api.github.com",
  repository = "akai-ito/ito-core",
  mediaRepository = "akai-ito/report-media",
  now = () => new Date(),
}: ReportsOptions = {}): Capability => {
  const connect = (token: string, version: string): GitHub =>
    createGitHub({ apiUrl, repository, mediaRepository, token, userAgent: `ito/${version}` });

  const store = async (
    github: GitHub,
    pictures: readonly { readonly path: string; readonly shows: string }[],
    stored: readonly Stored[] = [],
  ): Promise<Result<readonly Stored[], string>> => {
    const [next, ...rest] = pictures;
    if (!next) return ok(stored);
    const bytes = await readFile(next.path);
    const where = mediaPath(createHash("sha256").update(bytes).digest("hex"), next.path, now());
    const kept = await github.storeMedia(where, bytes);
    return kept.ok
      ? store(github, rest, [...stored, { shows: next.shows, url: kept.value }])
      : fail(`${kept.failure} The screenshots couldn't be stored in ${mediaRepository}.`);
  };

  return defineCapability({
    id: "reports",
    version: "0.2",
    kind: "hand",
    title: "Reports",
    symbol: "exclamationmark.bubble",
    summary: "Takes your feedback, and what Ari couldn't do, to Ito's developers as public GitHub issues.",
    skill:
      "Report to Ito's developers when the person gives feedback on Ito or Ari, when you couldn't do something " +
      "for them, or when they corrected a mistake Ito's design led you into. Write as their collaborator: a short " +
      "plain title, then in Markdown what they noticed, why it matters to them and what they'd prefer; for " +
      "something you couldn't do, what you were doing for them, what got in the way and what would have helped. " +
      "Issues are public, so leave out anything private: names, places, plans, what they said about anyone. " +
      "Attach the screenshots they sent when they show the point, saying what each shows. The report tool shows " +
      "them the draft and files it only if they agree; if they say what to change, change it and report again. " +
      "Before a new report, look at recent_reports: a follow-up goes to its issue with `issue`, never as a second " +
      "one. Report at the end of what you're doing, not in the middle, and say so once it went through, with its " +
      "link.",
    uses: { hosts: [new URL(apiUrl).host, "github.com"], folders: [uploadsFolder] },
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
        title: "Report to Ito",
        running: "Reporting it to Ito",
        done: "Reported it to Ito",
        description:
          "Report the person's feedback, or something you couldn't do for them, to Ito's developers as a public " +
          "GitHub issue, or add it to an existing one with `issue`. It shows them the draft, with the screenshots, " +
          "and files it only if they agree.",
        input: reportInput,
        tool: "report",
        run: async (input, { values, server, status, approve }) => {
          const report: Report = {
            ...(input.title !== undefined && { title: input.title }),
            body: input.body,
            screenshots: input.screenshots ?? [],
            ...(input.issue !== undefined && { issue: input.issue }),
          };
          if (report.issue === undefined && report.title === undefined) return fail("A new report needs a title.");
          const pictures = report.screenshots.map(({ file, shows }) => ({
            file,
            shows,
            path: uploadPath(server.workspace, file),
          }));
          const stray = pictures.find((picture) => picture.path === undefined);
          if (stray) return fail(`${stray.file} isn't a picture they sent: use one saved in ${uploadsFolder}/.`);
          const found = pictures.flatMap(({ path, shows }) => (path === undefined ? [] : { path, shows }));
          const approved = await approve({
            question: toQuestion(report),
            preview: toPreview(report, repository),
            options: toOptions(report),
            pictures: found.map(({ path }) => path),
          });
          if (!approved.ok) return approved;
          if (!approved.value) {
            return fail("They didn't file it. If they said what to change, change the draft and report again.");
          }
          const github = connect(tokenOf(values), server.version);
          const refused = (failure: string): Result<never, string> => {
            if (isRejectedToken(failure)) status(rejectedToken);
            return fail(failure);
          };
          const stored = await store(github, found);
          if (!stored.ok) return refused(stored.failure);
          const body = toBody(report.body, stored.value, { ito: server.version, engine: server.engine });
          if (report.issue !== undefined) {
            const commented = await github.comment(report.issue, body);
            if (!commented.ok) return refused(commented.failure);
            return ok({
              text: `Added to issue #${String(report.issue)}: ${commented.value}`,
              data: { url: commented.value, action: "commented" },
            });
          }
          const opened = await github.openIssue(report.title ?? "", body);
          if (!opened.ok) return refused(opened.failure);
          return ok({
            text: `Filed as issue #${String(opened.value.number)}: ${opened.value.url}`,
            data: { url: opened.value.url, action: "opened" },
          });
        },
      }),
      defineOperation({
        name: "recent",
        title: "Recent reports",
        running: "Looking at Ito's open issues",
        done: "Looked at Ito's open issues",
        description:
          "List Ito's open issues, most recently active first, so a follow-up goes to the issue it belongs to.",
        input: z.object({}),
        tool: "recent_reports",
        run: async (_input, { values, server }) => {
          const listed = await connect(tokenOf(values), server.version).openIssues();
          if (!listed.ok) return listed;
          const lines = listed.value.map(
            ({ number, title, updatedAt, url }) =>
              `#${String(number)} ${title} (active ${updatedAt.slice(0, 10)}) ${url}`,
          );
          return ok({ text: lines.length === 0 ? "No open issues." : lines.join("\n") });
        },
      }),
    ],
  });
};
