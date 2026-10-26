import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { createCell } from "#cell.ts";
import { splitCommand } from "#capabilities/commands.ts";
import { createDoors } from "#capabilities/doors.ts";
import { createHost, onSetting, valuesSetting, type Host } from "#capabilities/host.ts";
import { findInstalled } from "#capabilities/installed.ts";
import { createSecrets } from "#conversation/secrets.ts";
import type { Settings } from "#store/store.ts";
import { createVirtualClock, type VirtualClock } from "./support/virtual-clock.ts";

const home = mkdtempSync(path.join(os.tmpdir(), "ito-capabilities-"));
const installed = findInstalled(path.join(import.meta.dirname, "support", "capabilities")).filter(
  ({ id }) => id === "echo",
);
const hosts = createCell<readonly Host[]>([]);
const logged = createCell<readonly string[]>([]);

const createMemorySettings = (entries: readonly (readonly [string, string])[] = []): Settings => {
  const current = createCell<ReadonlyMap<string, string>>(new Map(entries));
  return {
    setting: (key) => current.get().get(key),
    setSetting: (key, value) => {
      current.set(new Map([...current.get(), [key, value]]));
    },
  };
};

const switchedOn = (values: Readonly<Record<string, unknown>>): readonly (readonly [string, string])[] => [
  [onSetting("echo"), "true"],
  [valuesSetting("echo"), JSON.stringify(values)],
];

const startHost = async (
  settings: Settings,
  clock: VirtualClock = createVirtualClock(0),
): Promise<{ readonly host: Host; readonly folder: string }> => {
  const folders = mkdtempSync(path.join(home, "folders-"));
  const host = createHost({
    installed,
    server: { version: "0.6.0", engine: "Codex test" },
    settings,
    folders,
    clock,
    info: (message) => {
      logged.update((current) => [...current, message]);
    },
  });
  hosts.update((current) => [...current, host]);
  await host.ready;
  return { host, folder: path.join(folders, "echo") };
};

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const pidIn = (folder: string): number => Number(readFileSync(path.join(folder, "pid"), "utf8"));

const isRunningAgain = async (host: Host): Promise<void> => {
  await vi.waitFor(async () => {
    await expect(host.call("echo", "say", { text: "back?" })).resolves.toMatchObject({ ok: true });
  });
};

afterEach(async () => {
  await Promise.all(hosts.get().map((host) => host.close()));
  hosts.set([]);
});

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("capability host", () => {
  it("starts nothing that's off, but still knows its manifest", async () => {
    const { host, folder } = await startHost(createMemorySettings());

    expect(host.list()).toMatchObject([{ id: "echo", state: "off", manifest: { title: "Echo" } }]);
    expect(existsSync(path.join(folder, "pid"))).toBe(false);
    expect(await host.call("echo", "say", { text: "hi" })).toEqual({
      ok: false,
      failure: "Echo is off. The person can switch it on in Ari's Settings › Capabilities.",
    });
  });

  it("waits for setup, then runs with only its own values, its folder and a small environment", async () => {
    const { host, folder } = await startHost(createMemorySettings([[onSetting("echo"), "true"]]));
    expect(host.find("echo")?.state).toBe("setup");

    const saved = await host.setUp("echo", { token: "secret-1", loud: true });
    const inspected = await host.call("echo", "inspect", {});

    expect(saved).toMatchObject({ ok: true, value: { state: "on" } });
    expect(inspected).toMatchObject({ ok: true, value: { data: { values: { token: "secret-1", loud: true } } } });
    const given = inspected.ok ? inspected.value.data : undefined;
    expect(given?.cwd).toBe(folder);
    expect(given?.environment).not.toContain("ITO_HOME");
    expect(given?.environment).not.toContain("VITEST");
    expect(await host.call("echo", "say", { text: "hi" })).toEqual({ ok: true, value: { text: "HI" } });
  });

  it("stops the process when switched off, and refuses calls at once", async () => {
    const { host, folder } = await startHost(createMemorySettings(switchedOn({ token: "secret-1" })));
    const pid = pidIn(folder);

    const switched = await host.switchTo("echo", false);

    expect(switched).toMatchObject({ ok: true, value: { state: "off" } });
    expect(isAlive(pid)).toBe(false);
    await expect(host.call("echo", "say", { text: "hi" })).resolves.toMatchObject({ ok: false });
  });

  it("shows a rejected setup as needing you, until the setup changes", async () => {
    const { host } = await startHost(createMemorySettings(switchedOn({ token: "wrong" })));

    expect(host.find("echo")).toMatchObject({ state: "needs_you", detail: "The token was rejected." });
    expect(await host.check("echo", { token: "wrong" })).toEqual({ ok: true, value: "That token is wrong." });
    expect(await host.check("echo", { token: "secret-2" })).toEqual({ ok: true, value: undefined });

    expect(await host.setUp("echo", { token: "secret-2" })).toMatchObject({ ok: true, value: { state: "on" } });
  });

  it("rejects setup values its fields don't allow", async () => {
    const { host } = await startHost(createMemorySettings());

    expect(await host.setUp("echo", { colour: "red" })).toEqual({
      ok: false,
      failure: { code: "invalid_values", detail: "Echo has no setup field called colour." },
    });
    expect(await host.setUp("echo", { loud: "yes" })).toEqual({
      ok: false,
      failure: { code: "invalid_values", detail: "loud takes true or false." },
    });
  });

  it("shows what a running capability says about itself", async () => {
    const { host } = await startHost(createMemorySettings(switchedOn({ token: "secret-1" })));

    await host.call("echo", "complain", {});

    expect(host.find("echo")).toMatchObject({ state: "needs_you", detail: "The token stopped working." });
  });

  it("restarts a crashed capability with backoff, and gives up after five crashes in ten minutes", async () => {
    const clock = createVirtualClock(0);
    const { host } = await startHost(createMemorySettings(switchedOn({ token: "secret-1" })), clock);
    const delays = createCell<readonly number[]>([]);

    const crashAndWait = async (): Promise<void> => {
      await host.call("echo", "crash", {});
      await vi.waitFor(async () => {
        await expect(host.call("echo", "say", { text: "?" })).resolves.toEqual({
          ok: false,
          failure: "Echo is restarting. Try again in a moment.",
        });
      });
    };

    await [1, 2, 3, 4].reduce(async (previous) => {
      await previous;
      await crashAndWait();
      const before = clock.now();
      clock.runNext(Infinity);
      delays.update((current) => [...current, clock.now() - before]);
      await isRunningAgain(host);
    }, Promise.resolve());
    await host.call("echo", "crash", {});
    await vi.waitFor(() => {
      expect(host.find("echo")?.state).toBe("needs_you");
    });

    expect(delays.get()).toEqual([1000, 2000, 4000, 8000]);
    expect(host.find("echo")?.detail).toBe("echo was killed by SIGKILL.");
    expect(logged.get()).toContain("A capability stopped unexpectedly");
    expect(await host.switchTo("echo", true)).toMatchObject({ ok: true, value: { state: "on" } });
  });

  it("cancels a call it gives up on", async () => {
    const { host } = await startHost(createMemorySettings(switchedOn({ token: "secret-1" })));
    const controller = new AbortController();

    const waiting = host.call("echo", "wait", {}, { signal: controller.signal });
    controller.abort();

    expect(await waiting).toEqual({ ok: false, failure: "Cancelled." });
  });

  it("offers the operations of capabilities that are on and set up", async () => {
    const { host } = await startHost(createMemorySettings(switchedOn({ token: "secret-1" })));
    const changes = createCell(0);
    host.subscribe(() => {
      changes.update((count) => count + 1);
    });

    expect(host.offered().map(({ id }) => id)).toEqual(["echo"]);
    await host.switchTo("echo", false);

    expect(host.offered()).toEqual([]);
    expect(changes.get()).toBe(1);
  });
});

describe("the agent's doors to a capability", () => {
  it.each([
    ["ito echo say --text hi", ["ito", "echo", "say", "--text", "hi"]],
    [`ito echo say --text "hi there" --loud`, ["ito", "echo", "say", "--text", "hi there", "--loud"]],
    [`ito echo say --text='it'"'"'s'`, ["ito", "echo", "say", "--text=it's"]],
    ["ito echo say --text hi | head -1", undefined],
    ["ito echo say --text $(whoami)", undefined],
  ])("reads %s as words, unless the shell would do more", (command, words) => {
    expect(splitCommand(command)).toEqual(words);
  });

  it("runs a command from its words, and explains it on --help or a mistake", async () => {
    const { host } = await startHost(createMemorySettings(switchedOn({ token: "secret-1" })));
    const doors = createDoors({ host, secrets: createSecrets(), currentTurn: () => "t_test", command: "ito" });

    expect(await doors.command("echo", ["say", "--text", "hi"])).toEqual({ ok: true, value: "hi" });
    expect(await doors.command("echo", ["say", "--help"])).toEqual({
      ok: true,
      value: "ito echo say: Says the text back.\n  --text <string> (required)",
    });
    expect(await doors.command("echo", ["say", "--txet", "hi"])).toEqual({
      ok: false,
      failure: "There's no --txet here.\n\nito echo say: Says the text back.\n  --text <string> (required)",
    });
    expect(doors.tools().map(({ name }) => name)).toEqual(["echo_say"]);
  });

  it("keeps secret answers out of what a publishing operation receives", async () => {
    const { host } = await startHost(createMemorySettings(switchedOn({ token: "secret-1" })));
    const secrets = createSecrets();
    secrets.add("hunter22");
    const doors = createDoors({ host, secrets, currentTurn: () => "t_test", command: "ito" });

    expect(await doors.command("echo", ["publish", "--text", "my code is hunter22"])).toEqual({
      ok: true,
      value: "my code is ••••••",
    });
    expect(await doors.command("echo", ["say", "--text", "my code is hunter22"])).toEqual({
      ok: true,
      value: "my code is hunter22",
    });
  });
});
