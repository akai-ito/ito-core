import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import { createCell } from "#cell.ts";
import {
  fail,
  ok,
  type Approval,
  type CallResult,
  type Capability,
  type Result,
  type Server,
  type Status,
  type Values,
} from "#sdk/capability.ts";
import { runCapability } from "#sdk/runtime.ts";

export type Published = { readonly topic: string; readonly data: unknown };

export type Place = { readonly turn?: string; readonly thread?: string; readonly run?: string };

export type TestCore = {
  readonly manifest: () => Promise<Readonly<Record<string, unknown>>>;
  readonly start: (values: Values) => Promise<Result<undefined, string>>;
  readonly check: (values: Values) => Promise<string | undefined>;
  readonly call: (operation: string, input: unknown, turn?: string | Place) => Promise<Result<CallResult, string>>;
  readonly control: (name: string, input: unknown) => Promise<Result<unknown, string>>;
  readonly statuses: () => readonly Status[];
  readonly published: () => readonly Published[];
  readonly onPublish: (listener: (published: Published) => void) => () => void;
  readonly close: () => void;
};

type Reply = { readonly result?: unknown; readonly error?: { readonly message: string } };

export const testServer: Server = { version: "0.0.0-test", engine: "codex test", workspace: "/tmp/ito-test-workspace" };

export type TestCoreOptions = {
  readonly folder?: string;
  readonly server?: Server;
  readonly approve?: (approval: Approval) => boolean;
  readonly answer?: (name: string, data: unknown) => Result<unknown, string>;
  // Keeps every frame and every other publish; frames can be many, so a test may leave them out.
  readonly keepFrames?: boolean;
};

export const createTestCore = (
  capability: Capability,
  {
    folder = "/tmp/ito-test-capability",
    server = testServer,
    approve = () => false,
    answer = (name) => fail(`The test core doesn't answer ${name}.`),
    keepFrames = false,
  }: TestCoreOptions = {},
): TestCore => {
  const toCapability = new PassThrough();
  const fromCapability = new PassThrough();
  const nextId = createCell(1);
  const waiting = createCell<ReadonlyMap<number, (reply: Reply) => void>>(new Map());
  const statuses = createCell<readonly Status[]>([]);
  const published = createCell<readonly Published[]>([]);
  const listeners = createCell<ReadonlySet<(published: Published) => void>>(new Set());
  runCapability(capability, { input: toCapability, output: fromCapability });

  createInterface({ input: fromCapability }).on("line", (line) => {
    const message = JSON.parse(line) as Reply & {
      readonly id?: number;
      readonly method?: string;
      readonly params?: Status;
    };
    const { params: status } = message;
    if (status && message.method === "status") statuses.update((current) => [...current, status]);
    if (message.method === "publish") {
      const given = message.params as unknown as Published;
      if (keepFrames || given.topic !== "frame") published.update((current) => [...current, given]);
      for (const listener of listeners.get()) listener(given);
      return;
    }
    if (message.method === "request" && message.id !== undefined) {
      const { name, data } = message.params as unknown as { readonly name: string; readonly data: unknown };
      const answered = answer(name, data);
      toCapability.write(
        `${JSON.stringify(answered.ok ? { id: message.id, result: answered.value } : { id: message.id, error: { code: 1, message: answered.failure } })}\n`,
      );
      return;
    }
    if (message.method === "approve" && message.id !== undefined) {
      const approved = approve(message.params as unknown as Approval);
      toCapability.write(`${JSON.stringify({ id: message.id, result: { approved } })}\n`);
      return;
    }
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
      const reply = await request("start", { values, folder, server });
      return reply.error ? fail(reply.error.message) : ok(undefined);
    },
    check: async (values) => {
      const reply = await request("check", { values });
      return (reply.result as { readonly problem?: string } | undefined)?.problem;
    },
    call: async (operation, input, place) => {
      const where = typeof place === "string" ? { turn: place } : (place ?? {});
      const reply = await request("call", { operation, input, ...where });
      return reply.error ? fail(reply.error.message) : ok(reply.result as CallResult);
    },
    control: async (name, input) => {
      const reply = await request("control", { name, input });
      return reply.error ? fail(reply.error.message) : ok(reply.result);
    },
    statuses: () => statuses.get(),
    published: () => published.get(),
    onPublish: (listener) => {
      listeners.update((current) => new Set([...current, listener]));
      return () => {
        listeners.update((current) => new Set([...current].filter((candidate) => candidate !== listener)));
      };
    },
    close: () => {
      toCapability.end();
    },
  };
};
