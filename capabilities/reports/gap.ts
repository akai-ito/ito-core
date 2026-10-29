import { createHash } from "node:crypto";
import { fail, ok, type Result } from "#result.ts";

export type Gap = {
  readonly capability: string;
  readonly operation: string;
  readonly tried: string;
  readonly failed: string;
  readonly wouldHelp: string;
};

export type Versions = { readonly ito: string; readonly engine: string };

export type IssueText = { readonly title: string; readonly body: string };

const fields = ["capability", "operation", "tried", "failed", "would_help"] as const;

type Field = (typeof fields)[number];

const textOf = (input: unknown, field: Field): string => {
  const value: unknown = input && typeof input === "object" ? Reflect.get(input, field) : undefined;
  return typeof value === "string" ? value.trim() : "";
};

export const toGap = (input: unknown): Result<Gap, string> => {
  const missing = fields.filter((field) => textOf(input, field) === "");
  return missing.length > 0
    ? fail(`A report needs ${missing.join(", ")}.`)
    : ok({
        capability: textOf(input, "capability"),
        operation: textOf(input, "operation"),
        tried: textOf(input, "tried"),
        failed: textOf(input, "failed"),
        wouldHelp: textOf(input, "would_help"),
      });
};

const normalized = (text: string): string => text.trim().toLowerCase().replaceAll(/\s+/gu, " ");

export const toFingerprint = ({ capability, operation, wouldHelp }: Gap): string => {
  const hash = createHash("sha256").update([capability, operation, wouldHelp].map(normalized).join("\n"));
  return `gap-${hash.digest("hex").slice(0, 12)}`;
};

export const fingerprintLine = (fingerprint: string): string => `Fingerprint: ${fingerprint}`;

const versionLine = ({ ito, engine }: Versions): string => `Ito ${ito} · ${engine}`;

export const toIssue = (gap: Gap, versions: Versions): IssueText => ({
  title: `Gap: ${gap.capability} · ${gap.operation}`,
  body: [
    "Ari hit a gap and reported it.",
    "",
    `**Capability:** ${gap.capability}`,
    `**Operation:** ${gap.operation}`,
    `**Tried:** ${gap.tried}`,
    `**Failed:** ${gap.failed}`,
    `**Would have helped:** ${gap.wouldHelp}`,
    "",
    versionLine(versions),
    "",
    fingerprintLine(toFingerprint(gap)),
  ].join("\n"),
});

export const toComment = (gap: Gap, versions: Versions): string =>
  ["Hit again.", "", `**Tried:** ${gap.tried}`, `**Failed:** ${gap.failed}`, "", versionLine(versions)].join("\n");
