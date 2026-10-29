import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { protocolDirectory } from "#protocol/schemas.ts";
import { loadSpec, type Line } from "./spec.ts";
import { byCodeUnits, fixtureDirectory, listTranscriptFiles, transcriptDirectory } from "./transcript-files.ts";

type Order = { readonly previousAt: number; readonly hasSteps: boolean };

type GuaranteeTable = ReadonlyMap<number, ReadonlySet<string>>;

type GuaranteeHeader = { readonly scenario: number; readonly guarantees: readonly string[] };

const lineKinds = ["given", "app", "server", "event", "world", "push", "socket"] as const;
const spec = loadSpec();

const failure = (where: string, problem: string): Error => new Error(`${where}: ${problem}`);

const hasText = (value: unknown): boolean => typeof value === "string" && value !== "";

const toLines = (file: string, content: string): readonly Line[] =>
  content
    .trimEnd()
    .split("\n")
    .map((text, index) => {
      try {
        return JSON.parse(text) as Line;
      } catch {
        throw failure(`${file}:${index + 1}`, "not valid JSON");
      }
    });

const checkHeader = (file: string, header: Line | undefined): Line => {
  if (!header) throw failure(file, "empty");
  const name = file.replace(/\.jsonl$/, "");
  if (header.transcript !== name) throw failure(file, `header names ${String(header.transcript)}, not ${name}`);
  if (header.scenario !== Number(name.slice(0, 2))) {
    throw failure(file, "header scenario doesn't match the file number");
  }
  const missing = (["title", "summary"] as const).find((field) => !hasText(header[field]));
  if (missing) throw failure(file, `header needs a ${missing}`);
  return header;
};

const checkOrder = (file: string, lines: readonly Line[]): void => {
  lines.reduce<Order>(
    (order, line, index) => {
      const where = `${file}:${index + 2}`;
      const kinds = lineKinds.filter((kind) => Object.hasOwn(line, kind));
      if (kinds.length !== 1) throw failure(where, `a line holds exactly one of ${lineKinds.join(", ")}`);
      if (kinds[0] === "given") {
        if (order.hasSteps) throw failure(where, "given events come before the first step");
        return order;
      }
      if (typeof line.at !== "number") throw failure(where, "a step needs `at`, in milliseconds");
      if (line.at < order.previousAt) {
        throw failure(where, `steps go back in time (${line.at} after ${order.previousAt})`);
      }
      return { previousAt: line.at, hasSteps: true };
    },
    { previousAt: 0, hasSteps: false },
  );
};

const checkFixtures = (file: string, lines: readonly Line[]): void => {
  const missing = lines
    .flatMap((line) => [
      (line.app as { readonly body_file?: string } | undefined)?.body_file,
      (line.socket as { readonly audio?: string } | undefined)?.audio,
    ])
    .find((name) => name !== undefined && !existsSync(path.join(fixtureDirectory, name)));
  if (missing) throw failure(file, `the fixture ${missing} isn't in transcripts/files`);
};

const checkTranscript = (file: string, content: string): Line => {
  const [first, ...lines] = toLines(file, content);
  const header = checkHeader(file, first);
  checkOrder(file, lines);
  checkFixtures(file, lines);
  spec.checkLines(file, lines);
  return header;
};

const toGuaranteeTable = (markdown: string): GuaranteeTable =>
  markdown
    .split("\n")
    .flatMap((line) => {
      const [, guarantee, scenarios] = /^\| (G\d+) \|.*\| ([\d, ]+) \|$/.exec(line.trim()) ?? [];
      return guarantee && scenarios
        ? scenarios.split(",").map((scenario) => [Number(scenario), guarantee] as const)
        : [];
    })
    .reduce<GuaranteeTable>(
      (table, [scenario, guarantee]) =>
        new Map(table).set(scenario, new Set([...(table.get(scenario) ?? []), guarantee])),
      new Map(),
    );

const checkGuarantees = (file: string, header: GuaranteeHeader, table: GuaranteeTable): void => {
  const listed = [...header.guarantees].toSorted(byCodeUnits).join(", ");
  const expected = [...(table.get(header.scenario) ?? [])].toSorted(byCodeUnits).join(", ");
  if (listed !== expected) {
    throw failure(file, `lists guarantees [${listed}], but guarantees.md gives it [${expected}]`);
  }
};

const files = listTranscriptFiles();
const table = toGuaranteeTable(readFileSync(path.join(protocolDirectory, "guarantees.md"), "utf8"));

const problemIn = (file: string): string | undefined => {
  try {
    const header = checkTranscript(file, readFileSync(path.join(transcriptDirectory, file), "utf8"));
    checkGuarantees(file, header as GuaranteeHeader, table);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
};

const results = files.map((file) => ({ file, problem: problemIn(file) }));
for (const { file, problem } of results) {
  if (problem === undefined) {
    console.log(`ok    ${file}`);
    continue;
  }
  console.error(
    process.env.GITHUB_ACTIONS ? `::error file=protocol/transcripts/${file}::${problem}` : `FAIL  ${problem}`,
  );
}
process.exitCode = results.some(({ problem }) => problem !== undefined) ? 1 : 0;
