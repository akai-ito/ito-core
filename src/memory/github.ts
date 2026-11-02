import type { DeviceConnect } from "#capabilities/manifest.ts";
import type { Fetch } from "#capabilities/connect.ts";
import { fail, ok, type Result } from "#result.ts";
import { fieldOf } from "#tools/input.ts";
import { packageVersion } from "#version.ts";

// The GitHub that memory backs up to: the site, for signing in, installing and git, and its API.
export type GitHubHosts = { readonly site: string; readonly api: string };

export const githubHosts: GitHubHosts = { site: "https://github.com", api: "https://api.github.com" };

// Ito Memory, the GitHub App that backs memory up: it can read and write the contents of the
// repositories it's installed on, and make the repository when there isn't one.
export const memoryApp = { slug: "ito-memory", clientId: "Iv23lie6pjPXcZlkN5An" } as const;

export const threadRepository = "ito-thread";

export const memoryConnect = (hosts: GitHubHosts): DeviceConnect => ({
  kind: "oauth_device",
  title: "Connect GitHub",
  deviceUrl: `${hosts.site}/login/device/code`,
  tokenUrl: `${hosts.site}/login/oauth/access_token`,
  clientId: memoryApp.clientId,
});

export type GitHubUser = { readonly id: number; readonly login: string };

export type GitHubRepository = { readonly id: number; readonly fullName: string; readonly isPrivate: boolean };

export type Created =
  | { readonly kind: "created"; readonly repository: GitHubRepository }
  | { readonly kind: "exists" }
  | { readonly kind: "refused" };

// `isAuth`: GitHub turned the token away, so only signing in again helps.
export type GitHubFailure = { readonly reason: string; readonly isAuth: boolean };

export type GitHub = {
  readonly user: () => Promise<Result<GitHubUser, GitHubFailure>>;
  readonly installation: (user: GitHubUser) => Promise<Result<number | undefined, GitHubFailure>>;
  readonly repository: (user: GitHubUser) => Promise<Result<GitHubRepository | undefined, GitHubFailure>>;
  readonly create: () => Promise<Result<Created, GitHubFailure>>;
};

type Answer = { readonly status: number; readonly body: unknown };

const answerMs = 30_000;

const toRepository = (body: unknown): GitHubRepository | undefined => {
  const id = fieldOf(body, "id");
  const fullName = fieldOf(body, "full_name");
  return typeof id === "number" && typeof fullName === "string"
    ? { id, fullName, isPrivate: fieldOf(body, "private") === true }
    : undefined;
};

const unexpected = ({ status, body }: Answer): GitHubFailure => {
  const message = fieldOf(body, "message");
  return {
    reason: `GitHub answered ${String(status)}${typeof message === "string" ? `: ${message}` : "."}`,
    isAuth: false,
  };
};

export const createGitHub = (hosts: GitHubHosts, fetcher: Fetch, token: string): GitHub => {
  const call = async (method: string, route: string, body?: unknown): Promise<Result<Answer, GitHubFailure>> => {
    try {
      const response = await fetcher(`${hosts.api}${route}`, {
        method,
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${token}`,
          "user-agent": `ito/${packageVersion()}`,
          "x-github-api-version": "2022-11-28",
          ...(body !== undefined && { "content-type": "application/json" }),
        },
        ...(body !== undefined && { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(answerMs),
      });
      if (response.status === 401)
        return fail({ reason: "GitHub no longer accepts Ito Memory's sign-in.", isAuth: true });
      const text = await response.text();
      return ok({ status: response.status, body: text === "" ? undefined : (JSON.parse(text) as unknown) });
    } catch (error) {
      return fail({ reason: `GitHub couldn't be reached: ${String(error)}`, isAuth: false });
    }
  };

  return {
    user: async () => {
      const answered = await call("GET", "/user");
      if (!answered.ok) return answered;
      const id = fieldOf(answered.value.body, "id");
      const login = fieldOf(answered.value.body, "login");
      return typeof id === "number" && typeof login === "string" && answered.value.status === 200
        ? ok({ id, login })
        : fail(unexpected(answered.value));
    },
    // Ito Memory's installation on the person's own account, if there is one.
    installation: async (user) => {
      const answered = await call("GET", "/user/installations?per_page=100");
      if (!answered.ok) return answered;
      if (answered.value.status !== 200) return fail(unexpected(answered.value));
      const listed = fieldOf(answered.value.body, "installations");
      const found = (Array.isArray(listed) ? (listed as readonly unknown[]) : []).find(
        (installation) => fieldOf(fieldOf(installation, "account"), "id") === user.id,
      );
      const id = fieldOf(found, "id");
      return ok(typeof id === "number" ? id : undefined);
    },
    // Their ito-thread, as Ito Memory sees it: a private one shows only once the app can reach it.
    repository: async (user) => {
      const answered = await call("GET", `/repos/${encodeURIComponent(user.login)}/${threadRepository}`);
      if (!answered.ok) return answered;
      if (answered.value.status === 404) return ok(undefined);
      const repository = toRepository(answered.value.body);
      return repository && answered.value.status === 200 ? ok(repository) : fail(unexpected(answered.value));
    },
    create: async () => {
      const answered = await call("POST", "/user/repos", {
        name: threadRepository,
        private: true,
        description: "What Ari remembers, backed up by Ito.",
      });
      if (!answered.ok) return answered;
      const { status, body } = answered.value;
      const repository = toRepository(body);
      if (status === 201 && repository) return ok({ kind: "created", repository });
      if (status === 422) return ok({ kind: "exists" });
      if (status === 403 || status === 404) return ok({ kind: "refused" });
      return fail(unexpected(answered.value));
    },
  };
};

// Where to install Ito Memory: with the repository chosen when its id is known, or, when the app
// is already installed, its settings, to add the repository there.
export const installUrl = (
  hosts: GitHubHosts,
  user: GitHubUser,
  repository: number | undefined,
  installation: number | undefined,
): string =>
  installation === undefined
    ? `${hosts.site}/apps/${memoryApp.slug}/installations/new/permissions?suggested_target_id=${String(user.id)}` +
      (repository === undefined ? "" : `&repository_ids[]=${String(repository)}`)
    : `${hosts.site}/settings/installations/${String(installation)}`;

export const newRepositoryUrl = (hosts: GitHubHosts): string =>
  `${hosts.site}/new?name=${threadRepository}&visibility=private`;

export const pushUrl = (hosts: GitHubHosts, fullName: string): string => `${hosts.site}/${fullName}.git`;

// Git sends the token to GitHub alone, from the environment: never on a command line, never in
// the Thread's config, and with no credential helper or prompt to fall back to.
export const gitAccess = (hosts: GitHubHosts, token: string): Readonly<Record<string, string>> => ({
  GIT_CONFIG_COUNT: "2",
  GIT_CONFIG_KEY_0: `http.${new URL(hosts.site).origin}/.extraHeader`,
  GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
  GIT_CONFIG_KEY_1: "credential.helper",
  GIT_CONFIG_VALUE_1: "",
  GIT_ASKPASS: "",
  SSH_ASKPASS: "",
});

// The owner of a GitHub ito-thread remote, in any of the usual forms, or undefined for any other.
export const threadOwnerOf = (hosts: GitHubHosts, url: string): string | undefined => {
  const host = new URL(hosts.site).host.replaceAll(".", String.raw`\.`);
  const pattern = new RegExp(
    String.raw`^(?:https?://(?:[^@/]+@)?${host}/|git@${host}:|ssh://git@${host}/)([^/]+)/${threadRepository}(?:\.git)?/?$`,
    "iu",
  );
  return pattern.exec(url)?.[1];
};

// A remote as it's safe to show: without a password or token in it.
export const withoutCredentials = (url: string): string => url.replace(/^(https?:\/\/)[^@/]+@/u, "$1");
