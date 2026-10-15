import { spawn } from "node:child_process";
import { mkdirSync, realpathSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { createCell } from "#cell.ts";
import { codexScript } from "#engine/codex/binary.ts";
import type { InitializeParams } from "#engine/codex/bindings/InitializeParams.ts";
import type { InitializeResponse } from "#engine/codex/bindings/InitializeResponse.ts";
import type { ServerNotification } from "#engine/codex/bindings/ServerNotification.ts";
import type { GetAccountParams } from "#engine/codex/bindings/v2/GetAccountParams.ts";
import type { GetAccountResponse } from "#engine/codex/bindings/v2/GetAccountResponse.ts";
import type { ThreadReadParams } from "#engine/codex/bindings/v2/ThreadReadParams.ts";
import type { ThreadReadResponse } from "#engine/codex/bindings/v2/ThreadReadResponse.ts";
import type { ThreadResumeParams } from "#engine/codex/bindings/v2/ThreadResumeParams.ts";
import type { ThreadResumeResponse } from "#engine/codex/bindings/v2/ThreadResumeResponse.ts";
import type { ThreadStartParams } from "#engine/codex/bindings/v2/ThreadStartParams.ts";
import type { ThreadStartResponse } from "#engine/codex/bindings/v2/ThreadStartResponse.ts";
import type { TurnInterruptParams } from "#engine/codex/bindings/v2/TurnInterruptParams.ts";
import type { TurnInterruptResponse } from "#engine/codex/bindings/v2/TurnInterruptResponse.ts";
import type { TurnStartParams } from "#engine/codex/bindings/v2/TurnStartParams.ts";
import type { TurnStartResponse } from "#engine/codex/bindings/v2/TurnStartResponse.ts";
import type { TurnSteerParams } from "#engine/codex/bindings/v2/TurnSteerParams.ts";
import type { TurnSteerResponse } from "#engine/codex/bindings/v2/TurnSteerResponse.ts";
import { createConnection, type IncomingRequest, type RpcFailure } from "#engine/codex/json-rpc.ts";
import { fail, ok, type Result } from "#result.ts";
import { packageVersion } from "#version.ts";

type Call<Parameters, Response> = { readonly parameters: Parameters; readonly response: Response };

type Calls = {
  readonly "account/read": Call<GetAccountParams, GetAccountResponse>;
  readonly "thread/start": Call<ThreadStartParams, ThreadStartResponse>;
  readonly "thread/resume": Call<ThreadResumeParams, ThreadResumeResponse>;
  readonly "thread/read": Call<ThreadReadParams, ThreadReadResponse>;
  readonly "turn/start": Call<TurnStartParams, TurnStartResponse>;
  readonly "turn/steer": Call<TurnSteerParams, TurnSteerResponse>;
  readonly "turn/interrupt": Call<TurnInterruptParams, TurnInterruptResponse>;
};

export type CodexProcess = {
  readonly call: <Method extends keyof Calls>(
    method: Method,
    parameters: Calls[Method]["parameters"],
  ) => Promise<Result<Calls[Method]["response"], RpcFailure>>;
  readonly exited: Promise<string>;
  readonly stop: () => Promise<void>;
  readonly kill: () => Promise<void>;
};

export type CodexProcessOptions = {
  readonly codexHome: string;
  readonly workspace: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly onNotification: (notification: ServerNotification) => void;
  readonly onExit: (description: string) => void;
};

const gracefulExitMs = 3000;
const keptStderrLines = 20;

const declinedApprovals = new Set(["item/commandExecution/requestApproval", "item/fileChange/requestApproval"]);

const answerRequest = ({ method }: IncomingRequest): Result<unknown, RpcFailure> =>
  declinedApprovals.has(method)
    ? ok({ decision: "decline" })
    : fail({ code: -32_601, message: `Ito doesn't handle ${method}.` });

const describeExit = (code: number | null, signal: NodeJS.Signals | null, stderr: readonly string[]): string => {
  const how = signal ? `was killed by ${signal}` : `exited with code ${String(code)}`;
  const lastLine = stderr.at(-1);
  return lastLine ? `Codex ${how}: ${lastLine}` : `Codex ${how}.`;
};

export const startCodexProcess = async (options: CodexProcessOptions): Promise<Result<CodexProcess, string>> => {
  mkdirSync(options.codexHome, { recursive: true });
  mkdirSync(options.workspace, { recursive: true });
  const child = spawn(process.execPath, [codexScript(), "app-server"], {
    cwd: options.workspace,
    env: { ...process.env, ...options.environment, CODEX_HOME: options.codexHome },
    stdio: ["pipe", "pipe", "pipe"],
    detached: true,
  });
  const stderr = createCell<readonly string[]>([]);
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    const lines = chunk.split("\n").filter((line) => line.trim() !== "");
    stderr.update((kept) => [...kept, ...lines].slice(-keptStderrLines));
  });
  const exited = new Promise<string>((resolve) => {
    child.once("error", (error) => {
      resolve(`Codex couldn't start: ${error.message}`);
    });
    child.once("exit", (code, signal) => {
      resolve(describeExit(code, signal, stderr.get()));
    });
  });
  void exited.then(options.onExit);

  const connection = createConnection({
    input: child.stdout,
    output: child.stdin,
    onNotification: ({ method, parameters }) => {
      options.onNotification({ method, params: parameters } as ServerNotification);
    },
    onRequest: answerRequest,
    onMalformed: (line) => {
      stderr.update((kept) => [...kept, `Unreadable output: ${line}`].slice(-keptStderrLines));
    },
  });

  const killGroup = async (): Promise<void> => {
    if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
      process.kill(-child.pid, "SIGKILL");
    }
    await exited;
  };

  const call: CodexProcess["call"] = async (method, parameters) =>
    (await connection.request(method, parameters)) as Awaited<ReturnType<CodexProcess["call"]>>;

  const initializeParameters: InitializeParams = {
    clientInfo: { name: "ito", title: "Ito", version: packageVersion() },
    capabilities: { experimentalApi: false, requestAttestation: false },
  };
  const initialized = await connection.request("initialize", initializeParameters);
  if (!initialized.ok) {
    await killGroup();
    return fail(`Codex didn't start: ${initialized.failure.message}`);
  }
  connection.notify("initialized");
  const { codexHome } = initialized.value as InitializeResponse;
  if (realpathSync(codexHome) !== realpathSync(options.codexHome)) {
    await killGroup();
    return fail(`Codex started with ${codexHome} as its home instead of ${options.codexHome}.`);
  }

  return ok({
    call,
    exited,
    stop: async () => {
      child.stdin.end();
      const didExit = async (): Promise<boolean> => {
        await exited;
        return true;
      };
      const hasExited = await Promise.race([didExit(), delay(gracefulExitMs, false)]);
      if (!hasExited) await killGroup();
    },
    kill: killGroup,
  });
};
