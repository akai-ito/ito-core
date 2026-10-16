import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { protocolDirectory } from "#protocol/schemas.ts";
import type { Event } from "#protocol/types.ts";
import type { LoggedEvent } from "#store/projection.ts";

export type Header = {
  readonly transcript: string;
  readonly start: string;
  readonly scenario: number;
  readonly title: string;
};

export type AppRequest = {
  readonly method: string;
  readonly path: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: unknown;
  readonly body_file?: string;
  readonly body_size?: number;
};

export type ServerResponse = {
  readonly status: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: unknown;
};

export type Step =
  | { readonly at: number; readonly app: AppRequest }
  | { readonly at: number; readonly server: ServerResponse; readonly lost?: boolean }
  | { readonly at: number; readonly event: Event }
  | { readonly at: number; readonly world: string; readonly until?: number; readonly to?: string }
  | { readonly at: number; readonly push: TranscriptPush };

export type TranscriptPush = { readonly device: string; readonly level: string; readonly notification: unknown };

export type Transcript = {
  readonly header: Header;
  readonly given: readonly LoggedEvent[];
  readonly steps: readonly Step[];
};

const transcriptDirectory = path.join(protocolDirectory, "transcripts");

export const transcriptNames = (): readonly string[] =>
  readdirSync(transcriptDirectory)
    .filter((file) => file.endsWith(".jsonl"))
    .toSorted((left, right) => left.localeCompare(right))
    .map((file) => file.replace(/\.jsonl$/u, ""));

export const readTranscript = (name: string): Transcript => {
  const [header, ...lines] = readFileSync(path.join(transcriptDirectory, `${name}.jsonl`), "utf8")
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line) as Readonly<Record<string, unknown>>);
  return {
    header: header as Header,
    given: lines.filter((line) => "given" in line).map((line) => line.given as LoggedEvent),
    steps: lines.filter((line) => !("given" in line)) as unknown as readonly Step[],
  };
};
