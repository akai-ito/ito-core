import { toInput, toOperationUsage } from "#capabilities/commands.ts";
import type { Operation } from "#capabilities/manifest.ts";
import type { OwnSkill } from "#capabilities/skills.ts";
import { createCell } from "#cell.ts";
import { fail, ok, type Result } from "#result.ts";
import type { Tool, ToolStep } from "#tools/mcp.ts";

// How a run of one operation's steps reads as one line, with {count} for how many.
export type RunTitle = { readonly present: string; readonly past: string };

// One command in a group, run as `ito <group> <name>` and backed by one of Ito's own tools.
export type GroupOperation = {
  readonly name: string;
  readonly tool: string;
  readonly running: string;
  readonly done: string;
  readonly run?: RunTitle;
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

export type FoundOperation = { readonly group: ToolGroup; readonly operation: Operation; readonly run?: RunTitle };

export type Groups = {
  // Runs a group's command, or gives undefined when no group has that id.
  readonly command: (id: string, rest: readonly string[]) => Promise<Result<string, string>> | undefined;
  readonly find: (id: string, name: string) => FoundOperation | undefined;
  readonly findTool: (tool: string) => FoundOperation | undefined;
  readonly skills: () => readonly OwnSkill[];
  // Wraps a tool so that a call to a group's tool keeps how it reads on the trail, for the step that made it.
  readonly reporting: (tool: Tool) => Tool;
  // How a call read, taken once: the latest call with that tool and input, or without its input, the latest of that
  // tool. The latest, so one left behind by a call no step showed never stands in for a newer one.
  readonly report: (tool: string, input: unknown) => ToolStep | undefined;
};

export type GroupsOptions = {
  readonly groups: readonly ToolGroup[];
  readonly tools: () => readonly Tool[];
  readonly command: string;
};

const isHelp = (word: string | undefined): boolean => word === undefined || word === "--help" || word === "help";

type Reported = { readonly tool: string; readonly input: string; readonly step: ToolStep };

// Reports a step never came back for, such as one cut off by a restart, are dropped past this many.
const mostReports = 100;

// The same input written the same way, whatever order its fields came in.
const canonical = (input: unknown): string =>
  JSON.stringify(input ?? {}, (_key, value: unknown) =>
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).toSorted(([left], [right]) => left.localeCompare(right)))
      : value,
  );

const runOf = (group: ToolGroup, operation: Operation): RunTitle | undefined =>
  group.operations.find(({ name }) => name === operation.name)?.run;

export const createGroups = ({ groups, tools, command }: GroupsOptions): Groups => {
  const toolOf = (name: string): Tool | undefined => tools().find((tool) => tool.name === name);
  const reports = createCell<readonly Reported[]>([]);
  const isGrouped = (tool: string): boolean =>
    groups.some((group) => group.operations.some((operation) => operation.tool === tool));

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
      return group && operation && { group, operation, run: runOf(group, operation) };
    },
    findTool: (tool) =>
      groups
        .flatMap((group) =>
          operationsOf(group)
            .filter((operation) => operation.tool === tool)
            .map((operation) => ({ group, operation, run: runOf(group, operation) })),
        )
        .at(0),
    skills: () =>
      groups.map((group) => ({
        id: group.id,
        summary: group.summary,
        text: `${group.skill.trimEnd()}\n\n## Commands\n\n${usageOf(group)}\n`,
      })),
    reporting: (tool) =>
      isGrouped(tool.name)
        ? {
            ...tool,
            call: async (input) => {
              const result = await tool.call(input);
              const { step } = result;
              if (step !== undefined && result.isError !== true) {
                reports.update((current) =>
                  [...current, { tool: tool.name, input: canonical(input), step }].slice(-mostReports),
                );
              }
              return result;
            },
          }
        : tool,
    report: (tool, input) => {
      const wanted = input === undefined ? undefined : canonical(input);
      const found = reports
        .get()
        .findLast((reported) => reported.tool === tool && (wanted === undefined || reported.input === wanted));
      if (found) reports.update((current) => current.filter((reported) => reported !== found));
      return found?.step;
    },
  };
};
