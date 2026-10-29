import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { createCell } from "#cell.ts";
import {
  createConnection,
  type Connection,
  type IncomingNotification,
  type IncomingRequest,
  type RpcFailure,
} from "#json-rpc.ts";
import { fail, type Result } from "#result.ts";

export type Exit = { readonly how: string; readonly lastLine?: string };

export type ChildOptions = {
  readonly command: string;
  readonly arguments: readonly string[];
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly onNotification: (notification: IncomingNotification) => void;
  readonly onRequest?: (request: IncomingRequest) => Result<unknown, RpcFailure> | Promise<Result<unknown, RpcFailure>>;
  readonly onLine: (line: string) => void;
  readonly closedMessage: string;
};

export type Child = {
  readonly connection: Connection;
  readonly exited: Promise<Exit>;
  readonly stop: () => Promise<void>;
  readonly kill: () => Promise<void>;
};

const gracefulExitMs = 3000;

export const proxyVariables = ["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy"];

export const passedEnvironment = (
  names: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
): Readonly<Record<string, string>> =>
  Object.fromEntries(
    ["PATH", "HOME", "LANG", "LC_ALL", "TZ", "TMPDIR", ...names, ...proxyVariables].flatMap((name) => {
      const value = environment[name];
      return value === undefined ? [] : [[name, value]];
    }),
  );

export const describeExit = (name: string, { how, lastLine }: Exit): string =>
  lastLine ? `${name} ${how}: ${lastLine}` : `${name} ${how}.`;

const refuseRequests = ({ method }: IncomingRequest): Result<unknown, RpcFailure> =>
  fail({ code: -32_601, message: `Ito doesn't handle ${method}.` });

export const startChild = ({
  command,
  arguments: given,
  cwd,
  environment,
  onNotification,
  onRequest = refuseRequests,
  onLine,
  closedMessage,
}: ChildOptions): Child => {
  const child = spawn(command, [...given], { cwd, env: environment, stdio: ["pipe", "pipe", "pipe"], detached: true });
  const lastLine = createCell<string | undefined>(undefined);
  const keep = (line: string): void => {
    lastLine.set(line);
    onLine(line);
  };
  child.stdin.on("error", (error) => {
    onLine(`Couldn't write to it: ${error.message}`);
  });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    for (const line of chunk.split("\n")) if (line.trim() !== "") keep(line);
  });
  const exited = new Promise<Exit>((resolve) => {
    child.once("error", (error) => {
      resolve({ how: `couldn't start: ${error.message}` });
    });
    child.once("exit", (code, signal) => {
      const how = signal ? `was killed by ${signal}` : `exited with code ${String(code)}`;
      const last = lastLine.get();
      resolve(last === undefined ? { how } : { how, lastLine: last });
    });
  });
  const connection = createConnection({
    input: child.stdout,
    output: child.stdin,
    onNotification,
    onRequest,
    onMalformed: (line) => {
      keep(`Unreadable output: ${line}`);
    },
    closedMessage,
  });

  const kill = async (): Promise<void> => {
    if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
      process.kill(-child.pid, "SIGKILL");
    }
    await exited;
  };

  return {
    connection,
    exited,
    kill,
    stop: async () => {
      child.stdin.end();
      const didExit = async (): Promise<boolean> => {
        await exited;
        return true;
      };
      const hasExited = await Promise.race([didExit(), delay(gracefulExitMs, false)]);
      if (!hasExited) await kill();
    },
  };
};
