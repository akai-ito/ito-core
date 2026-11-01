import path from "node:path";
import { createCell } from "#cell.ts";
import { splitCommand, toInput } from "#capabilities/commands.ts";
import type { Host } from "#capabilities/host.ts";
import type { Operation } from "#capabilities/manifest.ts";
import type { StepEnd, StepStart, Trail } from "#conversation/steps.ts";
import type { StepFacts } from "#engine/engine.ts";
import type { Groups, RunTitle } from "#tools/groups.ts";
import type { ToolStep } from "#tools/mcp.ts";
import { toolServerName } from "#tools/mcp.ts";

// An operation a step ran: a capability's, or one of Ito's own, which says what it did in its own words.
type Found = { readonly id: string; readonly operation: Operation; readonly run?: RunTitle; readonly isOwn: boolean };

type Call = { readonly tool: string; readonly input: unknown };

// Steps whose end never came, such as ones a restart cut off, are forgotten past this many.
const mostCalls = 200;

const lastLine = (text: string | undefined): string | undefined =>
  text
    ?.split("\n")
    .map((line) => line.trim())
    .findLast(Boolean);

// Ito's own tools say what they did in the title and the details, so their raw arguments stay off the trail.
const asOperation = ({ id, operation, run, isOwn }: Found, input: unknown): StepStart => ({
  kind: "tool",
  facts: {
    capability: id,
    operation: operation.name,
    ...(!isOwn && input !== undefined && { arguments: input }),
    ...(run !== undefined && { run_title: run }),
  },
});

const toFacts = ({ note, tally, mails = [] }: ToolStep): StepFacts => ({
  ...(note !== undefined && note !== "" && { note }),
  ...(tally !== undefined && { tally }),
  ...(mails.length > 0 && { mails }),
});

// A command too shell-shaped to split, such as a draft whose body has quotes in it, still names its
// program, group and operation first.
const leadingWords = (command: string): readonly string[] =>
  /^\s*(?<program>\S+)\s+(?<id>[a-z][\w-]*)\s+(?<name>[a-z][\w-]*)/u.exec(command)?.slice(1) ?? [];

export const createTrail = (host: Host, command: string, groups?: Groups): Trail => {
  const calls = createCell<ReadonlyMap<string, Call>>(new Map());

  const findOffered = (id: string, name: string): Found | undefined => {
    const capability = host.offered().find((candidate) => candidate.id === id);
    const operation = capability?.manifest.operations.find((candidate) => candidate.name === name);
    if (capability && operation) return { id: capability.id, operation, isOwn: false };
    const grouped = groups?.find(id, name);
    return grouped && { id: grouped.group.id, operation: grouped.operation, run: grouped.run, isOwn: true };
  };

  const findTool = (tool: string): Found | undefined => {
    const offered = host
      .offered()
      .flatMap((capability) =>
        capability.manifest.operations
          .filter((operation) => operation.tool === tool)
          .map((operation) => ({ id: capability.id, operation, isOwn: false })),
      )
      .at(0);
    const grouped = offered ? undefined : groups?.findTool(tool);
    return (
      offered ?? (grouped && { id: grouped.group.id, operation: grouped.operation, run: grouped.run, isOwn: true })
    );
  };

  const findCommand = (words: readonly string[]): Found | undefined => {
    const [program = "", id = "", name = ""] = words;
    return program === command || path.basename(program) === "ito" ? findOffered(id, name) : undefined;
  };

  // Remembers which of Ito's own tools a step called, with what, so its end can say what the call did.
  const started = (key: string | undefined, found: Found, input: unknown): StepStart => {
    const { tool } = found.operation;
    if (key !== undefined && tool !== undefined && found.isOwn) {
      calls.update((current) => new Map([...current, [key, { tool, input }] as const].slice(-mostCalls)));
    }
    return asOperation(found, input);
  };

  const commandEnd = (step: Parameters<Trail["toEnd"]>[0], end: StepEnd): StepEnd => {
    const { exit_code: exitCode, output } = end.facts;
    if (exitCode === undefined || step.kind !== "tool") return end;
    const detail = lastLine(output);
    return exitCode === 0
      ? { outcome: end.outcome, facts: {} }
      : { outcome: "failed", facts: detail === undefined ? {} : { detail } };
  };

  return {
    toStart: (start, key) => {
      const { kind, facts } = start;
      if (kind === "tool" && facts.capability === toolServerName) {
        const found = findTool(facts.operation ?? "");
        return found ? started(key, found, facts.arguments) : start;
      }
      if (kind !== "command") return start;
      const words = splitCommand(facts.command ?? "");
      const found = findCommand(words ?? leadingWords(facts.command ?? ""));
      if (!found) return start;
      const input = words && toInput(found.operation.input, words.slice(3));
      return started(key, found, input?.ok === true ? input.value : undefined);
    },
    toEnd: (step, end, key) => {
      const call = key === undefined ? undefined : calls.get().get(key);
      if (call) calls.update((current) => new Map([...current].filter(([known]) => known !== key)));
      const ended = commandEnd(step, end);
      const said = call && ended.outcome === "completed" ? groups?.report(call.tool, call.input) : undefined;
      return said === undefined
        ? ended
        : { outcome: ended.outcome, facts: { ...ended.facts, ...toFacts(said) }, title: said.title };
    },
    titleOf: (capability, operation) => {
      const found = findOffered(capability, operation)?.operation;
      return found && { present: found.running, past: found.done };
    },
  };
};
