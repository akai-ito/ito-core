import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { createCell } from "#cell.ts";
import { systemClock } from "#clock.ts";
import { demoAnswers, demoScripts } from "#engine/scripted/demo.ts";
import { createScriptEngine } from "#engine/scripted/script-engine.ts";
import { hashToken, tokenSetting as apiTokenSetting } from "#http/auth.ts";
import { createBackup, tokenSetting, type Backup } from "#memory/backup.ts";
import { wordEmbedder } from "#memory/embedder.ts";
import { createMemory, type Memory } from "#memory/memory.ts";
import { openThread } from "#memory/thread.ts";
import { createProblems, memoryBackupId, memoryBackupProblem } from "#problems/problems.ts";
import type { MemoryBackup, Problem } from "#protocol/types.ts";
import { randomIdentifiers } from "#identifiers.ts";
import { createServer } from "#server.ts";
import { openDatabase } from "#store/database.ts";
import { createMemoryStore } from "#store/memory.ts";
import { createStore, type Store } from "#store/store.ts";
import { startFakeGitHub, type FakeGitHub } from "./support/fake-github.ts";
import { createVirtualClock } from "./support/virtual-clock.ts";

const home = mkdtempSync(path.join(os.tmpdir(), "ito-backup-"));
const closers = createCell<readonly (() => Promise<void>)[]>([]);

type Rig = {
  readonly memory: Memory;
  readonly backup: Backup;
  readonly store: Store;
  readonly thread: string;
  readonly problems: () => readonly Problem[];
};

const git = (directory: string, ...arguments_: readonly string[]): string =>
  execFileSync("git", ["-C", directory, ...arguments_], { encoding: "utf8" });

const subjects = (bare: string): string => git(bare, "log", "--format=%s", "main");

const startGitHub = async (options?: Parameters<typeof startFakeGitHub>[0]): Promise<FakeGitHub> => {
  const fake = await startFakeGitHub(options);
  closers.update((current) => [...current, fake.close]);
  return fake;
};

const openRig = async (fake: FakeGitHub): Promise<Rig> => {
  const directory = mkdtempSync(path.join(home, "home-"));
  const database = openDatabase(path.join(directory, "ito.db"));
  const store = createStore(database, systemClock, randomIdentifiers);
  const published = createCell<readonly Problem[]>([]);
  const problems = createProblems({
    clock: systemClock,
    standing: () => [],
    publish: (current) => {
      published.set(current);
    },
  });
  const thread = path.join(directory, "thread");
  const backups = createCell<Backup | undefined>(undefined);
  const memory = createMemory({
    directory: thread,
    store: createMemoryStore(database),
    settings: store,
    clock: systemClock,
    identifiers: randomIdentifiers,
    embedder: wordEmbedder,
    recordStep: () => true,
    approve: () => Promise.resolve(true),
    info: () => true,
    timeZone: () => "UTC",
    pushDelayMs: 20,
    remote: {
      access: async () => {
        const backup = backups.get();
        if (!backup) throw new Error("No backup yet.");
        return backup.access();
      },
      pushed: (outcome, remote) => {
        backups.get()?.pushed(outcome, remote);
      },
    },
  });
  const backup = createBackup({
    memory,
    settings: store,
    fetch,
    clock: systemClock,
    info: () => true,
    directory: thread,
    report: (health, toProblem) => {
      problems.report(memoryBackupId, health, toProblem);
    },
    toProblem: memoryBackupProblem,
    hosts: { site: fake.apiUrl, api: fake.apiUrl },
    checkMs: 20,
  });
  backups.set(backup);
  closers.update((current) => [
    ...current,
    async () => {
      await backup.close();
      problems.close();
      await memory.close();
      store.close();
    },
  ]);
  await memory.ready;
  return { memory, backup, store, thread, problems: () => published.get() };
};

const page = (address: string, title: string, markdown: string): Parameters<Memory["seed"]>[0] => ({
  address,
  title,
  gist: title,
  aliases: [],
  links: [],
  markdown,
});

const until = async (backup: Backup, state: MemoryBackup["state"]): Promise<MemoryBackup> =>
  vi.waitFor(
    async () => {
      const status = await backup.status();
      expect(status.state).toBe(state);
      return status;
    },
    { timeout: 8000, interval: 20 },
  );

// Commits a page to the repository from somewhere else, as merging a pull request on GitHub would.
const commitElsewhere = (bare: string, file: string, text: string): void => {
  const elsewhere = mkdtempSync(path.join(home, "elsewhere-"));
  git(home, "clone", "--quiet", bare, elsewhere);
  mkdirSync(path.dirname(path.join(elsewhere, file)), { recursive: true });
  writeFileSync(path.join(elsewhere, file), text);
  git(elsewhere, "add", file);
  git(elsewhere, "-c", "user.name=Robin Vale", "-c", "user.email=robin@example.com", "commit", "--quiet", "-m", file);
  git(elsewhere, "push", "--quiet", "origin", "HEAD:main");
};

afterEach(async () => {
  for (const close of closers.get().toReversed()) await close();
  closers.set([]);
});

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("memory backup through Ito Memory", () => {
  it("makes a private ito-thread, waits for the app on just that repository, then pushes after each change", async () => {
    const fake = await startGitHub();
    const rig = await openRig(fake);
    await rig.memory.seed(page("memory:people/sam", "Sam", "A friend from running."));

    const started = await rig.backup.connect();
    expect(started).toMatchObject({
      ok: true,
      value: { state: "connecting", code: fake.userCode, url: "https://github.com/login/device" },
    });
    fake.approve();

    expect(await until(rig.backup, "installing")).toEqual({
      state: "installing",
      repository: "octo-person/ito-thread",
      repository_url: `${fake.apiUrl}/octo-person/ito-thread`,
      created: true,
      install_url: `${fake.apiUrl}/apps/ito-memory/installations/new/permissions?suggested_target_id=4242&repository_ids[]=9000`,
      repository_chosen: true,
    });
    const bare = fake.repositories().get("ito-thread");
    expect(bare).toMatchObject({ id: 9000, isPrivate: true });

    fake.install(["ito-thread"]);
    expect(await until(rig.backup, "on")).toMatchObject({
      repository: "octo-person/ito-thread",
      created: true,
      pushed_at: expect.any(String) as unknown,
    });
    expect(subjects(bare?.directory ?? "")).toContain("Add Sam");

    await rig.memory.seed(page("memory:places/harbour", "The Harbour", "Where Sam's club meets."));
    await vi.waitFor(() => {
      expect(subjects(bare?.directory ?? "")).toContain("Add The Harbour");
    });
    expect(git(rig.thread, "remote", "get-url", "origin").trim()).toBe(`${fake.apiUrl}/octo-person/ito-thread.git`);
    expect(readFileSync(path.join(rig.thread, ".git", "config"), "utf8")).not.toContain("ghu_");

    expect(await rig.backup.disconnect()).toEqual({ state: "off" });
    expect(rig.store.setting(tokenSetting)).toBe("");
    expect(await rig.memory.remote()).toBeUndefined();
    expect(subjects(bare?.directory ?? "")).toContain("Add The Harbour");
  });

  it("carries on with an existing ito-thread, fast-forwards to what's new there, and never pushes over both sides", async () => {
    const fake = await startGitHub({ createNeedsInstall: true });
    const remote = fake.addRepository("ito-thread");
    const rig = await openRig(fake);
    await rig.memory.seed(page("memory:people/sam", "Sam", "A friend from running."));
    await delay(100);
    git(rig.thread, "push", "--quiet", remote.directory, "HEAD:main");
    git(rig.thread, "remote", "add", "origin", `git@${new URL(fake.apiUrl).host}:octo-person/ito-thread.git`);

    await rig.backup.connect();
    fake.approve();
    expect(await until(rig.backup, "installing")).toEqual({
      state: "installing",
      repository: "octo-person/ito-thread",
      repository_url: `${fake.apiUrl}/octo-person/ito-thread`,
      install_url: `${fake.apiUrl}/apps/ito-memory/installations/new/permissions?suggested_target_id=4242`,
      repository_chosen: false,
    });

    commitElsewhere(remote.directory, "places/harbour.md", "---\ntitle: The Harbour\n---\n\nWhere the club meets.\n");
    fake.install(["ito-thread"]);
    await until(rig.backup, "on");
    expect(rig.memory.page("memory:places/harbour")).toMatchObject({ ok: true, value: { title: "The Harbour" } });
    expect(git(rig.thread, "remote", "get-url", "origin").trim()).toBe(`${fake.apiUrl}/octo-person/ito-thread.git`);

    commitElsewhere(remote.directory, "places/pier.md", "---\ntitle: The Pier\n---\n\nThe long walk.\n");
    const before = git(remote.directory, "rev-parse", "main");
    await rig.memory.seed(page("memory:people/ada", "Ada", "Sam's sister."));
    const stopped = await until(rig.backup, "stopped");
    expect(stopped.problem).toContain("have both changed since they last matched");
    expect(git(remote.directory, "rev-parse", "main")).toBe(before);
    expect(rig.problems()).toEqual([
      expect.objectContaining({
        id: "memory:backup",
        area: "memory",
        title: "Memory isn't backed up",
        fix: `Merge them by hand on the server with git -C ${rig.thread} pull git@github.com:octo-person/ito-thread.git main. Ito then pushes again by itself.`,
      }),
    ]);
  });

  it("sends you to make ito-thread when the app can't yet, and to add a made one the install left out", async () => {
    const fake = await startGitHub({ createNeedsInstall: true, createdJoinsInstall: false });
    const rig = await openRig(fake);

    await rig.backup.connect();
    fake.approve();
    expect(await until(rig.backup, "installing")).toEqual({
      state: "installing",
      repository: "octo-person/ito-thread",
      repository_url: `${fake.apiUrl}/octo-person/ito-thread`,
      install_url: `${fake.apiUrl}/apps/ito-memory/installations/new/permissions?suggested_target_id=4242`,
      repository_chosen: false,
      new_repository_url: `${fake.apiUrl}/new?name=ito-thread&visibility=private`,
    });

    fake.install([]);
    await vi.waitFor(async () => {
      expect(await rig.backup.status()).toEqual({
        state: "installing",
        repository: "octo-person/ito-thread",
        repository_url: `${fake.apiUrl}/octo-person/ito-thread`,
        created: true,
        install_url: `${fake.apiUrl}/settings/installations/${String(fake.installationId)}`,
        repository_chosen: false,
      });
    });

    fake.install(["ito-thread"]);
    await until(rig.backup, "on");
    expect(subjects(fake.repositories().get("ito-thread")?.directory ?? "")).toContain("Start the Thread");
  });

  it("renews its token itself, and says plainly when GitHub stops accepting it, until you connect again", async () => {
    const fake = await startGitHub({ expiresIn: 30 });
    const rig = await openRig(fake);
    await rig.backup.connect();
    fake.approve();
    await until(rig.backup, "installing");
    fake.install("all");
    await until(rig.backup, "on");
    const bare = fake.repositories().get("ito-thread")?.directory ?? "";

    await rig.memory.seed(page("memory:people/sam", "Sam", "A friend from running."));
    await vi.waitFor(() => {
      expect(subjects(bare)).toContain("Add Sam");
    });
    expect(fake.refreshes()).toBeGreaterThan(0);

    fake.revoke();
    await rig.memory.seed(page("memory:people/ada", "Ada", "Sam's sister."));
    expect(await until(rig.backup, "stopped")).toMatchObject({
      repository: "octo-person/ito-thread",
      problem: "GitHub no longer accepts Ito Memory's sign-in.",
    });
    expect(rig.problems()).toMatchObject([{ id: "memory:backup", fix: "Connect GitHub again in Settings › Memory." }]);
    expect(subjects(bare)).not.toContain("Add Ada");

    await rig.backup.connect();
    await until(rig.backup, "on");
    await vi.waitFor(() => {
      expect(subjects(bare)).toContain("Add Ada");
      expect(rig.problems()).toEqual([]);
    });
  });

  it("leaves a backup set with ito memory remote alone, and never shows a password in it", async () => {
    const fake = await startGitHub();
    const rig = await openRig(fake);
    git(rig.thread, "remote", "add", "origin", "https://robin:hunter2@git.example.com/robin/notes.git");

    expect(await rig.backup.status()).toEqual({ state: "on", remote: "https://git.example.com/robin/notes.git" });
    expect(await rig.backup.connect()).toEqual({
      ok: false,
      failure: {
        code: "invalid",
        detail:
          "Memory already backs up to https://git.example.com/robin/notes.git, set on the server with ito memory " +
          `remote. To back up through GitHub instead, remove it there first: git -C ${rig.thread} remote remove origin`,
      },
    });
    expect(await rig.backup.disconnect()).toEqual({ state: "on", remote: "https://git.example.com/robin/notes.git" });
  });
});

describe("the Thread's remote", () => {
  it("counts an empty remote as current, and a Thread with nothing in it takes on a backup's history", async () => {
    const directory = mkdtempSync(path.join(home, "thread-"));
    const remote = path.join(directory, "remote.git");
    git(directory, "init", "--quiet", "--bare", "--initial-branch=main", remote);
    const first = await openThread(path.join(directory, "first"));
    await first.setRemote(remote);
    expect(await first.pull()).toEqual({ ok: true, value: "current" });
    await first.write("people/sam.md", "---\ntitle: Sam\n---\n\nA friend.\n", "Add Sam");
    expect(await first.push()).toEqual({ ok: true, value: undefined });

    const restored = await openThread(path.join(directory, "restored"));
    await restored.setRemote(remote);
    expect(await restored.pull()).toEqual({ ok: true, value: "pulled" });
    expect(restored.files()).toEqual(["people/sam.md"]);

    const busy = await openThread(path.join(directory, "busy"));
    await busy.write("people/ada.md", "---\ntitle: Ada\n---\n\nA neighbour.\n", "Add Ada");
    await busy.setRemote(remote);
    expect(await busy.pull()).toMatchObject({ ok: false });
    expect(busy.files()).toEqual(["people/ada.md"]);
  });
});

describe("memory backup over the API", () => {
  it("starts with a code to enter, and disconnects to off", async () => {
    const fake = await startGitHub();
    const token = "ito_backup_test_not_a_real_token_00000000000000000000000";
    const server = createServer({
      dataDirectory: mkdtempSync(path.join(home, "server-")),
      name: "backup",
      embedder: wordEmbedder,
      timeZone: "UTC",
      createEngine: ({ callTool }) =>
        createScriptEngine(createVirtualClock(0), demoScripts, callTool, undefined, demoAnswers),
      github: { site: fake.apiUrl, api: fake.apiUrl },
    });
    server.store.setSetting(apiTokenSetting, hashToken(token));
    const send = async (method: "GET" | "POST" | "DELETE"): Promise<{ status: number; body: unknown }> => {
      const response = await server.app.inject({
        method,
        url: "/v0/memory/backup",
        headers: { authorization: `Bearer ${token}` },
      });
      return { status: response.statusCode, body: response.json() };
    };
    try {
      expect(await send("GET")).toEqual({ status: 200, body: { state: "off" } });
      expect(await send("POST")).toEqual({
        status: 200,
        body: {
          state: "connecting",
          code: fake.userCode,
          url: "https://github.com/login/device",
          expires_at: expect.any(String) as unknown,
        },
      });
      expect(await send("DELETE")).toEqual({ status: 200, body: { state: "off" } });
    } finally {
      await server.close();
    }
  });
});
