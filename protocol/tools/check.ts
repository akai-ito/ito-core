import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadSpec, protocolDir, type Event, type Line } from "./spec.ts";

const LINE_KINDS = ["given", "app", "server", "event", "world"] as const;
const dir = join(protocolDir, "transcripts");
const spec = loadSpec();

function fail(where: string, problem: string): never {
  throw new Error(`${where}: ${problem}`);
}

function checkTranscript(file: string): void {
  const raw = readFileSync(join(dir, file), "utf8").trimEnd().split("\n");
  const [first, ...rest] = raw.map((text, index) => {
    try {
      return JSON.parse(text) as Line;
    } catch {
      return fail(`${file}:${index + 1}`, "not valid JSON");
    }
  });
  if (!first) fail(file, "empty");
  const name = file.replace(/\.jsonl$/, "");
  if (first.transcript !== name) fail(file, `header names ${String(first.transcript)}, not ${name}`);
  if (first.scenario !== Number(name.slice(0, 2))) fail(file, "header scenario doesn't match the file number");
  for (const field of ["title", "summary"]) {
    if (typeof first[field] !== "string" || !first[field]) fail(file, `header needs a ${field}`);
  }

  let previous = 0;
  let steps = false;
  for (const [index, line] of rest.entries()) {
    const where = `${file}:${index + 2}`;
    const kinds = LINE_KINDS.filter((kind) => kind in line);
    if (kinds.length !== 1) fail(where, `a line holds exactly one of ${LINE_KINDS.join(", ")}`);
    if (kinds[0] === "given") {
      if (steps) fail(where, "given events come before the first step");
      continue;
    }
    steps = true;
    if (typeof line.at !== "number") fail(where, "a step needs `at`, in milliseconds");
    if (line.at < previous) fail(where, `steps go back in time (${line.at} after ${previous})`);
    previous = line.at;
  }
  spec.checkLines(file, rest);

  const given = new Map<string, Event>();
  for (const line of rest) {
    const event = line.given as Event | undefined;
    if (event?.id) given.set(event.id, event);
  }
  const cursor = (first.app as { cursor?: string } | undefined)?.cursor;
  if (cursor !== undefined && !given.has(cursor))
    fail(file, `the app's cursor ${cursor} is not among the given events`);
  const applied = new Set<string>();
  if (cursor !== undefined) {
    for (const id of given.keys()) {
      applied.add(id);
      if (id === cursor) break;
    }
  }

  const texts = new Map<string, string>();
  const ended = new Set<string>();
  const running = new Set<string>();
  const apply = (event: Event, where: string): void => {
    const message = event.message;
    switch (event.type) {
      case "message.accepted":
      case "message.started": {
        const { id, text } = message as { id: string; text: string };
        if (texts.has(id)) fail(where, `message ${id} begins twice`);
        texts.set(id, text);
        break;
      }
      case "message.delta": {
        const text = texts.get(message as string);
        if (text === undefined) fail(where, `text for unknown message ${String(message)}`);
        if (ended.has(message as string)) fail(where, `text after ${String(message)} ended`);
        if (event.offset !== text.length) {
          fail(where, `offset ${String(event.offset)}, but the text so far has length ${text.length}`);
        }
        texts.set(message as string, text + String(event.text));
        break;
      }
      case "message.ended": {
        const text = texts.get(message as string);
        if (text === undefined) fail(where, `end of unknown message ${String(message)}`);
        const length = event.length as number;
        if (length > text.length) fail(where, `length ${length} is longer than the text (${text.length})`);
        if (event.outcome === "completed" && length !== text.length)
          fail(where, "a completed message keeps all its text");
        texts.set(message as string, text.slice(0, length));
        ended.add(message as string);
        break;
      }
      case "turn.started":
        running.add(event.turn as string);
        break;
      case "turn.ended":
        if (!running.delete(event.turn as string)) fail(where, `turn ${String(event.turn)} ended without starting`);
        break;
      default:
        break;
    }
  };

  for (const id of applied) apply(given.get(id) as Event, `${file} (given ${id})`);
  const delivered = new Set<string>();
  for (const [index, line] of rest.entries()) {
    const where = `${file}:${index + 2}`;
    const event = line.event as Event | undefined;
    if (!event) continue;
    if (event.type === "snapshot") {
      texts.clear();
      running.clear();
      for (const message of event.messages as { id: string; text: string; outcome?: string }[]) {
        texts.set(message.id, message.text);
        if (message.outcome) ended.add(message.id);
      }
      const turn = event.turn as { id: string } | null;
      if (turn) running.add(turn.id);
      continue;
    }
    if (!event.id) fail(where, "only a snapshot may lack an id");
    if (delivered.has(event.id)) fail(where, `event ${event.id} is delivered twice`);
    if (applied.has(event.id)) fail(where, `event ${event.id} is delivered again after the app applied it`);
    const earlier = given.get(event.id);
    if (earlier && JSON.stringify(earlier) !== JSON.stringify(event)) {
      fail(where, `event ${event.id} differs from the server's copy`);
    }
    delivered.add(event.id);
    apply(event, where);
  }
  if (running.size) fail(file, `turns never end: ${[...running].join(", ")}`);
}

function guaranteesByScenario(): Map<number, Set<string>> {
  const byScenario = new Map<number, Set<string>>();
  for (const line of readFileSync(join(protocolDir, "guarantees.md"), "utf8").split("\n")) {
    const row = /^\| (G\d+) \|.*\| ([\d, ]+) \|$/.exec(line.trim());
    if (!row?.[1] || !row[2]) continue;
    for (const scenario of row[2].split(",").map(Number)) {
      byScenario.set(scenario, (byScenario.get(scenario) ?? new Set()).add(row[1]));
    }
  }
  return byScenario;
}

function checkGuaranteesMatch(file: string, table: Map<number, Set<string>>): void {
  const header = JSON.parse(readFileSync(join(dir, file), "utf8").split("\n")[0] ?? "{}") as {
    scenario: number;
    guarantees: string[];
  };
  const listed = [...header.guarantees].sort().join(", ");
  const expected = [...(table.get(header.scenario) ?? [])].sort().join(", ");
  if (listed !== expected) fail(file, `lists guarantees [${listed}], but guarantees.md gives it [${expected}]`);
}

const files = readdirSync(dir)
  .filter((file) => file.endsWith(".jsonl"))
  .sort();
const numbers = files.map((file) => Number(file.slice(0, 2)));
const missing = Array.from({ length: 15 }, (_, i) => i + 1).filter((n) => !numbers.includes(n));
let failed = missing.length > 0;
if (failed) console.error(`missing transcripts for scenarios ${missing.join(", ")}`);
const table = guaranteesByScenario();
for (const file of files) {
  try {
    checkTranscript(file);
    checkGuaranteesMatch(file, table);
    console.log(`ok    ${file}`);
  } catch (error) {
    failed = true;
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      process.env.GITHUB_ACTIONS ? `::error file=protocol/transcripts/${file}::${message}` : `FAIL  ${message}`,
    );
  }
}
process.exit(failed ? 1 : 0);
