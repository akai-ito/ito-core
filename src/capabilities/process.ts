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
  const { connection, exited, stop, kill } = startChild({
    command: process.execPath,
    arguments: [entry],
    cwd: folder,
    environment: passedEnvironment(["NODE_EXTRA_CA_CERTS", "PLAYWRIGHT_BROWSERS_PATH"]),
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
