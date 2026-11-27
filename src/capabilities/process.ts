import { mkdirSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import type { CallResult, Manifest, Server, Status, Values } from "#capabilities/manifest.ts";
import { createCell } from "#cell.ts";
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
    where: CallPlace,
    signal?: AbortSignal,
  ) => Promise<Result<CallResult, string>>;
  // A control only Ito sends, such as the app taking over a hand's page.
  readonly control: (name: string, input: unknown) => Promise<Result<unknown, string>>;
  readonly exited: Promise<string>;
  readonly stop: () => Promise<void>;
};

// Where a call comes from: the running turn, the side thread and the piece of background work, when there are.
export type CallPlace = { readonly turn?: string; readonly thread?: string; readonly run?: string };

export type CapabilityProcessOptions = {
  readonly id: string;
  readonly entry: string;
  readonly folder: string;
  readonly onStatus: (status: Status) => void;
  readonly onApprove: (approval: unknown) => Promise<Result<boolean, string>>;
  readonly onPublish?: (topic: string, data: unknown) => void;
  readonly onRequest?: (name: string, data: unknown) => Promise<Result<unknown, string>>;
  readonly onLog: (line: string) => void;
};

const answerMs = 30_000;

// How long a capability that stopped as it started has to finish writing why.
const lastWordsMs = 2000;

// The lines it wrote last, to say why it stopped.
const keptLines = 60;

// Why a capability stopped, as it started or later, from what it wrote last, in plain words with the fix when there's
// a known one: a package missing because the server skipped `npm ci`, or the error it threw. Nothing when it wrote
// nothing that says.
export const explainStop = (id: string, lines: readonly string[], isStarting = true): string | undefined => {
  const text = lines.join("\n");
  const stopped = isStarting ? `${id} couldn't start` : `${id} stopped`;
  const missing = /Cannot find (?:package|module) '(?<name>[^']+)'/u.exec(text)?.groups?.name;
  if (missing !== undefined && /ERR_MODULE_NOT_FOUND|Cannot find (?:package|module)/u.test(text)) {
    const name = missing.startsWith("/") || missing.startsWith(".") ? missing.split("/").at(-1) : missing;
    return (
      `${stopped}: the ${String(name)} package isn't installed on the server. To fix it, run ` +
      `npm ci --omit=dev in the ito-core folder, then switch ${id} off and on.`
    );
  }
  const error = lines.find((line) => /^\s*(?:[A-Z]\w*)?Error(?: \[[A-Z_]+\])?: /u.test(line));
  return error === undefined ? undefined : `${stopped}: ${error.trim().slice(0, 300)}`;
};

// Node ends what it writes for an error nothing caught with its version.
const isUncaught = (line: string | undefined): boolean => line !== undefined && /^Node\.js v\d/u.test(line);

const withinTime = async <Value>(answer: Promise<Value>, timedOut: Value): Promise<Value> =>
  Promise.race([answer, delay(answerMs, timedOut, { ref: false })]);

const failureText = (failure: RpcFailure): string => failure.message;

const toManifest = (id: string, initialized: Result<unknown, RpcFailure>): Result<Manifest, string> => {
  if (!initialized.ok) return fail(failureText(initialized.failure));
  const { manifest } = initialized.value as { readonly manifest?: Manifest };
  return manifest?.id === id ? ok(manifest) : fail(`${id} calls itself ${String(manifest?.id)}.`);
};

const fieldsOf = (value: unknown): Readonly<Record<string, unknown>> =>
  value && typeof value === "object" ? (value as Readonly<Record<string, unknown>>) : {};

const noRequests = (name: string): Promise<Result<unknown, string>> =>
  Promise.resolve(fail(`Ito doesn't answer ${name} from this capability.`));

export const startCapabilityProcess = async ({
  id,
  entry,
  folder,
  onStatus,
  onApprove,
  onPublish,
  onRequest = noRequests,
  onLog,
}: CapabilityProcessOptions): Promise<Result<CapabilityProcess, string>> => {
  mkdirSync(folder, { recursive: true });
  const written = createCell<readonly string[]>([]);
  const { connection, exited, stop, kill } = startChild({
    command: process.execPath,
    arguments: [entry],
    cwd: folder,
    environment: passedEnvironment([
      "NODE_EXTRA_CA_CERTS",
      "PLAYWRIGHT_BROWSERS_PATH",
      // Where the browser draws: a display such as xvfb-run's, and a choice of headful or headless.
      "DISPLAY",
      "XAUTHORITY",
      "ITO_BROWSER",
    ]),
    onNotification: ({ method, parameters }) => {
      if (method === "status") {
        onStatus(parameters as Status);
        return;
      }
      const { topic, data } = fieldsOf(parameters);
      if (method === "publish" && typeof topic === "string") onPublish?.(topic, data);
    },
    onRequest: async ({ method, parameters }) => {
      if (method === "request") {
        const { name, data } = fieldsOf(parameters);
        const answered = await onRequest(String(name), data);
        return answered.ok ? ok(answered.value ?? {}) : fail({ code: 1, message: answered.failure });
      }
      if (method !== "approve") return fail({ code: -32_601, message: `Ito doesn't handle ${method}.` });
      const approved = await onApprove(parameters);
      return approved.ok ? ok({ approved: approved.value }) : fail({ code: 1, message: approved.failure });
    },
    onLine: (line) => {
      written.update((lines) => [...lines, line].slice(-keptLines));
      onLog(line);
    },
    closedMessage: `${id} stopped.`,
  });

  const notAnswered = fail({ code: -32_000, message: `${id} didn't answer in time.` });
  const initialized = await withinTime(connection.request("initialize", {}), notAnswered);
  const manifest = toManifest(id, initialized);
  if (!manifest.ok) {
    // It may have stopped as it started, such as on a missing package: its last words say why better than "stopped".
    await Promise.race([exited, delay(lastWordsMs, undefined, { ref: false })]);
    await kill();
    return fail(explainStop(id, written.get()) ?? manifest.failure);
  }

  return ok({
    manifest: manifest.value,
    exited: (async () => {
      const exit = await exited;
      const said = isUncaught(exit.lastLine) ? explainStop(id, written.get().slice(-30), false) : undefined;
      return said ?? describeExit(id, exit);
    })(),
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
    call: async (operation, input, { turn, thread, run }, signal) => {
      const called = await connection.request(
        "call",
        {
          operation,
          input,
          ...(turn !== undefined && { turn }),
          ...(thread !== undefined && { thread }),
          ...(run !== undefined && { run }),
        },
        signal && { signal, method: "cancel" },
      );
      return called.ok ? ok(called.value as CallResult) : fail(failureText(called.failure));
    },
    control: async (name, input) => {
      const controlled = await connection.request("control", { name, input });
      return controlled.ok ? ok(controlled.value) : fail(failureText(controlled.failure));
    },
  });
};
