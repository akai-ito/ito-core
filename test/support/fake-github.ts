import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { createCell } from "#cell.ts";

export type FakeIssue = {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly labels: readonly string[];
  readonly comments: readonly string[];
};

// Ito Memory as GitHub runs it: the device flow with expiring tokens, the app's installation on
// one account, repositories it can see only once installed on them, and git over HTTP.
export type FakeGitHubOptions = {
  readonly createNeedsInstall?: boolean;
  readonly createdJoinsInstall?: boolean;
  readonly expiresIn?: number;
};

export type FakeRepository = { readonly id: number; readonly isPrivate: boolean; readonly directory: string };

type Installation = { readonly id: number; readonly repositories: "all" | readonly string[] };

type Tokens = {
  readonly access: ReadonlySet<string>;
  readonly refresh: ReadonlySet<string>;
  readonly issued: number;
  readonly refreshes: number;
};

export type FakeGitHub = {
  readonly apiUrl: string;
  readonly login: string;
  readonly userId: number;
  readonly userCode: string;
  readonly approve: () => void;
  readonly install: (repositories: "all" | readonly string[]) => void;
  readonly installationId: number;
  readonly addRepository: (name: string, isPrivate?: boolean) => FakeRepository;
  readonly repositories: () => ReadonlyMap<string, FakeRepository>;
  readonly revoke: () => void;
  readonly refreshes: () => number;
  readonly token: string;
  readonly repository: string;
  readonly mediaRepository: string;
  readonly issues: () => readonly FakeIssue[];
  readonly media: () => ReadonlyMap<string, Buffer>;
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

const readForm = async (request: IncomingMessage): Promise<URLSearchParams> => {
  const chunks: readonly Buffer[] = await request.toArray();
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
};

// The CGI answer of git http-backend: headers, a blank line, then the body.
const sendCgi = (response: ServerResponse, output: Buffer): void => {
  const split = output.indexOf("\r\n\r\n");
  const headers = output
    .subarray(0, split)
    .toString("utf8")
    .split("\r\n")
    .map((line) => [line.slice(0, line.indexOf(":")), line.slice(line.indexOf(":") + 1).trim()] as const);
  const status = Number(headers.find(([name]) => name.toLowerCase() === "status")?.[1].split(" ", 1)[0] ?? 200);
  response.writeHead(status, Object.fromEntries(headers.filter(([name]) => name.toLowerCase() !== "status")));
  response.end(output.subarray(split + 4));
};

export const startFakeGitHub = async (options: FakeGitHubOptions = {}): Promise<FakeGitHub> => {
  const token = "github_pat_fake";
  const repository = "akai-ito/ito-core";
  const mediaRepository = "akai-ito/report-media";
  const issues = createCell<readonly FakeIssue[]>([]);
  const media = createCell<ReadonlyMap<string, Buffer>>(new Map());
  const rawUrl = (file: string): string => `https://raw.githubusercontent.com/${mediaRepository}/main/${file}`;
  const labels = createCell<readonly string[]>([]);
  const site = `https://github.com/${repository}`;
  const login = "octo-person";
  const userId = 4242;
  const userCode = "WDJB-MJHT";
  const deviceCode = "device_code_fake";
  const root = mkdtempSync(path.join(os.tmpdir(), "ito-fake-github-"));
  const isApproved = createCell(false);
  const installation = createCell<Installation | undefined>(undefined);
  const repositories = createCell<ReadonlyMap<string, FakeRepository>>(new Map());
  const tokens = createCell<Tokens>({ access: new Set(), refresh: new Set(), issued: 0, refreshes: 0 });

  const issue = (): Readonly<Record<string, unknown>> => {
    const number = tokens.get().issued + 1;
    const pair = { access: `ghu_fake_${String(number)}`, refresh: `ghr_fake_${String(number)}` };
    tokens.update((current) => ({
      ...current,
      access: new Set([...current.access, pair.access]),
      refresh: new Set([...current.refresh, pair.refresh]),
      issued: number,
    }));
    return {
      access_token: pair.access,
      token_type: "bearer",
      expires_in: options.expiresIn ?? 28_800,
      refresh_token: pair.refresh,
      refresh_token_expires_in: 15_897_600,
    };
  };

  const isCovered = (name: string): boolean => {
    const current = installation.get();
    return current !== undefined && (current.repositories === "all" || current.repositories.includes(name));
  };

  const addRepository = (name: string, isPrivate = true): FakeRepository => {
    const directory = path.join(root, login, `${name}.git`);
    mkdirSync(directory, { recursive: true });
    execFileSync("git", ["init", "--quiet", "--bare", "--initial-branch=main", directory]);
    const made = { id: 9000 + repositories.get().size, isPrivate, directory };
    repositories.update((current) => new Map([...current, [name, made]]));
    return made;
  };

  const toBody = (name: string, { id, isPrivate }: FakeRepository): Readonly<Record<string, unknown>> => ({
    id,
    name,
    full_name: `${login}/${name}`,
    private: isPrivate,
  });

  const serveGit = async (request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> => {
    const name = /^\/[^/]+\/(?<name>[^/]+)\.git\//u.exec(url.pathname)?.groups?.name ?? "";
    const [scheme = "", encoded = ""] = (request.headers.authorization ?? "").split(" ", 2);
    const [, token = ""] = Buffer.from(encoded, "base64").toString("utf8").split(":", 2);
    if (scheme !== "Basic" || !tokens.get().access.has(token)) {
      response.writeHead(401, { "www-authenticate": 'Basic realm="GitHub"' });
      response.end();
      return;
    }
    if (!repositories.get().has(name) || !isCovered(name)) {
      response.writeHead(404);
      response.end("Repository not found.");
      return;
    }
    const backend = spawn("git", ["http-backend"], {
      env: {
        ...process.env,
        GIT_PROJECT_ROOT: root,
        GIT_HTTP_EXPORT_ALL: "1",
        PATH_INFO: url.pathname,
        QUERY_STRING: url.search.slice(1),
        REQUEST_METHOD: request.method ?? "GET",
        CONTENT_TYPE: request.headers["content-type"] ?? "",
        REMOTE_USER: "x-access-token",
        ...(request.headers["content-encoding"] && { HTTP_CONTENT_ENCODING: request.headers["content-encoding"] }),
      },
    });
    request.pipe(backend.stdin);
    const output: readonly Buffer[] = await backend.stdout.toArray();
    sendCgi(response, Buffer.concat(output));
  };

  // Ito Memory's routes; false for any other.
  const serveApp = async (request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean> => {
    const route = `${request.method ?? ""} ${url.pathname}`;
    if (url.pathname.endsWith("/info/refs") || /\.git\/git-(?:upload|receive)-pack$/u.test(url.pathname)) {
      await serveGit(request, response, url);
      return true;
    }
    if (route === "POST /login/device/code") {
      await readForm(request);
      sendJson(response, 200, {
        device_code: deviceCode,
        user_code: userCode,
        verification_uri: "https://github.com/login/device",
        expires_in: 900,
        interval: 0.01,
      });
      return true;
    }
    if (route === "POST /login/oauth/access_token") {
      const form = await readForm(request);
      if (form.get("grant_type") === "refresh_token") {
        const refresh = form.get("refresh_token") ?? "";
        if (!tokens.get().refresh.has(refresh)) {
          sendJson(response, 200, { error: "bad_refresh_token", error_description: "The refresh token is invalid." });
          return true;
        }
        // The used pair stops working.
        const used = `ghu_${refresh.slice("ghr_".length)}`;
        tokens.update((current) => ({
          ...current,
          access: new Set([...current.access].filter((token) => token !== used)),
          refresh: new Set([...current.refresh].filter((token) => token !== refresh)),
          refreshes: current.refreshes + 1,
        }));
        sendJson(response, 200, issue());
        return true;
      }
      sendJson(
        response,
        200,
        form.get("device_code") === deviceCode && isApproved.get() ? issue() : { error: "authorization_pending" },
      );
      return true;
    }
    const bearer = (request.headers.authorization ?? "").replace(/^Bearer /u, "");
    if (!bearer.startsWith("ghu_")) return false;
    if (!tokens.get().access.has(bearer)) {
      sendJson(response, 401, { message: "Bad credentials" });
      return true;
    }
    const current = installation.get();
    const repositoryName = new RegExp(`^GET /repos/${login}/(?<name>[^/]+)$`, "u").exec(route)?.groups?.name;
    if (route === "GET /user") {
      sendJson(response, 200, { id: userId, login });
    } else if (route === "GET /user/installations") {
      sendJson(response, 200, {
        total_count: current ? 1 : 0,
        installations: current
          ? [
              {
                id: current.id,
                account: { id: userId, login },
                app_slug: "ito-memory",
                repository_selection: "selected",
              },
            ]
          : [],
      });
    } else if (repositoryName !== undefined) {
      const found = repositories.get().get(repositoryName);
      const isVisible = found !== undefined && (!found.isPrivate || isCovered(repositoryName));
      sendJson(response, isVisible ? 200 : 404, isVisible ? toBody(repositoryName, found) : { message: "Not Found" });
    } else if (route === "POST /user/repos") {
      const { name: named = "" } = (await readBody(request)) as { readonly name?: string };
      if (!current && options.createNeedsInstall === true) {
        sendJson(response, 403, { message: "Resource not accessible by integration" });
      } else if (repositories.get().has(named)) {
        sendJson(response, 422, {
          message: "Repository creation failed.",
          errors: [{ message: "name already exists on this account" }],
        });
      } else {
        const made = addRepository(named);
        if (current && current.repositories !== "all" && (options.createdJoinsInstall ?? true)) {
          installation.set({ ...current, repositories: [...current.repositories, named] });
        }
        sendJson(response, 201, toBody(named, made));
      }
    } else {
      sendJson(response, 404, { message: "Not Found" });
    }
    return true;
  };

  const respond = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    if (await serveApp(request, response, new URL(request.url ?? "/", "http://localhost"))) return;
    const body = await readBody(request);
    if (request.headers.authorization !== `Bearer ${token}`) {
      sendJson(response, 401, { message: "Bad credentials" });
      return;
    }
    const url = new URL(request.url ?? "/", "http://localhost");
    const mediaFile = url.pathname.startsWith(`/repos/${mediaRepository}/contents/`)
      ? url.pathname.slice(`/repos/${mediaRepository}/contents/`.length)
      : undefined;
    if (mediaFile !== undefined) {
      const isThere = media.get().has(mediaFile);
      if (request.method === "GET") {
        sendJson(
          response,
          isThere ? 200 : 404,
          isThere ? { download_url: rawUrl(mediaFile) } : { message: "Not Found" },
        );
        return;
      }
      if (isThere) {
        sendJson(response, 422, { message: 'Invalid request. "sha" wasn\'t supplied.' });
        return;
      }
      media.update((current) => new Map([...current, [mediaFile, Buffer.from(stringOf(body.content), "base64")]]));
      sendJson(response, 201, { content: { download_url: rawUrl(mediaFile) } });
      return;
    }
    const route = `${request.method ?? ""} ${url.pathname.replace(`/repos/${repository}`, "")}`;
    const commentsOn = /^POST \/issues\/(?<number>\d+)\/comments$/u.exec(route)?.groups?.number;
    switch (commentsOn ? "POST /issues/:number/comments" : route) {
      case "GET ": {
        sendJson(response, 200, { full_name: repository });
        return;
      }
      case "GET /issues": {
        sendJson(
          response,
          200,
          issues
            .get()
            .toReversed()
            .map((issue) => ({
              number: issue.number,
              title: issue.title,
              html_url: `${site}/issues/${String(issue.number)}`,
              updated_at: "2026-10-30T09:00:00Z",
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
  const installationId = 77;

  return {
    apiUrl: `http://127.0.0.1:${String(address.port)}`,
    login,
    userId,
    userCode,
    approve: () => {
      isApproved.set(true);
    },
    install: (chosen) => {
      installation.set({ id: installationId, repositories: chosen });
    },
    installationId,
    addRepository,
    repositories: () => repositories.get(),
    revoke: () => {
      tokens.update((current) => ({ ...current, access: new Set(), refresh: new Set() }));
    },
    refreshes: () => tokens.get().refreshes,
    token,
    repository,
    mediaRepository,
    issues: () => issues.get(),
    media: () => media.get(),
    labels: () => labels.get(),
    close: async () => {
      server.closeAllConnections();
      server.close();
      await once(server, "close");
      rmSync(root, { recursive: true, force: true });
    },
  };
};
