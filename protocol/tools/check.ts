import { readFileSync } from "node:fs";
import path from "node:path";
import { protocolDirectory } from "#protocol/schemas.ts";
import { loadSpec, type Event, type Line } from "./spec.ts";
import { byCodeUnits, listTranscriptFiles, transcriptDirectory } from "./transcript-files.ts";

type Order = { readonly previousAt: number; readonly hasSteps: boolean };

type Conversation = {
  readonly texts: ReadonlyMap<string, string>;
  readonly ended: ReadonlySet<string>;
  readonly running: ReadonlySet<string>;
  readonly steps: ReadonlyMap<string, StepState>;
  readonly lastPosition: number;
};

type StepState = { readonly turn: string; readonly position: number; readonly isEnded: boolean };

type Positioned = { readonly id: string; readonly position: number };

type SnapshotStep = Positioned & { readonly turn: string; readonly outcome?: string };

type Delivery = { readonly conversation: Conversation; readonly delivered: ReadonlySet<string> };

type SnapshotMessage = Positioned & { readonly text: string; readonly outcome?: string };

type GuaranteeTable = ReadonlyMap<number, ReadonlySet<string>>;

type GuaranteeHeader = { readonly scenario: number; readonly guarantees: readonly string[] };

const lineKinds = ["given", "app", "server", "event", "world"] as const;
const scenarioCount = 17;
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

const checkPosition = (conversation: Conversation, position: number, what: string, where: string): number => {
  if (position <= conversation.lastPosition) {
    throw failure(where, `${what} has position ${position}, not after ${conversation.lastPosition}`);
  }
  return position;
};

const startStep = (conversation: Conversation, step: SnapshotStep, where: string): Conversation => {
  if (conversation.steps.has(step.id)) throw failure(where, `step ${step.id} starts twice`);
  if (!conversation.running.has(step.turn)) throw failure(where, `step ${step.id} starts outside a running turn`);
  const position = checkPosition(conversation, step.position, `step ${step.id}`, where);
  return {
    ...conversation,
    steps: new Map(conversation.steps).set(step.id, { turn: step.turn, position, isEnded: false }),
    lastPosition: position,
  };
};

const changeStep = (conversation: Conversation, step: SnapshotStep, isEnding: boolean, where: string): Conversation => {
  const known = conversation.steps.get(step.id);
  if (!known) throw failure(where, `step ${step.id} changes without starting`);
  if (known.isEnded) throw failure(where, `step ${step.id} changes after it ended`);
  if (known.turn !== step.turn || known.position !== step.position) {
    throw failure(where, `step ${step.id} changed its turn or position`);
  }
  if (isEnding && !step.outcome) throw failure(where, `step ${step.id} ends without an outcome`);
  if (!isEnding && step.outcome) throw failure(where, `step ${step.id} has an outcome before it ends`);
  return { ...conversation, steps: new Map(conversation.steps).set(step.id, { ...known, isEnded: isEnding }) };
};

const applyEvent = (conversation: Conversation, event: Event, where: string): Conversation => {
  const { texts, ended, running } = conversation;
  const message = event.message;
  switch (event.type) {
    case "message.accepted":
    case "message.started": {
      const { id, text, position } = message as SnapshotMessage;
      if (texts.has(id)) throw failure(where, `message ${id} begins twice`);
      return {
        ...conversation,
        texts: new Map(texts).set(id, text),
        lastPosition: checkPosition(conversation, position, `message ${id}`, where),
      };
    }
    case "step.started": {
      return startStep(conversation, event.step as SnapshotStep, where);
    }
    case "step.updated": {
      return changeStep(conversation, event.step as SnapshotStep, false, where);
    }
    case "step.ended": {
      return changeStep(conversation, event.step as SnapshotStep, true, where);
    }
    case "message.delta": {
      const id = message as string;
      const text = texts.get(id);
      if (text === undefined) throw failure(where, `text for unknown message ${String(message)}`);
      if (ended.has(id)) throw failure(where, `text after ${String(message)} ended`);
      if (event.offset !== text.length) {
        throw failure(where, `offset ${String(event.offset)}, but the text so far has length ${text.length}`);
      }
      return { ...conversation, texts: new Map(texts).set(id, text + String(event.text)) };
    }
    case "message.ended": {
      const id = message as string;
      const text = texts.get(id);
      if (text === undefined) throw failure(where, `end of unknown message ${String(message)}`);
      const length = event.length as number;
      if (length > text.length) throw failure(where, `length ${length} is longer than the text (${text.length})`);
      if (event.outcome === "completed" && length !== text.length) {
        throw failure(where, "a completed message keeps all its text");
      }
      return { ...conversation, texts: new Map(texts).set(id, text.slice(0, length)), ended: new Set([...ended, id]) };
    }
    case "turn.started": {
      return { ...conversation, running: new Set([...running, event.turn as string]) };
    }
    case "turn.ended": {
      const turn = event.turn as string;
      if (!running.has(turn)) throw failure(where, `turn ${String(event.turn)} ended without starting`);
      const unfinished = [...conversation.steps].find(([, step]) => step.turn === turn && !step.isEnded);
      if (unfinished) throw failure(where, `turn ${turn} ended with step ${unfinished[0]} still running`);
      return { ...conversation, running: new Set([...running].filter((candidate) => candidate !== turn)) };
    }
    default: {
      return conversation;
    }
  }
};

const checkAscending = (entries: readonly Positioned[], what: string, where: string): void => {
  entries.reduce((previous, entry) => {
    if (entry.position <= previous) throw failure(where, `snapshot ${what} out of position order at ${entry.id}`);
    return entry.position;
  }, 0);
};

const applySnapshot = (conversation: Conversation, event: Event, where: string): Conversation => {
  const messages = event.messages as readonly SnapshotMessage[];
  const steps = event.steps as readonly SnapshotStep[];
  const turn = event.turn as { readonly id: string } | null;
  checkAscending(messages, "messages", where);
  checkAscending(steps, "steps", where);
  const first = messages[0]?.position ?? Infinity;
  const early = steps.find((step) => step.position < first);
  if (early) throw failure(where, `snapshot step ${early.id} comes before its first message`);
  const stray = steps.find((step) => !step.outcome && step.turn !== turn?.id);
  if (stray) throw failure(where, `snapshot step ${stray.id} is running outside the running turn`);
  return {
    texts: new Map(messages.map((message) => [message.id, message.text])),
    ended: new Set([
      ...conversation.ended,
      ...messages.filter((message) => Boolean(message.outcome)).map((message) => message.id),
    ]),
    running: new Set(turn ? [turn.id] : []),
    steps: new Map(
      steps.map((step) => [step.id, { turn: step.turn, position: step.position, isEnded: Boolean(step.outcome) }]),
    ),
    lastPosition: Math.max(0, ...messages.map((message) => message.position), ...steps.map((step) => step.position)),
  };
};

const checkDelivery = (file: string, header: Line, lines: readonly Line[]): void => {
  const given = new Map(
    lines.flatMap((line) => {
      const event = line.given as Event | undefined;
      return event?.id ? [[event.id, event] as const] : [];
    }),
  );
  const cursor = (header.app as { readonly cursor?: string } | undefined)?.cursor;
  if (cursor !== undefined && !given.has(cursor)) {
    throw failure(file, `the app's cursor ${cursor} is not among the given events`);
  }
  const givenEntries = [...given];
  const appliedEntries =
    cursor === undefined ? [] : givenEntries.slice(0, givenEntries.findIndex(([id]) => id === cursor) + 1);
  const applied = new Set(appliedEntries.map(([id]) => id));
  const appliedConversation = appliedEntries.reduce<Conversation>(
    (conversation, [id, event]) => applyEvent(conversation, event, `${file} (given ${id})`),
    { texts: new Map(), ended: new Set(), running: new Set(), steps: new Map(), lastPosition: 0 },
  );

  const deliver = ({ conversation, delivered }: Delivery, line: Line, index: number): Delivery => {
    const where = `${file}:${index + 2}`;
    const event = line.event as Event | undefined;
    if (!event) return { conversation, delivered };
    if (event.type === "snapshot") return { conversation: applySnapshot(conversation, event, where), delivered };
    if (!event.id) throw failure(where, "only a snapshot may lack an id");
    if (delivered.has(event.id)) throw failure(where, `event ${event.id} is delivered twice`);
    if (applied.has(event.id)) throw failure(where, `event ${event.id} is delivered again after the app applied it`);
    const earlier = given.get(event.id);
    if (earlier && JSON.stringify(earlier) !== JSON.stringify(event)) {
      throw failure(where, `event ${event.id} differs from the server's copy`);
    }
    return { conversation: applyEvent(conversation, event, where), delivered: new Set([...delivered, event.id]) };
  };

  const { running } = lines.reduce<Delivery>(deliver, {
    conversation: appliedConversation,
    delivered: new Set(),
  }).conversation;
  if (running.size > 0) throw failure(file, `turns never end: ${[...running].join(", ")}`);
};

const checkTranscript = (file: string, content: string): Line => {
  const [first, ...lines] = toLines(file, content);
  const header = checkHeader(file, first);
  checkOrder(file, lines);
  spec.checkLines(file, lines);
  checkDelivery(file, header, lines);
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
const numbers = new Set(files.map((file) => Number(file.slice(0, 2))));
const missing = Array.from({ length: scenarioCount }, (_, index) => index + 1).filter(
  (scenario) => !numbers.has(scenario),
);
if (missing.length > 0) console.error(`missing transcripts for scenarios ${missing.join(", ")}`);
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
process.exitCode = missing.length > 0 || results.some(({ problem }) => problem !== undefined) ? 1 : 0;
