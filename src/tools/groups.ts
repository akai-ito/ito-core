import { toInput, toOperationUsage } from "#capabilities/commands.ts";
import type { Operation } from "#capabilities/manifest.ts";
import type { OwnSkill } from "#capabilities/skills.ts";
import { fail, ok, type Result } from "#result.ts";
import type { Tool } from "#tools/mcp.ts";

// One command in a group, run as `ito <group> <name>` and backed by one of Ito's own tools.
export type GroupOperation = {
  readonly name: string;
  readonly tool: string;
  readonly running: string;
  readonly done: string;
};

// Ito's own tools that the agent reaches through commands and a skill file, rather than as tools in
// every turn: only the skill's one-line summary is in mind until it's needed.
export type ToolGroup = {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly skill: string;
  readonly operations: readonly GroupOperation[];
};

export type FoundOperation = { readonly group: ToolGroup; readonly operation: Operation };

export type Groups = {
  // Runs a group's command, or gives undefined when no group has that id.
  readonly command: (id: string, rest: readonly string[]) => Promise<Result<string, string>> | undefined;
  readonly find: (id: string, name: string) => FoundOperation | undefined;
  readonly findTool: (tool: string) => FoundOperation | undefined;
  readonly skills: () => readonly OwnSkill[];
};

export type GroupsOptions = {
  readonly groups: readonly ToolGroup[];
  readonly tools: () => readonly Tool[];
  readonly command: string;
};

const isHelp = (word: string | undefined): boolean => word === undefined || word === "--help" || word === "help";

export const createGroups = ({ groups, tools, command }: GroupsOptions): Groups => {
  const toolOf = (name: string): Tool | undefined => tools().find((tool) => tool.name === name);

  const toOperation = ({ name, tool, running, done }: GroupOperation): Operation | undefined => {
    const found = toolOf(tool);
    return (
      found && {
        name,
        title: found.title,
        running,
        done,
        description: found.description,
        input: found.inputSchema,
        tool,
      }
    );
  };

  const operationsOf = (group: ToolGroup): readonly Operation[] =>
    group.operations.flatMap((operation) => toOperation(operation) ?? []);

  const usageOf = (group: ToolGroup): string =>
    operationsOf(group)
      .map((operation) => toOperationUsage(command, group.id, operation))
      .join("\n\n");

  const run = async (group: ToolGroup, [name, ...rest]: readonly string[]): Promise<Result<string, string>> => {
    if (isHelp(name)) return ok(`${group.title}: ${group.summary}\n\n${usageOf(group)}`);
    const operation = operationsOf(group).find((candidate) => candidate.name === name);
    if (!operation) return fail(`${group.title} has no ${String(name)}.\n\n${usageOf(group)}`);
    const usage = toOperationUsage(command, group.id, operation);
    if (rest.includes("--help")) return ok(usage);
    const input = toInput(operation.input, rest);
    if (!input.ok) return fail(`${input.failure}\n\n${usage}`);
    const tool = toolOf(operation.tool ?? "");
    if (!tool) return fail(`${group.title} can't ${operation.name} right now.`);
    const result = await tool.call(input.value);
    return result.isError === true ? fail(result.text) : ok(result.text);
  };

  return {
    command: (id, rest) => {
      const group = groups.find((candidate) => candidate.id === id);
      return group && run(group, rest);
    },
    find: (id, name) => {
      const group = groups.find((candidate) => candidate.id === id);
      const operation = group && operationsOf(group).find((candidate) => candidate.name === name);
      return group && operation && { group, operation };
    },
    findTool: (tool) =>
      groups
        .flatMap((group) =>
          operationsOf(group)
            .filter((operation) => operation.tool === tool)
            .map((operation) => ({ group, operation })),
        )
        .at(0),
    skills: () =>
      groups.map((group) => ({
        id: group.id,
        summary: group.summary,
        text: `${group.skill.trimEnd()}\n\n## Commands\n\n${usageOf(group)}\n`,
      })),
  };
};
