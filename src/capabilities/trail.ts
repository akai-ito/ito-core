import path from "node:path";
import { splitCommand, toInput } from "#capabilities/commands.ts";
import type { Host, Offered } from "#capabilities/host.ts";
import type { Operation } from "#capabilities/manifest.ts";
import type { StepStart, Trail } from "#conversation/steps.ts";
import { toolServerName } from "#tools/mcp.ts";

type Found = { readonly capability: Offered; readonly operation: Operation };

const lastLine = (text: string | undefined): string | undefined =>
  text
    ?.split("\n")
    .map((line) => line.trim())
    .findLast(Boolean);

const asOperation = ({ capability, operation }: Found, input: unknown): StepStart => ({
  kind: "tool",
  facts: { capability: capability.id, operation: operation.name, ...(input !== undefined && { arguments: input }) },
});

export const createTrail = (host: Host, command: string): Trail => {
  const findTool = (tool: string): Found | undefined =>
    host
      .offered()
      .flatMap((capability) =>
        capability.manifest.operations
          .filter((operation) => operation.tool === tool)
          .map((operation) => ({ capability, operation })),
      )
      .at(0);

  const findCommand = (words: readonly string[]): Found | undefined => {
    const [program = "", id, name] = words;
    if (program !== command && path.basename(program) !== "ito") return undefined;
    const capability = host.offered().find((candidate) => candidate.id === id);
    const operation = capability?.manifest.operations.find((candidate) => candidate.name === name);
    return capability && operation ? { capability, operation } : undefined;
  };

  return {
    toStart: (start) => {
      const { kind, facts } = start;
      if (kind === "tool" && facts.capability === toolServerName) {
        const found = findTool(facts.operation ?? "");
        return found ? asOperation(found, facts.arguments) : start;
      }
      if (kind !== "command") return start;
      const words = splitCommand(facts.command ?? "") ?? [];
      const found = findCommand(words);
      if (!found) return start;
      const input = toInput(found.operation.input, words.slice(3));
      return asOperation(found, input.ok ? input.value : undefined);
    },
    toEnd: (step, end) => {
      const { exit_code: exitCode, output } = end.facts;
      if (exitCode === undefined || step.kind !== "tool") return end;
      const detail = lastLine(output);
      return exitCode === 0
        ? { outcome: end.outcome, facts: {} }
        : { outcome: "failed", facts: detail === undefined ? {} : { detail } };
    },
    titleOf: (capability, operation) => {
      const found = host
        .offered()
        .find((candidate) => candidate.id === capability)
        ?.manifest.operations.find((candidate) => candidate.name === operation);
      return found && { present: found.running, past: found.done };
    },
  };
};
