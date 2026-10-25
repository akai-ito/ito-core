import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { createCell } from "#cell.ts";
import {
  capabilityProtocol,
  toMessage,
  type CallResult,
  type Manifest,
  type Status,
  type Values,
} from "#capabilities/manifest.ts";
import { createConnection, type RpcFailure } from "#json-rpc.ts";
import { fail, ok, type Result } from "#result.ts";

export type CapabilityProcess = {
  readonly manifest: Manifest;
  readonly start: (
    values: Values,
    server: { readonly version: string; readonly engine: string },
  ) => Promise<Result<undefined, string>>;
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

const gracefulExitMs = 3000;
const answerMs = 30_000;

const passedVariables = [
  "PATH",
  "HOME",
  "LANG",
  "LC_ALL",
  "TZ",
  "TMPDIR",
  "NODE_EXTRA_CA_CERTS",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
];

const toEnvironment = (environment: NodeJS.ProcessEnv): Readonly<Record<string, string>> =>
  Object.fromEntries(
    passedVariables.flatMap((name) => {
      const value = environment[name];
      return value === undefined ? [] : [[name, value]];
    }),
  );

const describeExit = (id: string, code: number | null, signal: NodeJS.Signals | null, lastLine?: string): string => {
  const how = signal ? `was killed by ${signal}` : `exited with code ${String(code)}`;
  return lastLine ? `${id} ${how}: ${lastLine}` : `${id} ${how}.`;
};

const withinTime = async <Value>(answer: Promise<Value>, timedOut: Value): Promise<Value> =>
  Promise.race([answer, delay(answerMs, timedOut, { ref: false })]);

const failureText = (failure: RpcFailure): string => failure.message;

const toManifest = (id: string, initialized: Result<unknown, RpcFailure>): Result<Manifest, string> => {
  if (!initialized.ok) return fail(failureText(initialized.failure));
  const answer = toMessage("InitializeResult", initialized.value);
  if (!answer.ok) return fail(`${id} sent a manifest Ito can't read: ${answer.failure}`);
  const { protocol, manifest } = answer.value;
  if (protocol !== capabilityProtocol)
    return fail(`${id} speaks capability protocol ${protocol}, and this server speaks ${capabilityProtocol}.`);
  return manifest.id === id ? ok(manifest) : fail(`${id} calls itself ${manifest.id}.`);
};

export const startCapabilityProcess = async ({
  id,
  entry,
  folder,
  onStatus,
  onLog,
}: CapabilityProcessOptions): Promise<Result<CapabilityProcess, string>> => {
  mkdirSync(folder, { recursive: true });
  const child = spawn(process.execPath, [entry], {
    cwd: folder,
    env: toEnvironment(process.env),
    stdio: ["pipe", "pipe", "pipe"],
    detached: true,
  });
  const lastLine = createCell<string | undefined>(undefined);
  child.stdin.on("error", (error) => {
    onLog(`Couldn't write to it: ${error.message}`);
  });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    for (const line of chunk.split("\n")) {
      if (line.trim() === "") continue;
      lastLine.set(line);
      onLog(line);
    }
  });
  const exited = new Promise<string>((resolve) => {
    child.once("error", (error) => {
      resolve(`${id} couldn't start: ${error.message}`);
    });
    child.once("exit", (code, signal) => {
      resolve(describeExit(id, code, signal, lastLine.get()));
    });
  });

  const connection = createConnection({
    input: child.stdout,
    output: child.stdin,
    onNotification: ({ method, parameters }) => {
      if (method !== "status") return;
      const status = toMessage("StatusParams", parameters);
      if (status.ok) onStatus(status.value);
      else onLog(`Unreadable status: ${status.failure}`);
    },
    onRequest: ({ method }) => fail({ code: -32_601, message: `Ito doesn't handle ${method}.` }),
    onMalformed: (line) => {
      onLog(`Unreadable output: ${line}`);
    },
    closedMessage: `${id} stopped.`,
  });

  const killGroup = async (): Promise<void> => {
    if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
      process.kill(-child.pid, "SIGKILL");
    }
    await exited;
  };

  const stop = async (): Promise<void> => {
    child.stdin.end();
    const didExit = async (): Promise<boolean> => {
      await exited;
      return true;
    };
    const hasExited = await Promise.race([didExit(), delay(gracefulExitMs, false)]);
    if (!hasExited) await killGroup();
  };

  const notAnswered = fail({ code: -32_000, message: `${id} didn't answer in time.` });
  const initialized = await withinTime(connection.request("initialize", { protocol: capabilityProtocol }), notAnswered);
  const manifest = toManifest(id, initialized);
  if (!manifest.ok) {
    await killGroup();
    return manifest;
  }

  return ok({
    manifest: manifest.value,
    exited,
    stop,
    start: async (values, server) => {
      const started = await withinTime(connection.request("start", { values, folder, server }), notAnswered);
      return started.ok ? ok(undefined) : fail(failureText(started.failure));
    },
    check: async (values) => {
      const checked = await withinTime(connection.request("check", { values }), notAnswered);
      if (!checked.ok) return fail(failureText(checked.failure));
      const result = toMessage("CheckResult", checked.value);
      return result.ok ? ok(result.value.problem) : fail(result.failure);
    },
    call: async (operation, input, turn, signal) => {
      const called = await connection.request(
        "call",
        { operation, input, ...(turn !== undefined && { turn }) },
        signal && { signal, method: "cancel" },
      );
      return called.ok ? toMessage("CallResult", called.value) : fail(failureText(called.failure));
    },
  });
};
