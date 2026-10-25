import { toInput, toOperationUsage, toUsage } from "#capabilities/commands.ts";
import type { Host, Offered } from "#capabilities/host.ts";
import type { Operation } from "#capabilities/manifest.ts";
import type { Secrets } from "#conversation/secrets.ts";
import { fail, ok, type Result } from "#result.ts";
import type { Tool } from "#tools/mcp.ts";

export type Doors = {
  readonly tools: () => readonly Tool[];
  readonly command: (capability: string, rest: readonly string[]) => Promise<Result<string, string>>;
};

export type DoorsOptions = {
  readonly host: Host;
  readonly secrets: Secrets;
  readonly currentTurn: () => string | undefined;
  readonly command: string;
};

export const maxTools = 20;

const isHelp = (word: string | undefined): boolean => word === undefined || word === "--help" || word === "help";

export const createDoors = ({ host, secrets, currentTurn, command }: DoorsOptions): Doors => {
  const call = async (capability: Offered, operation: Operation, input: unknown): Promise<Result<string, string>> => {
    const given = operation.publishes === true ? secrets.redactValue(input) : input;
    const turn = currentTurn();
    const called = await host.call(capability.id, operation.name, given, turn === undefined ? {} : { turn });
    return called.ok ? ok(called.value.text) : called;
  };

  const toTool = (capability: Offered, operation: Operation & { readonly tool: string }): Tool => ({
    name: operation.tool,
    title: operation.title,
    description: operation.description,
    inputSchema: operation.input,
    call: async (input) => {
      const called = await call(capability, operation, input);
      return called.ok ? { text: called.value } : { text: called.failure, isError: true };
    },
  });

  return {
    tools: () =>
      host
        .offered()
        .flatMap((capability) =>
          capability.manifest.operations.flatMap((operation) =>
            operation.tool === undefined ? [] : [toTool(capability, { ...operation, tool: operation.tool })],
          ),
        ),
    command: async (id, [name, ...rest]) => {
      const capability = host.offered().find((candidate) => candidate.id === id);
      if (!capability) {
        const found = host.find(id);
        return fail(
          found
            ? `${found.manifest?.title ?? id} isn't on, so it has no commands right now.`
            : `There's no capability called ${id}.`,
        );
      }
      if (isHelp(name)) return ok(toUsage(command, capability.manifest));
      const operation = capability.manifest.operations.find((candidate) => candidate.name === name);
      if (!operation)
        return fail(`${capability.manifest.title} has no ${String(name)}.\n\n${toUsage(command, capability.manifest)}`);
      if (rest.includes("--help")) return ok(toOperationUsage(command, id, operation));
      const input = toInput(operation.input, rest);
      return input.ok
        ? call(capability, operation, input.value)
        : fail(`${input.failure}\n\n${toOperationUsage(command, id, operation)}`);
    },
  };
};
