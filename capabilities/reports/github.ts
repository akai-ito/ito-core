import type { IssueText } from "./gap.ts";
import { fail, ok, type Result } from "#result.ts";

export type Issue = { readonly number: number; readonly url: string };

export type GitHub = {
  readonly findIssue: (text: string) => Promise<Result<Issue | undefined, string>>;
  readonly openIssue: (issue: IssueText) => Promise<Result<Issue, string>>;
  readonly comment: (issue: number, body: string) => Promise<Result<string, string>>;
  readonly checkAccess: () => Promise<string | undefined>;
};

export type GitHubOptions = {
  readonly apiUrl: string;
  readonly repository: string;
  readonly token: string;
  readonly userAgent: string;
};

type IssueRow = {
  readonly number: number;
  readonly html_url: string;
  readonly body?: string | null;
  readonly pull_request?: unknown;
};

type CommentRow = { readonly html_url: string };

export const gapLabel = "gap";

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const messageOf = async (response: Response): Promise<string | undefined> => {
  try {
    return ((await response.json()) as { readonly message?: string }).message;
  } catch {
    return undefined;
  }
};

const describeFailure = async (response: Response): Promise<string> => {
  const message = await messageOf(response);
  return `GitHub answered ${String(response.status)}${message ? `: ${message}` : ""}.`;
};

const toIssue = (row: IssueRow): Issue => ({ number: row.number, url: row.html_url });

export const isRejectedToken = (failure: string): boolean => failure.startsWith("GitHub answered 401");

export const createGitHub = ({ apiUrl, repository, token, userAgent }: GitHubOptions): GitHub => {
  const send = (method: string, path: string, body?: unknown): Promise<Response> =>
    fetch(`${apiUrl}/repos/${repository}${path}`, {
      method,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "user-agent": userAgent,
        "x-github-api-version": "2022-11-28",
        ...(body !== undefined && { "content-type": "application/json" }),
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });

  const request = async <Body>(method: string, path: string, body?: unknown): Promise<Result<Body, string>> => {
    try {
      const response = await send(method, path, body);
      return response.ok ? ok((await response.json()) as Body) : fail(await describeFailure(response));
    } catch (error) {
      return fail(`GitHub couldn't be reached: ${describe(error)}.`);
    }
  };

  return {
    findIssue: async (text) => {
      const listed = await request<readonly IssueRow[]>("GET", `/issues?labels=${gapLabel}&state=open&per_page=100`);
      if (!listed.ok) return listed;
      const found = listed.value.find((row) => row.pull_request === undefined && row.body?.includes(text));
      return ok(found && toIssue(found));
    },
    openIssue: async ({ title, body }) => {
      await request("POST", "/labels", { name: gapLabel, color: "c5def5", description: "A gap Ari reported" });
      const opened = await request<IssueRow>("POST", "/issues", { title, body, labels: [gapLabel] });
      return opened.ok ? ok(toIssue(opened.value)) : opened;
    },
    comment: async (issue, body) => {
      const commented = await request<CommentRow>("POST", `/issues/${String(issue)}/comments`, { body });
      return commented.ok ? ok(commented.value.html_url) : commented;
    },
    checkAccess: async () => {
      try {
        const { status } = await send("GET", "");
        if (status === 401) return "GitHub rejected that token.";
        if (status === 403 || status === 404) return `That token can't reach ${repository}.`;
        return status < 300 ? undefined : `GitHub answered ${String(status)}.`;
      } catch (error) {
        return `GitHub couldn't be reached: ${describe(error)}.`;
      }
    },
  };
};
