import type { Readable, Writable } from "node:stream";
import { createCell } from "#cell.ts";
import type { Approval, Server, Status, Values } from "#capabilities/manifest.ts";
import { createConnection, type IncomingRequest, type RequestId, type RpcFailure } from "#json-rpc.ts";
import { fail, ok, type Result } from "#result.ts";
import { toManifest, type Capability, type Context } from "./capability.ts";

type Started = { readonly values: Values; readonly folder: string; readonly server: Server };

type Parameters = Readonly<Record<string, unknown>>;

export type Streams = { readonly input: Readable; readonly output: Writable; readonly onClose?: () => void };

const refused = (message: string): Result<never, RpcFailure> => fail({ code: 1, message });

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const noServer: Server = { version: "", engine: "", workspace: "" };

const processStreams: Streams = {
  input: process.stdin,
  output: process.stdout,
  onClose: () => {
    process.exit(0);
  },
};

const parametersOf = (value: unknown): Parameters =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Parameters) : {};

export const runCapability = (capability: Capability, { input, output, onClose }: Streams = processStreams): void => {
  const started = createCell<Started | undefined>(undefined);
  const calls = createCell<ReadonlyMap<RequestId, AbortController>>(new Map());

  const status = (given: Status): void => {
    connection.notify("status", given);
  };

  const contextOf = ({ values, folder, server }: Started): Context => ({ values, folder, server, status });

  const approve = async (approval: Approval): Promise<Result<boolean, string>> => {
    const answered = await connection.request("approve", approval);
    return answered.ok ? ok(parametersOf(answered.value).approved === true) : fail(answered.failure.message);
  };

  const start = async (parameters: Parameters): Promise<Result<unknown, RpcFailure>> => {
    const given: Started = {
      values: (parameters.values ?? {}) as Values,
      folder: typeof parameters.folder === "string" ? parameters.folder : "",
      server: (parameters.server ?? noServer) as Server,
    };
    const begun = capability.start ? await capability.start(contextOf(given)) : ok(undefined);
    if (!begun.ok) return refused(begun.failure);
    started.set(given);
    return ok({});
  };

  const check = async (parameters: Parameters): Promise<Result<unknown, RpcFailure>> => {
    const values = (parameters.values ?? {}) as Values;
    const problem = capability.check ? await capability.check(values, started.get()?.server ?? noServer) : undefined;
    return ok(problem === undefined ? {} : { problem });
  };

  const call = async (id: RequestId, parameters: Parameters): Promise<Result<unknown, RpcFailure>> => {
    const current = started.get();
    if (!current) return refused(`${capability.title} hasn't started.`);
    const operation = capability.operations.find((candidate) => candidate.name === parameters.operation);
    if (!operation) return refused(`${capability.title} has no operation ${String(parameters.operation)}.`);
    const given = operation.input.safeParse(parameters.input ?? {});
    if (!given.success) {
      const problems = given.error.issues.map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`);
      return refused(`That input doesn't fit: ${problems.join("; ")}.`);
    }
    const controller = new AbortController();
    calls.update((current) => new Map([...current, [id, controller]]));
    try {
      const turn = typeof parameters.turn === "string" ? parameters.turn : undefined;
      const result = await operation.run(given.data, {
        ...contextOf(current),
        ...(turn !== undefined && { turn }),
        signal: controller.signal,
        approve,
      });
      if (controller.signal.aborted) return refused("Cancelled.");
      return result.ok ? ok(result.value) : refused(result.failure);
    } finally {
      calls.update((current) => new Map([...current].filter(([key]) => key !== id)));
    }
  };

  const answer = async ({ id, method, parameters: given }: IncomingRequest): Promise<Result<unknown, RpcFailure>> => {
    const parameters = parametersOf(given);
    try {
      switch (method) {
        case "initialize": {
          return ok({ manifest: toManifest(capability) });
        }
        case "start": {
          return await start(parameters);
        }
        case "check": {
          return await check(parameters);
        }
        case "call": {
          return await call(id, parameters);
        }
        default: {
          return fail({ code: -32_601, message: `${capability.title} doesn't handle ${method}.` });
        }
      }
    } catch (error) {
      process.stderr.write(`${capability.title} failed on ${method}: ${describe(error)}\n`);
      return refused(`${capability.title} hit an unexpected error: ${describe(error)}`);
    }
  };

  const connection = createConnection({
    input,
    output,
    onNotification: ({ method, parameters }) => {
      if (method === "cancel")
        calls
          .get()
          .get(parametersOf(parameters).id as RequestId)
          ?.abort();
    },
    onRequest: answer,
    onMalformed: (line) => {
      process.stderr.write(`Unreadable message: ${line}\n`);
    },
    closedMessage: `${capability.title} stopped.`,
  });

  void (async () => {
    await connection.closed;
    onClose?.();
  })();
};
