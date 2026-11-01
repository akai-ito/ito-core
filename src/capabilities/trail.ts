import path from "node:path";
import { splitCommand, toInput } from "#capabilities/commands.ts";
import type { Host } from "#capabilities/host.ts";
import type { Operation } from "#capabilities/manifest.ts";
import type { StepStart, Trail } from "#conversation/steps.ts";
import type { Groups } from "#tools/groups.ts";
import { toolServerName } from "#tools/mcp.ts";

type Found = { readonly id: string; readonly operation: Operation };

const lastLine = (text: string | undefined): string | undefined =>
  text
    ?.split("\n")
    .map((line) => line.trim())
    .findLast(Boolean);

const asOperation = ({ id, operation }: Found, input: unknown): StepStart => ({
  kind: "tool",
  facts: { capability: id, operation: operation.name, ...(input !== undefined && { arguments: input }) },
});

// A command too shell-shaped to split, such as a draft whose body has quotes in it, still names its
// program, group and operation first.
const leadingWords = (command: string): readonly string[] =>
  /^\s*(?<program>\S+)\s+(?<id>[a-z][\w-]*)\s+(?<name>[a-z][\w-]*)/u.exec(command)?.slice(1) ?? [];

export const createTrail = (host: Host, command: string, groups?: Groups): Trail => {
  const findOffered = (id: string, name: string): Found | undefined => {
    const capability = host.offered().find((candidate) => candidate.id === id);
    const operation = capability?.manifest.operations.find((candidate) => candidate.name === name);
    if (capability && operation) return { id: capability.id, operation };
    const grouped = groups?.find(id, name);
    return grouped && { id: grouped.group.id, operation: grouped.operation };
  };

  const findTool = (tool: string): Found | undefined => {
    const offered = host
      .offered()
      .flatMap((capability) =>
        capability.manifest.operations
          .filter((operation) => operation.tool === tool)
          .map((operation) => ({ id: capability.id, operation })),
      )
      .at(0);
    const grouped = offered ? undefined : groups?.findTool(tool);
    return offered ?? (grouped && { id: grouped.group.id, operation: grouped.operation });
  };

  const findCommand = (words: readonly string[]): Found | undefined => {
    const [program = "", id = "", name = ""] = words;
    return program === command || path.basename(program) === "ito" ? findOffered(id, name) : undefined;
  };

  return {
    toStart: (start) => {
      const { kind, facts } = start;
      if (kind === "tool" && facts.capability === toolServerName) {
        const found = findTool(facts.operation ?? "");
        return found ? asOperation(found, facts.arguments) : start;
      }
      if (kind !== "command") return start;
      const words = splitCommand(facts.command ?? "");
      const found = findCommand(words ?? leadingWords(facts.command ?? ""));
      if (!found) return start;
      const input = words && toInput(found.operation.input, words.slice(3));
      return asOperation(found, input?.ok === true ? input.value : undefined);
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
      const found = findOffered(capability, operation)?.operation;
      return found && { present: found.running, past: found.done };
    },
  };
};
