import { mkdirSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import type { CallResult, Manifest, Server, Status, Values } from "#capabilities/manifest.ts";
import { describeExit, passedEnvironment, startChild } from "#child.ts";
import type { RpcFailure } from "#json-rpc.ts";
import { fail, ok, type Result } from "#result.ts";

export type CapabilityProcess = {
  readonly manifest: Manifest;
  readonly start: (values: Values, server: Server) => Promise<Result<undefined, string>>;
  readonly check: (values: Values) => Promise<Result<string | undefined, string>>;
  readonly call: (
    operation: string,
    input: unknown,
    turn: string | undefined,
    signal?: AbortSignal,
  ) => Promise<Result<CallResult, string>>;
  readonly exited: Promise<string>;
  readonly stop: () => Promise<void>;
};

export type CapabilityProcessOptions = {
  readonly id: string;
  readonly entry: string;
  readonly folder: string;
  readonly onStatus: (status: Status) => void;
  readonly onLog: (line: string) => void;
};

const answerMs = 30_000;

const withinTime = async <Value>(answer: Promise<Value>, timedOut: Value): Promise<Value> =>
  Promise.race([answer, delay(answerMs, timedOut, { ref: false })]);

const failureText = (failure: RpcFailure): string => failure.message;

const toManifest = (id: string, initialized: Result<unknown, RpcFailure>): Result<Manifest, string> => {
  if (!initialized.ok) return fail(failureText(initialized.failure));
  const { manifest } = initialized.value as { readonly manifest?: Manifest };
  return manifest?.id === id ? ok(manifest) : fail(`${id} calls itself ${String(manifest?.id)}.`);
};

export const startCapabilityProcess = async ({
  id,
  entry,
  folder,
  onStatus,
  onLog,
}: CapabilityProcessOptions): Promise<Result<CapabilityProcess, string>> => {
  mkdirSync(folder, { recursive: true });
  const { connection, exited, stop, kill } = startChild({
    command: process.execPath,
    arguments: [entry],
    cwd: folder,
    environment: passedEnvironment(["NODE_EXTRA_CA_CERTS"]),
    onNotification: ({ method, parameters }) => {
      if (method === "status") onStatus(parameters as Status);
    },
    onLine: onLog,
    closedMessage: `${id} stopped.`,
  });

  const notAnswered = fail({ code: -32_000, message: `${id} didn't answer in time.` });
  const initialized = await withinTime(connection.request("initialize", {}), notAnswered);
  const manifest = toManifest(id, initialized);
  if (!manifest.ok) {
    await kill();
    return manifest;
  }

  return ok({
    manifest: manifest.value,
    exited: (async () => describeExit(id, await exited))(),
    stop,
    start: async (values, server) => {
      const started = await withinTime(connection.request("start", { values, folder, server }), notAnswered);
      return started.ok ? ok(undefined) : fail(failureText(started.failure));
    },
    check: async (values) => {
      const checked = await withinTime(connection.request("check", { values }), notAnswered);
      return checked.ok
        ? ok((checked.value as { readonly problem?: string }).problem)
        : fail(failureText(checked.failure));
    },
    call: async (operation, input, turn, signal) => {
      const called = await connection.request(
        "call",
        { operation, input, ...(turn !== undefined && { turn }) },
        signal && { signal, method: "cancel" },
      );
      return called.ok ? ok(called.value as CallResult) : fail(failureText(called.failure));
    },
  });
};
