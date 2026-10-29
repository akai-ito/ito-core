import path from "node:path";
import { createCell } from "#cell.ts";
import type { Cancel, Clock } from "#clock.ts";
import {
  isComplete,
  toValues,
  type CallResult,
  type Manifest,
  type Server,
  type Status,
  type Values,
} from "#capabilities/manifest.ts";
import { startCapabilityProcess, type CapabilityProcess } from "#capabilities/process.ts";
import { recentCrashes, toRestartDecision } from "#capabilities/restarts.ts";
import { fail, ok, type Result } from "#result.ts";
import type { Settings } from "#store/store.ts";
import type { Info } from "#turns/turns.ts";

export type Installed = { readonly id: string; readonly entry: string };

export type CapabilityState = "off" | "setup" | "on" | "needs_you";

export type Capability = {
  readonly id: string;
  readonly manifest?: Manifest;
  readonly state: CapabilityState;
  readonly detail?: string;
  readonly values: Values;
};

export type Offered = Capability & { readonly manifest: Manifest };

export type CallContext = { readonly turn?: string; readonly signal?: AbortSignal };

export type HostFailure = { readonly code: "not_found" | "invalid_values"; readonly detail: string };

export type Host = {
  readonly ready: Promise<void>;
  readonly list: () => readonly Capability[];
  readonly find: (id: string) => Capability | undefined;
  readonly offered: () => readonly Offered[];
  readonly switchTo: (id: string, on: boolean) => Promise<Result<Capability, HostFailure>>;
  readonly setUp: (id: string, values: Values) => Promise<Result<Capability, HostFailure>>;
  readonly check: (id: string, values: Values) => Promise<Result<string | undefined, HostFailure>>;
  readonly call: (
    id: string,
    operation: string,
    input: unknown,
    context?: CallContext,
  ) => Promise<Result<CallResult, string>>;
  readonly subscribe: (listener: () => void) => () => void;
  readonly close: () => Promise<void>;
};

export type HostOptions = {
  readonly installed: readonly Installed[];
  readonly server: Server;
  readonly settings: Settings;
  readonly folders: string;
  readonly clock: Clock;
  readonly info: Info;
};

type Runner = {
  readonly manifest?: Manifest;
  readonly process?: CapabilityProcess;
  readonly restart?: Cancel;
  readonly crashes: readonly number[];
  readonly problem?: string;
  readonly status?: Status;
};

const idle: Runner = { crashes: [] };

export const onSetting = (id: string): string => `capability:${id}:on`;

export const valuesSetting = (id: string): string => `capability:${id}:values`;

const parseValues = (text: string | undefined): Values => {
  if (text === undefined) return {};
  try {
    return JSON.parse(text) as Values;
  } catch {
    return {};
  }
};

export const toState = (
  isOn: boolean,
  runner: Runner,
  values: Values,
): { readonly state: CapabilityState; readonly detail?: string } => {
  if (!isOn) return { state: "off" };
  if (!runner.manifest) return { state: "needs_you", detail: runner.problem ?? "It hasn't started yet." };
  if (!isComplete(runner.manifest, values)) return { state: "setup" };
  if (runner.problem !== undefined) return { state: "needs_you", detail: runner.problem };
  return runner.status?.state === "needs_you"
    ? { state: "needs_you", ...(runner.status.detail !== undefined && { detail: runner.status.detail }) }
    : { state: "on" };
};

const unavailable = (title: string, { state, detail = "it isn't working" }: Capability): string => {
  switch (state) {
    case "off": {
      return `${title} is off. The person can switch it on in Ari's Settings › Capabilities.`;
    }
    case "setup": {
      return `${title} isn't set up yet. The person can set it up in Ari's Settings › Capabilities.`;
    }
    case "needs_you": {
      return `${title} needs the person: ${detail}`;
    }
    case "on": {
      return `${title} is restarting. Try again in a moment.`;
    }
  }
};

const notFound = (id: string): Result<never, HostFailure> =>
  fail({ code: "not_found", detail: `No capability called ${id} is installed.` });

export const createHost = ({ installed, server, settings, folders, clock, info }: HostOptions): Host => {
  const runners = createCell<ReadonlyMap<string, Runner>>(new Map(installed.map(({ id }) => [id, idle])));
  const queues = createCell<ReadonlyMap<string, Promise<unknown>>>(new Map());
  const listeners = createCell<ReadonlySet<() => void>>(new Set());
  const isClosed = createCell(false);

  const runnerOf = (id: string): Runner => runners.get().get(id) ?? idle;
  const update = (id: string, change: (runner: Runner) => Runner): void => {
    runners.update((current) => new Map([...current, [id, change(current.get(id) ?? idle)]]));
  };
  const isOn = (id: string): boolean => settings.setting(onSetting(id)) === "true";
  const valuesOf = (id: string): Values => parseValues(settings.setting(valuesSetting(id)));
  const notify = (): void => {
    for (const listener of listeners.get()) listener();
  };

  const view = (id: string): Capability => {
    const runner = runnerOf(id);
    return {
      id,
      ...(runner.manifest && { manifest: runner.manifest }),
      ...toState(isOn(id), runner, valuesOf(id)),
      values: valuesOf(id),
    };
  };

  const settle = async (task: Promise<unknown>): Promise<void> => {
    try {
      await task;
    } catch (error) {
      info("A capability task failed", { error: String(error) });
    }
  };

  const serially = <Value>(id: string, task: () => Promise<Value>): Promise<Value> => {
    const previous = queues.get().get(id) ?? Promise.resolve();
    const run = async (): Promise<Value> => {
      await settle(previous);
      return task();
    };
    const next = run();
    queues.update((current) => new Map([...current, [id, next]]));
    return next;
  };

  const spawnProcess = (id: string, isRunner: boolean): ReturnType<typeof startCapabilityProcess> => {
    const entry = installed.find((candidate) => candidate.id === id)?.entry ?? "";
    return startCapabilityProcess({
      id,
      entry,
      folder: path.join(folders, id),
      onStatus: (status) => {
        if (isRunner) update(id, (runner) => ({ ...runner, status }));
      },
      onLog: (line) => {
        info("A capability wrote to its log", { capability: id, line });
      },
    });
  };

  const shouldRun = (id: string, runner: Runner): boolean =>
    !isClosed.get() &&
    isOn(id) &&
    runner.problem === undefined &&
    (runner.manifest === undefined || isComplete(runner.manifest, valuesOf(id)));

  const halt = async (id: string): Promise<void> => {
    const { process, restart } = runnerOf(id);
    restart?.();
    update(id, (runner) => ({ ...runner, process: undefined, restart: undefined, status: undefined }));
    await process?.stop();
  };

  const onExit = (id: string, process: CapabilityProcess, description: string): void => {
    const runner = runnerOf(id);
    if (runner.process !== process) return;
    const crashes = [...recentCrashes(runner.crashes, clock.now()), clock.now()];
    const decision = toRestartDecision(crashes);
    info("A capability stopped unexpectedly", { capability: id, description, crashes: crashes.length });
    const stopped = { ...runner, process: undefined, status: undefined, crashes };
    if (decision.giveUp) {
      update(id, () => ({ ...stopped, problem: description }));
      return;
    }
    const restart = clock.after(decision.delayMs, () => {
      update(id, (waiting) => ({ ...waiting, restart: undefined }));
      void serially(id, () => reconcile(id));
    });
    update(id, () => ({ ...stopped, restart }));
  };

  const launch = async (id: string): Promise<void> => {
    const started = await spawnProcess(id, true);
    if (!started.ok) {
      update(id, (runner) => ({ ...runner, problem: started.failure }));
      return;
    }
    const process = started.value;
    update(id, (runner) => ({ ...runner, manifest: process.manifest }));
    if (!shouldRun(id, runnerOf(id))) {
      await process.stop();
      return;
    }
    const begun = await process.start(valuesOf(id), server);
    if (!begun.ok) {
      update(id, (runner) => ({ ...runner, problem: begun.failure }));
      await process.stop();
      return;
    }
    update(id, (runner) => ({ ...runner, process }));
    void process.exited.then((description) => {
      onExit(id, process, description);
    });
  };

  const reconcile = async (id: string): Promise<void> => {
    const runner = runnerOf(id);
    const isRunning = runner.process !== undefined || runner.restart !== undefined;
    const isWanted = shouldRun(id, runner);
    if (!isRunning && isWanted) await launch(id);
    else if (isRunning && !isWanted) await halt(id);
  };

  const retry = (id: string): void => {
    update(id, (runner) => ({ ...runner, problem: undefined, crashes: [] }));
  };

  const isInstalled = (id: string): boolean => runners.get().has(id);

  const open = async (): Promise<void> => {
    await Promise.all(installed.map(({ id }) => serially(id, () => launch(id))));
    notify();
  };
  const ready = open();

  return {
    ready,
    list: () => installed.map(({ id }) => view(id)),
    find: (id) => (isInstalled(id) ? view(id) : undefined),
    offered: () =>
      installed
        .map(({ id }) => view(id))
        .filter(
          (capability): capability is Offered =>
            capability.manifest !== undefined && (capability.state === "on" || capability.state === "needs_you"),
        ),
    switchTo: async (id, on) => {
      if (!isInstalled(id)) return notFound(id);
      const switched = await serially(id, async () => {
        settings.setSetting(onSetting(id), String(on));
        retry(id);
        await reconcile(id);
        return view(id);
      });
      notify();
      return ok(switched);
    },
    setUp: async (id, given) => {
      if (!isInstalled(id)) return notFound(id);
      const { manifest } = runnerOf(id);
      if (!manifest) return fail({ code: "invalid_values", detail: `${id} hasn't described its setup yet.` });
      const values = toValues(manifest, { ...valuesOf(id), ...given });
      if (!values.ok) return fail({ code: "invalid_values", detail: values.failure });
      const saved = await serially(id, async () => {
        settings.setSetting(valuesSetting(id), JSON.stringify(values.value));
        await halt(id);
        retry(id);
        await reconcile(id);
        return view(id);
      });
      notify();
      return ok(saved);
    },
    check: async (id, given) => {
      if (!isInstalled(id)) return notFound(id);
      const { manifest, process } = runnerOf(id);
      if (!manifest) return fail({ code: "invalid_values", detail: `${id} hasn't described its setup yet.` });
      const values = toValues(manifest, { ...valuesOf(id), ...given });
      if (!values.ok) return fail({ code: "invalid_values", detail: values.failure });
      if (process) {
        const checked = await process.check(values.value);
        return ok(checked.ok ? checked.value : checked.failure);
      }
      const started = await spawnProcess(id, false);
      if (!started.ok) return ok(started.failure);
      const checked = await started.value.check(values.value);
      await started.value.stop();
      return ok(checked.ok ? checked.value : checked.failure);
    },
    call: async (id, operation, input, { turn, signal } = {}) => {
      const capability = view(id);
      const { process } = runnerOf(id);
      const title = capability.manifest?.title ?? id;
      if (!isInstalled(id)) return fail(`No capability called ${id} is installed.`);
      if (!process || capability.state !== "on") return fail(unavailable(title, capability));
      if (process.manifest.operations.every(({ name }) => name !== operation))
        return fail(`${title} has no operation called ${operation}.`);
      return process.call(operation, input, turn, signal);
    },
    subscribe: (listener) => {
      listeners.update((current) => new Set([...current, listener]));
      return () => {
        listeners.update((current) => new Set([...current].filter((candidate) => candidate !== listener)));
      };
    },
    close: async () => {
      isClosed.set(true);
      await Promise.all(installed.map(({ id }) => serially(id, () => halt(id))));
    },
  };
};
