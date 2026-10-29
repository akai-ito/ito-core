import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import { createCell } from "#cell.ts";
import {
  fail,
  ok,
  type CallResult,
  type Capability,
  type Result,
  type Server,
  type Status,
  type Values,
} from "#sdk/capability.ts";
import { runCapability } from "#sdk/runtime.ts";

export type TestCore = {
  readonly manifest: () => Promise<Readonly<Record<string, unknown>>>;
  readonly start: (values: Values) => Promise<Result<undefined, string>>;
  readonly check: (values: Values) => Promise<string | undefined>;
  readonly call: (operation: string, input: unknown, turn?: string) => Promise<Result<CallResult, string>>;
  readonly statuses: () => readonly Status[];
  readonly close: () => void;
};

type Reply = { readonly result?: unknown; readonly error?: { readonly message: string } };

export const testServer: Server = { version: "0.0.0-test", engine: "codex test" };

export const createTestCore = (capability: Capability, folder = "/tmp/ito-test-capability"): TestCore => {
  const toCapability = new PassThrough();
  const fromCapability = new PassThrough();
  const nextId = createCell(1);
  const waiting = createCell<ReadonlyMap<number, (reply: Reply) => void>>(new Map());
  const statuses = createCell<readonly Status[]>([]);
  runCapability(capability, { input: toCapability, output: fromCapability });

  createInterface({ input: fromCapability }).on("line", (line) => {
    const message = JSON.parse(line) as Reply & {
      readonly id?: number;
      readonly method?: string;
      readonly params?: Status;
    };
    const { params: status } = message;
    if (status && message.method === "status") statuses.update((current) => [...current, status]);
    if (message.id === undefined) return;
    waiting.get().get(message.id)?.(message);
  });

  const request = (method: string, parameters: unknown): Promise<Reply> =>
    new Promise((resolve) => {
      const id = nextId.update((count) => count + 1);
      waiting.update((current) => new Map([...current, [id, resolve]]));
      toCapability.write(`${JSON.stringify({ id, method, params: parameters })}\n`);
    });

  return {
    manifest: async () => {
      const reply = await request("initialize", {});
      return (reply.result as { readonly manifest: Readonly<Record<string, unknown>> }).manifest;
    },
    start: async (values) => {
      const reply = await request("start", { values, folder, server: testServer });
      return reply.error ? fail(reply.error.message) : ok(undefined);
    },
    check: async (values) => {
      const reply = await request("check", { values });
      return (reply.result as { readonly problem?: string } | undefined)?.problem;
    },
    call: async (operation, input, turn) => {
      const reply = await request("call", { operation, input, ...(turn !== undefined && { turn }) });
      return reply.error ? fail(reply.error.message) : ok(reply.result as CallResult);
    },
    statuses: () => statuses.get(),
    close: () => {
      toCapability.end();
    },
  };
};
