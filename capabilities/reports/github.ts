import { fail, ok, type Result } from "#result.ts";

export type Issue = { readonly number: number; readonly url: string };

export type OpenIssue = Issue & { readonly title: string; readonly updatedAt: string };

export type GitHub = {
  readonly openIssue: (title: string, body: string) => Promise<Result<Issue, string>>;
  readonly comment: (issue: number, body: string) => Promise<Result<string, string>>;
  readonly openIssues: () => Promise<Result<readonly OpenIssue[], string>>;
  readonly storeMedia: (path: string, bytes: Buffer) => Promise<Result<string, string>>;
  readonly checkAccess: () => Promise<string | undefined>;
};

export type GitHubOptions = {
  readonly apiUrl: string;
  readonly repository: string;
  readonly mediaRepository: string;
  readonly token: string;
  readonly userAgent: string;
};

type IssueRow = {
  readonly number: number;
  readonly html_url: string;
  readonly title?: string;
  readonly updated_at?: string;
  readonly pull_request?: unknown;
};

type CommentRow = { readonly html_url: string };

type ContentRow = { readonly content?: { readonly download_url?: string }; readonly download_url?: string };

export const reportLabel = "from-ari";

const listedIssues = 30;

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

export const isRejectedToken = (failure: string): boolean => failure.startsWith("GitHub answered 401");

export const createGitHub = ({ apiUrl, repository, mediaRepository, token, userAgent }: GitHubOptions): GitHub => {
  const send = (method: string, path: string, body?: unknown): Promise<Response> =>
    fetch(`${apiUrl}/repos/${path}`, {
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
    openIssue: async (title, body) => {
      await request("POST", `${repository}/labels`, {
        name: reportLabel,
        color: "c5def5",
        description: "Reported through Ari, as the person approved it",
      });
      const opened = await request<IssueRow>("POST", `${repository}/issues`, { title, body, labels: [reportLabel] });
      return opened.ok ? ok({ number: opened.value.number, url: opened.value.html_url }) : opened;
    },
    comment: async (issue, body) => {
      const commented = await request<CommentRow>("POST", `${repository}/issues/${String(issue)}/comments`, { body });
      return commented.ok ? ok(commented.value.html_url) : commented;
    },
    openIssues: async () => {
      const listed = await request<readonly IssueRow[]>(
        "GET",
        `${repository}/issues?state=open&sort=updated&per_page=${String(listedIssues)}`,
      );
      return listed.ok
        ? ok(
            listed.value
              .filter((row) => row.pull_request === undefined)
              .map((row) => ({
                number: row.number,
                url: row.html_url,
                title: row.title ?? "",
                updatedAt: row.updated_at ?? "",
              })),
          )
        : listed;
    },
    storeMedia: async (path, bytes) => {
      const where = `${mediaRepository}/contents/${path}`;
      const stored = await request<ContentRow>("PUT", where, {
        message: "Add a screenshot for a report",
        content: bytes.toString("base64"),
      });
      const found =
        stored.ok || !stored.failure.startsWith("GitHub answered 422")
          ? stored
          : await request<ContentRow>("GET", where);
      if (!found.ok) return found;
      const url = found.value.content?.download_url ?? found.value.download_url;
      return url ? ok(url) : fail(`GitHub didn't say where ${path} is.`);
    },
    checkAccess: async () => {
      try {
        const { status } = await send("GET", repository);
        if (status === 401) return "GitHub rejected that token.";
        if (status === 403 || status === 404) return `That token can't reach ${repository}.`;
        return status < 300 ? undefined : `GitHub answered ${String(status)}.`;
      } catch (error) {
        return `GitHub couldn't be reached: ${describe(error)}.`;
      }
    },
  };
};
