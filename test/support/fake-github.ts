import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createCell } from "#cell.ts";

export type FakeIssue = {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly labels: readonly string[];
  readonly comments: readonly string[];
};

export type FakeGitHub = {
  readonly apiUrl: string;
  readonly token: string;
  readonly repository: string;
  readonly issues: () => readonly FakeIssue[];
  readonly labels: () => readonly string[];
  readonly close: () => Promise<void>;
};

type Body = Readonly<Record<string, unknown>>;

const readBody = async (request: IncomingMessage): Promise<Body> => {
  const chunks: readonly Buffer[] = await request.toArray();
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? (JSON.parse(text) as Body) : {};
};

const sendJson = (response: ServerResponse, status: number, body: unknown): void => {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
};

const stringOf = (value: unknown): string => (typeof value === "string" ? value : "");

export const startFakeGitHub = async (): Promise<FakeGitHub> => {
  const token = "github_pat_fake";
  const repository = "akai-ito/ito-core";
  const issues = createCell<readonly FakeIssue[]>([]);
  const labels = createCell<readonly string[]>([]);
  const site = `https://github.com/${repository}`;

  const respond = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const body = await readBody(request);
    if (request.headers.authorization !== `Bearer ${token}`) {
      sendJson(response, 401, { message: "Bad credentials" });
      return;
    }
    const url = new URL(request.url ?? "/", "http://localhost");
    const route = `${request.method ?? ""} ${url.pathname.replace(`/repos/${repository}`, "")}`;
    const commentsOn = /^POST \/issues\/(?<number>\d+)\/comments$/u.exec(route)?.groups?.number;
    switch (commentsOn ? "POST /issues/:number/comments" : route) {
      case "GET ": {
        sendJson(response, 200, { full_name: repository });
        return;
      }
      case "GET /issues": {
        const label = url.searchParams.get("labels") ?? "";
        const listed = issues.get().filter((issue) => issue.labels.includes(label));
        sendJson(
          response,
          200,
          listed.map((issue) => ({
            number: issue.number,
            html_url: `${site}/issues/${String(issue.number)}`,
            body: issue.body,
          })),
        );
        return;
      }
      case "POST /labels": {
        const name = stringOf(body.name);
        const isKnown = labels.get().includes(name);
        if (!isKnown) labels.set([...labels.get(), name]);
        sendJson(response, isKnown ? 422 : 201, isKnown ? { message: "Validation Failed" } : { name });
        return;
      }
      case "POST /issues": {
        const number = issues.get().length + 1;
        const requested = Array.isArray(body.labels) ? body.labels.map((label) => stringOf(label)) : [];
        const issue = {
          number,
          title: stringOf(body.title),
          body: stringOf(body.body),
          labels: requested.filter((label) => labels.get().includes(label)),
          comments: [],
        };
        issues.set([...issues.get(), issue]);
        sendJson(response, 201, { number, html_url: `${site}/issues/${String(number)}` });
        return;
      }
      case "POST /issues/:number/comments": {
        const number = Number(commentsOn);
        issues.set(
          issues
            .get()
            .map((issue) =>
              issue.number === number ? { ...issue, comments: [...issue.comments, stringOf(body.body)] } : issue,
            ),
        );
        const count = issues.get().reduce((total, issue) => total + issue.comments.length, 0);
        sendJson(response, 201, { html_url: `${site}/issues/${String(number)}#issuecomment-${String(1000 + count)}` });
        return;
      }
      default: {
        sendJson(response, 404, { message: "Not Found" });
      }
    }
  };

  const server = createServer((request, response) => {
    void respond(request, response);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("The fake GitHub has no port.");

  return {
    apiUrl: `http://127.0.0.1:${String(address.port)}`,
    token,
    repository,
    issues: () => issues.get(),
    labels: () => labels.get(),
    close: async () => {
      server.closeAllConnections();
      server.close();
      await once(server, "close");
    },
  };
};
