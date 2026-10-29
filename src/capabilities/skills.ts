import { mkdirSync, writeFileSync } from "node:fs";
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

export const writeSkills = (directory: string, offered: readonly Offered[], command: string): string => {
  for (const capability of offered) {
    const file = skillFile(directory, capability.id);
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
