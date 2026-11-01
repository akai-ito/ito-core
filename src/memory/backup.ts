import { createCell } from "#cell.ts";
import { toTimestamp, type Cancel, type Clock } from "#clock.ts";
import {
  awaitToken,
  readDeviceToken,
  refreshDeviceToken,
  requestDeviceCode,
  type DeviceCode,
  type Fetch,
} from "#capabilities/connect.ts";
import {
  createGitHub,
  gitAccess,
  githubHosts,
  installUrl,
  memoryConnect,
  newRepositoryUrl,
  pushUrl,
  threadOwnerOf,
  threadRepository,
  withoutCredentials,
  type Created,
  type GitHub,
  type GitHubFailure,
  type GitHubHosts,
  type GitHubUser,
} from "#memory/github.ts";
import type { Memory } from "#memory/memory.ts";
import type { GitAccess } from "#memory/thread.ts";
import type { Health } from "#problems/problems.ts";
import type { MemoryBackup as Status, Problem } from "#protocol/types.ts";
import { fail, ok, type Result } from "#result.ts";
import type { Settings } from "#store/store.ts";
import type { Info } from "#turns/turns.ts";

// Backing memory up to GitHub through Ito Memory, Ito's GitHub app. You approve a code on GitHub;
// the box finds your private ito-thread, or makes it; you install the app on just that repository;
// then memory pushes there after each change, with the app's token, which the box renews itself.
// When it breaks, it says so, and never falls back to this machine's own git credentials.

export type Backup = {
  readonly status: () => Promise<Status>;
  readonly connect: () => Promise<Result<Status, BackupFailure>>;
  readonly disconnect: () => Promise<Status>;
  readonly access: () => Promise<Result<GitAccess, string>>;
  readonly pushed: (outcome: Result<undefined, string>, remote: string) => void;
  readonly start: () => void;
  readonly close: () => Promise<void>;
};

export type BackupFailure = { readonly code: "invalid" | "unavailable"; readonly detail: string };

export type BackupOptions = {
  readonly memory: Pick<Memory, "remote" | "attach" | "detach" | "pushedAt">;
  readonly settings: Settings;
  readonly fetch: Fetch;
  readonly clock: Clock;
  readonly info: Info;
  readonly directory: string;
  readonly report: (health: Health, toProblem: (reason: string, isAuth: boolean) => Problem) => void;
  readonly toProblem: (fix: string) => (reason: string, isAuth: boolean) => Problem;
  readonly hosts?: GitHubHosts;
  readonly checkMs?: number;
};

// Who signed in, and how far along: `isOn` once memory pushes through the app.
type Link = {
  readonly login: string;
  readonly user: number;
  readonly repository?: number;
  readonly created?: boolean;
  readonly isOn: boolean;
};

type Connecting = DeviceCode & { readonly controller: AbortController };

type InstallStep = { readonly url: string; readonly isChosen: boolean; readonly mayBeMissing: boolean };

type Trouble = { readonly reason: string; readonly isAuth: boolean; readonly fix: string };

export const linkSetting = "memory_backup";
export const tokenSetting = "memory_backup_token";

const earlyMs = 60_000;
const hourMs = 60 * 60 * 1000;
const slowCheckMs = 10 * 60 * 1000;
const lookAgainMs = 3000;

const signedOut = "GitHub no longer accepts Ito Memory's sign-in.";

const readLink = (settings: Settings): Link | undefined => {
  const text = settings.setting(linkSetting);
  if (!text) return undefined;
  try {
    const link = JSON.parse(text) as Partial<Link>;
    return typeof link.login === "string" && typeof link.user === "number" ? (link as Link) : undefined;
  } catch {
    return undefined;
  }
};

const firstLine = (text: string): string => {
  const line = text.split("\n").find((candidate) => candidate.trim() !== "") ?? text;
  return line.trim().slice(0, 200);
};

const fullName = ({ login }: Pick<Link, "login">): string => `${login}/${threadRepository}`;

const userOf = ({ user, login }: Link): GitHubUser => ({ id: user, login });

export const createBackup = ({
  memory,
  settings,
  fetch: fetcher,
  clock,
  info,
  directory,
  report,
  toProblem,
  hosts = githubHosts,
  checkMs = 30_000,
}: BackupOptions): Backup => {
  const connect = memoryConnect(hosts);
  const connecting = createCell<Connecting | undefined>(undefined);
  const lastProblem = createCell<string | undefined>(undefined);
  const needsYou = createCell<string | undefined>(undefined);
  const accessFailure = createCell<GitHubFailure | undefined>(undefined);
  const install = createCell<InstallStep | undefined>(undefined);
  const attempted = createCell<ReadonlySet<number>>(new Set());
  // One renewal at a time for each refresh token: using one twice signs Ito out.
  const renewing = createCell<
    { readonly refreshToken: string; readonly renewal: Promise<Result<string, GitHubFailure>> } | undefined
  >(undefined);
  const checking = createCell<Promise<void> | undefined>(undefined);
  const checkTimer = createCell<Cancel | undefined>(undefined);
  const lastCheckAt = createCell(0);
  const waitingSince = createCell<number | undefined>(undefined);
  const signingIn = createCell<Promise<void> | undefined>(undefined);
  const attaching = createCell<Promise<unknown> | undefined>(undefined);
  const isClosed = createCell(false);

  // Work still finishing when the server closes leaves the settings alone.
  const remember = (key: string, value: string): void => {
    if (!isClosed.get()) settings.setSetting(key, value);
  };
  const link = (): Link | undefined => (isClosed.get() ? undefined : readLink(settings));
  const saveLink = (next: Link | undefined): void => {
    remember(linkSetting, next ? JSON.stringify(next) : "");
  };
  const appUrl = (current: Pick<Link, "login">): string => pushUrl(hosts, fullName(current));

  const freshToken = async (): Promise<Result<string, GitHubFailure>> => {
    const token = isClosed.get() ? undefined : readDeviceToken(settings.setting(tokenSetting));
    if (!token) return fail({ reason: signedOut, isAuth: true });
    if (token.expires_at === undefined || token.expires_at - earlyMs > clock.now()) return ok(token.access_token);
    const { refresh_token: refreshToken } = token;
    if (refreshToken === undefined) return fail({ reason: signedOut, isAuth: true });
    const running = renewing.get();
    if (running?.refreshToken === refreshToken) return running.renewal;
    const renewal = (async (): Promise<Result<string, GitHubFailure>> => {
      const renewed = await refreshDeviceToken(connect, refreshToken, fetcher, clock.now());
      if (!renewed.ok) {
        return fail(
          renewed.failure.isRefused
            ? { reason: signedOut, isAuth: true }
            : { reason: renewed.failure.reason, isAuth: false },
        );
      }
      // Disconnected meanwhile: forget the new pair too.
      if (!isClosed.get() && readDeviceToken(settings.setting(tokenSetting))?.refresh_token === refreshToken) {
        settings.setSetting(tokenSetting, JSON.stringify(renewed.value));
      }
      return ok(renewed.value.access_token);
    })();
    renewing.set({ refreshToken, renewal });
    try {
      return await renewal;
    } finally {
      if (renewing.get()?.renewal === renewal) renewing.set(undefined);
    }
  };

  // What a failed push means, in a sentence, and what fixes it.
  const troubleOf = (failure: string, current: Link | undefined, remote: string): Trouble => {
    const place = current?.isOn ? fullName(current) : withoutCredentials(remote);
    const reconnect = current?.isOn
      ? "Connect GitHub again in Settings › Memory."
      : `Check this machine's git credentials can push to ${place}, or back up through GitHub in Settings › Memory instead.`;
    const known = accessFailure.get();
    if (known) return { reason: known.reason, isAuth: known.isAuth, fix: reconnect };
    if (/not found|does not appear to be a git repository/iu.test(failure)) {
      return {
        reason: `GitHub can't find ${place}, or Ito can't reach it.`,
        isAuth: true,
        fix: current?.isOn
          ? `Check ${place} is still there and Ito Memory is installed on it, then connect GitHub again in Settings › Memory.`
          : reconnect,
      };
    }
    if (
      /could not read Username|terminal prompts disabled|Authentication failed|Invalid username or password|Permission to \S+ denied|access denied|error: 40[13]/iu.test(
        failure,
      )
    ) {
      return { reason: `GitHub refused the push to ${place}.`, isAuth: true, fix: reconnect };
    }
    if (/changed both here and on the remote|\[rejected\]|non-fast-forward|fetch first/u.test(failure)) {
      const from = current?.isOn ? `git@github.com:${fullName(current)}.git main` : "";
      return {
        reason: `Memory here and ${place} have both changed since they last matched, and Ito never pushes over changes.`,
        isAuth: true,
        fix:
          `Merge them by hand on the server with git -C ${directory} pull ${from}`.trim() +
          ". Ito then pushes again by itself.",
      };
    }
    return { reason: `The last push failed: ${firstLine(failure)}`, isAuth: false, fix: reconnect };
  };

  const settleTrouble = (trouble: Trouble | undefined): void => {
    needsYou.set(trouble?.isAuth ? trouble.reason : undefined);
    report(
      trouble ? { ok: false, reason: trouble.reason, isAuth: trouble.isAuth } : { ok: true },
      toProblem(trouble?.fix ?? ""),
    );
  };

  const stopChecking = (): void => {
    checkTimer.get()?.();
    checkTimer.set(undefined);
    waitingSince.set(undefined);
  };

  // The app reaches the repository: point the Thread at it and push. The push says how it went.
  const becomeOn = async (current: Link): Promise<void> => {
    const remote = await memory.remote();
    const url = appUrl(current);
    const owner = remote === undefined ? undefined : threadOwnerOf(hosts, remote);
    if (remote !== undefined && remote !== url && owner?.toLowerCase() !== current.login.toLowerCase()) {
      const reason = `The Thread already backs up to ${withoutCredentials(remote)}, so Ito left it as it is.`;
      settleTrouble({
        reason,
        isAuth: true,
        fix: `Remove it on the server with git -C ${directory} remote remove origin, then connect GitHub again in Settings › Memory.`,
      });
      return;
    }
    saveLink({ ...current, isOn: true });
    install.set(undefined);
    stopChecking();
    const pending = memory.attach(url);
    attaching.set(pending);
    const attached = await pending;
    attaching.set(undefined);
    info("Memory backs up to GitHub through Ito Memory", {
      repository: fullName(current),
      ...(!attached.ok && { error: attached.failure }),
    });
  };

  const onGitHubFailure = (failure: GitHubFailure): void => {
    if (failure.isAuth) {
      settleTrouble({ reason: failure.reason, isAuth: true, fix: "Connect GitHub again in Settings › Memory." });
    } else {
      info("GitHub couldn't be asked about memory's backup, so Ito asks again soon", { error: failure.reason });
    }
  };

  const makeRepository = async (
    github: GitHub,
    tryKey: number,
    current: Link,
  ): Promise<Result<Created, GitHubFailure>> => {
    attempted.update((tried) => new Set([...tried, tryKey]));
    const made = await github.create();
    if (made.ok && made.value.kind === "created") {
      saveLink({ ...current, repository: made.value.repository.id, created: true });
      info("Ito made a private repository for memory", { repository: made.value.repository.fullName });
    }
    return made;
  };

  // Looks for the app's installation and the repository, makes the repository when there's none,
  // and moves on once the app can reach it.
  const check = async (): Promise<void> => {
    const current = link();
    if (!current || current.isOn || isClosed.get()) return;
    lastCheckAt.set(clock.now());
    const token = await freshToken();
    if (!token.ok) {
      onGitHubFailure(token.failure);
      return;
    }
    const github = createGitHub(hosts, fetcher, token.value);
    const user = userOf(current);
    const installation = await github.installation(user);
    if (!installation.ok) {
      onGitHubFailure(installation.failure);
      return;
    }
    const found = await github.repository(user);
    if (!found.ok) {
      onGitHubFailure(found.failure);
      return;
    }
    const remote = await memory.remote();
    const isKnown = remote !== undefined && threadOwnerOf(hosts, remote)?.toLowerCase() === user.login.toLowerCase();
    const tryKey = installation.value ?? 0;
    const made =
      isKnown || found.value || attempted.get().has(tryKey) ? undefined : await makeRepository(github, tryKey, current);
    if (made && !made.ok) {
      onGitHubFailure(made.failure);
      return;
    }
    const created = made?.value.kind === "created" ? made.value.repository : undefined;
    const again = created && installation.value !== undefined ? await github.repository(user) : undefined;
    const state = {
      repository: found.value ?? (again?.ok === true ? again.value : undefined),
      id: found.value?.id ?? created?.id ?? current.repository,
      mayBeMissing: made?.value.kind === "refused",
    };
    if (state.repository && !state.repository.isPrivate) {
      settleTrouble({
        reason: `${state.repository.fullName} is public, and memory only goes to a private repository.`,
        isAuth: true,
        fix: `Make ${state.repository.fullName} private on GitHub, under Settings › Danger Zone. Ito carries on by itself.`,
      });
      return;
    }
    // Whatever stopped it before, such as a public repository, is sorted.
    if (needsYou.get() !== undefined) settleTrouble(undefined);
    const latest = link() ?? current;
    if (state.repository && installation.value !== undefined) {
      await becomeOn(latest);
      return;
    }
    if (state.id !== latest.repository) saveLink({ ...latest, repository: state.id });
    install.set({
      url: installUrl(hosts, user, state.id, installation.value),
      isChosen: installation.value === undefined && state.id !== undefined,
      mayBeMissing: state.mayBeMissing || (install.get()?.mayBeMissing === true && state.id === undefined),
    });
  };

  const checkSoon = (): Promise<void> => {
    const running = checking.get();
    if (running) return running;
    const next = (async (): Promise<void> => {
      try {
        await check();
      } catch (error) {
        info("Memory's backup couldn't be checked", { error: String(error) });
      } finally {
        checking.set(undefined);
      }
    })();
    checking.set(next);
    return next;
  };

  // While the app isn't installed yet: every half a minute for an hour, then every ten minutes.
  const scheduleCheck = (): void => {
    if (isClosed.get() || checkTimer.get()) return;
    const current = link();
    if (!current || current.isOn) return;
    const since = waitingSince.get() ?? clock.now();
    waitingSince.set(since);
    checkTimer.set(
      clock.after(clock.now() - since < hourMs ? checkMs : slowCheckMs, () => {
        checkTimer.set(undefined);
        void checkSoon().then(scheduleCheck);
      }),
    );
  };

  const signedIn = async (tokenText: string): Promise<void> => {
    const token = readDeviceToken(tokenText);
    if (!token) return;
    const user = await createGitHub(hosts, fetcher, token.access_token).user();
    if (!user.ok) {
      lastProblem.set(user.failure.reason);
      return;
    }
    const previous = link();
    const isSame = previous?.user === user.value.id;
    remember(tokenSetting, tokenText);
    accessFailure.set(undefined);
    needsYou.set(undefined);
    attempted.set(new Set());
    stopChecking();
    const current: Link = isSame
      ? { ...previous, login: user.value.login }
      : { login: user.value.login, user: user.value.id, isOn: false };
    saveLink(current);
    info("GitHub is connected for memory's backup", { login: user.value.login });
    if (current.isOn) {
      await becomeOn(current);
      return;
    }
    await checkSoon();
    scheduleCheck();
  };

  const status = async (): Promise<Status> => {
    // The first push to the repository, or the first look at GitHub, settles what to show.
    await attaching.get();
    const before = link();
    if (before && !before.isOn && install.get() === undefined && needsYou.get() === undefined) await checkSoon();
    const pushedAt = memory.pushedAt();
    const pushed = pushedAt === undefined ? {} : { pushed_at: pushedAt };
    const waiting = connecting.get();
    if (waiting) {
      return { state: "connecting", code: waiting.code, url: waiting.url, expires_at: toTimestamp(waiting.expiresAt) };
    }
    const current = link();
    const trouble = needsYou.get();
    if (!current) {
      const remote = await memory.remote();
      if (remote === undefined) {
        const problem = lastProblem.get();
        return { state: "off", ...(problem !== undefined && { problem }) };
      }
      const shown = { remote: withoutCredentials(remote), ...pushed };
      return trouble === undefined ? { state: "on", ...shown } : { state: "stopped", ...shown, problem: trouble };
    }
    const repository = fullName(current);
    const shown = {
      repository,
      repository_url: `${hosts.site}/${repository}`,
      ...(current.created === true && { created: true }),
    };
    if (trouble !== undefined) return { state: "stopped", ...shown, ...pushed, problem: trouble };
    if (current.isOn) return { state: "on", ...shown, ...pushed };
    if (clock.now() - lastCheckAt.get() >= lookAgainMs) void checkSoon();
    const step = install.get() ?? {
      url: installUrl(hosts, userOf(current), current.repository, undefined),
      isChosen: current.repository !== undefined,
      mayBeMissing: false,
    };
    return {
      state: "installing",
      ...shown,
      install_url: step.url,
      repository_chosen: step.isChosen,
      ...(step.mayBeMissing && { new_repository_url: newRepositoryUrl(hosts) }),
    };
  };

  return {
    status,
    connect: async () => {
      const remote = await memory.remote();
      const current = link();
      if (
        remote !== undefined &&
        remote !== (current && appUrl(current)) &&
        threadOwnerOf(hosts, remote) === undefined
      ) {
        return fail({
          code: "invalid",
          detail:
            `Memory already backs up to ${withoutCredentials(remote)}, set on the server with ito memory remote. ` +
            `To back up through GitHub instead, remove it there first: git -C ${directory} remote remove origin`,
        });
      }
      connecting.get()?.controller.abort();
      const device = await requestDeviceCode(connect, fetcher, clock.now());
      if (!device.ok) return fail({ code: "unavailable", detail: device.failure });
      const controller = new AbortController();
      connecting.set({ ...device.value, controller });
      lastProblem.set(undefined);
      const signing = (async (): Promise<void> => {
        const token = await awaitToken(connect, device.value, fetcher, clock, controller.signal);
        if (controller.signal.aborted || isClosed.get()) return;
        connecting.set(undefined);
        if (token.ok) await signedIn(token.value);
        else lastProblem.set(token.failure);
      })();
      signingIn.set(signing);
      return ok(await status());
    },
    disconnect: async () => {
      connecting.get()?.controller.abort();
      connecting.set(undefined);
      stopChecking();
      const current = link();
      remember(tokenSetting, "");
      saveLink(undefined);
      lastProblem.set(undefined);
      install.set(undefined);
      accessFailure.set(undefined);
      if (current) {
        if ((await memory.remote()) === appUrl(current)) await memory.detach();
        settleTrouble(undefined);
        info("Memory no longer backs up to GitHub", { repository: fullName(current) });
      }
      return status();
    },
    access: async () => {
      if (!link()?.isOn) return ok({});
      const token = await freshToken();
      accessFailure.set(token.ok ? undefined : token.failure);
      return token.ok ? ok(gitAccess(hosts, token.value)) : fail(token.failure.reason);
    },
    pushed: (outcome, remote) => {
      if (outcome.ok) accessFailure.set(undefined);
      settleTrouble(outcome.ok ? undefined : troubleOf(outcome.failure, link(), remote));
    },
    start: () => {
      void checkSoon().then(scheduleCheck);
    },
    close: async () => {
      isClosed.set(true);
      connecting.get()?.controller.abort();
      stopChecking();
      await Promise.allSettled([signingIn.get(), checking.get()]);
    },
  };
};
