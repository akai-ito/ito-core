import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { toUsage } from "#capabilities/commands.ts";
import type { Offered } from "#capabilities/host.ts";

export const skillFile = (directory: string, id: string): string => path.join(directory, id, "SKILL.md");

export const toSkill = (capability: Offered, command: string): string =>
  [
    "---",
    `name: ${capability.id}`,
    `description: ${JSON.stringify(capability.manifest.summary)}`,
    "---",
    "",
    capability.manifest.skill.trim(),
    "",
    "## Commands",
    "",
    `Run them in the shell as \`${command} ${capability.id} <operation> --flag value\`; \`--help\` after any of them explains it.`,
    "",
    "```text",
    toUsage(command, capability.manifest),
    "```",
    "",
  ].join("\n");

// A capability with no operations, such as a mail account that Ito's own mail tools read, has no commands to
// offer, so the agent never hears of it: neither a skill file nor a line in the list.
const hasCommands = ({ manifest }: Offered): boolean => manifest.operations.length > 0;

export const writeSkills = (directory: string, capabilities: readonly Offered[], command: string): string => {
  const offered = capabilities.filter((capability) => hasCommands(capability));
  for (const capability of capabilities) {
    const file = skillFile(directory, capability.id);
    if (!hasCommands(capability)) {
      rmSync(path.dirname(file), { recursive: true, force: true });
      continue;
    }
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, toSkill(capability, command));
  }
  return offered.length === 0
    ? ""
    : [
        "",
        "## Capabilities",
        "",
        "These are switched on for you. Each has a skill file: read it before you first use the capability.",
        "",
        ...offered.map(({ id, manifest }) => `- ${id}: ${manifest.summary} (file: ${skillFile(directory, id)})`),
        "",
      ].join("\n");
};

export type OwnSkill = { readonly id: string; readonly summary: string; readonly text: string };

export const writeOwnSkills = (directory: string, skills: readonly OwnSkill[]): string => {
  for (const { id, text } of skills) {
    const file = skillFile(directory, id);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, text);
  }
  return skills.length === 0
    ? ""
    : [
        "",
        "## Skills",
        "",
        "Read a skill's file before you first do what it's for.",
        "",
        ...skills.map(({ id, summary }) => `- ${id}: ${summary} (file: ${skillFile(directory, id)})`),
        "",
      ].join("\n");
};
