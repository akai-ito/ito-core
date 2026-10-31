import { createCell } from "#cell.ts";
import { toTurnId, type TurnId } from "#conversation/ids.ts";
import type { Complete, JsonSchema } from "#engine/engine.ts";
import { createQuickChoice } from "#engine/quick-model.ts";
import type { ModelOption, Topic } from "#protocol/types.ts";
import { withoutBlocks } from "#replies/blocks.ts";
import type { Result } from "#result.ts";
import type { Exchange, Store } from "#store/store.ts";
import { fieldOf, textOf } from "#tools/input.ts";
import type { Info } from "#turns/turns.ts";

export type Topics = {
  readonly idle: () => Promise<void>;
  readonly close: () => void;
};

export type TopicsOptions = {
  readonly store: Pick<Store, "subscribe" | "exchanges" | "listTopics" | "startTopic" | "setting" | "setSetting">;
  readonly complete: Complete;
  readonly models: () => Promise<Result<readonly ModelOption[], string>>;
  readonly info: Info;
};

export const historySetting = "topics_history";

const historyDone = "done";

const exchangesPerBatch = 40;

const mostWords = 4;

const decisionSchema: JsonSchema = {
  type: "object",
  properties: { changed: { type: "boolean" }, label: { type: "string" } },
  required: ["changed", "label"],
  additionalProperties: false,
};

const historySchema: JsonSchema = {
  type: "object",
  properties: {
    labels: {
      type: "array",
      items: {
        type: "object",
        properties: { exchange: { type: "integer" }, label: { type: "string" } },
        required: ["exchange", "label"],
        additionalProperties: false,
      },
    },
  },
  required: ["labels"],
  additionalProperties: false,
};

const currentAt = (topics: readonly Topic[], position: number): Topic | undefined =>
  topics.findLast((topic) => topic.position < position);

const rules = (topics: readonly Topic[], current: Topic | undefined): readonly string[] => {
  const labels = [...new Set(topics.map(({ label }) => label).toReversed())];
  return [
    '- A new subject gets a label of one to four plain words, such as "Florence trip" or "QRT panel".',
    "- When they come back to an earlier subject, use its label exactly as before.",
    "- More on the same subject, small talk, thanks or a follow-up starts nothing new.",
    "",
    `Labels so far: ${labels.length === 0 ? "none" : labels.map((label) => JSON.stringify(label)).join(", ")}.`,
    `The subject now: ${current ? JSON.stringify(current.label) : "none yet"}.`,
  ];
};

const toLines = ({ said, answered }: Exchange, indent = ""): readonly string[] => [
  `${indent}They said: ${said}`,
  `${indent}Ari answered: ${withoutBlocks(answered) || "(nothing)"}`,
];

const opening = [
  "You keep the subjects of a conversation between a person and Ari, their assistant, so they can find their",
  "way back to them.",
];

export const toDecisionPrompt = (
  latest: Exchange,
  before: Exchange | undefined,
  topics: readonly Topic[],
  current: Topic | undefined,
): string =>
  [
    ...opening,
    "Decide whether their latest message starts a new subject.",
    "",
    ...rules(topics, current),
    ...(before ? ["", "Before it:", ...toLines(before)] : []),
    "",
    "Their latest message, and Ari's answer:",
    ...toLines(latest),
    "",
    'Answer with changed, and the label, or "" when nothing changed.',
  ].join("\n");

export const toHistoryPrompt = (
  batch: readonly Exchange[],
  topics: readonly Topic[],
  current: Topic | undefined,
): string =>
  [
    ...opening,
    "Here is a stretch of it, exchange by exchange. Say which exchanges start a new subject.",
    "",
    ...rules(topics, current),
    "",
    ...batch.flatMap((exchange, index) => [`${String(index + 1)}.`, ...toLines(exchange, " ".repeat(3))]),
    "",
    "Answer with labels: an exchange's number and its label, for each one that starts a subject.",
  ].join("\n");

const toLabel = (given: string, topics: readonly Topic[]): string | undefined => {
  const label = given
    .replaceAll(/\s+/gu, " ")
    .trim()
    .replaceAll(/^["“]|["”]$/gu, "");
  const words = label === "" ? 0 : label.split(" ").length;
  return words === 0 || words > mostWords
    ? undefined
    : (topics.find((topic) => topic.label.toLowerCase() === label.toLowerCase())?.label ?? label);
};

export const createTopics = ({ store, complete, models, info }: TopicsOptions): Topics => {
  const queue = createCell<Promise<void>>(Promise.resolve());
  const isClosed = createCell(false);

  const enqueue = (work: () => Promise<void>): void => {
    void queue.update(async (previous) => {
      await previous;
      if (isClosed.get()) return;
      try {
        await work();
      } catch (error) {
        info("Ito couldn't keep the conversation's topics", { error: String(error) });
      }
    });
  };

  const quickChoice = createQuickChoice(models);

  const begin = (exchange: Exchange, given: string): void => {
    const topics = store.listTopics();
    const label = toLabel(given, topics);
    if (label === undefined || label === currentAt(topics, exchange.position)?.label) return;
    store.startTopic(exchange.position, label);
  };

  const labelTurn = async (turn: TurnId): Promise<void> => {
    const recent = store.exchanges(turn, 2);
    const latest = recent.at(-1);
    if (latest?.turn !== turn || latest.said.trim() === "") return;
    const before = recent.length > 1 ? recent[0] : undefined;
    const topics = store.listTopics();
    if (topics.some(({ position }) => position === latest.position)) return;
    const prompt = toDecisionPrompt(latest, before, topics, currentAt(topics, latest.position));
    const answered = await complete(prompt, decisionSchema, await quickChoice());
    if (isClosed.get()) return;
    if (!answered.ok) {
      info("Ito couldn't decide a turn's topic", { turn, error: answered.failure });
      return;
    }
    if (fieldOf(answered.value, "changed") === true) begin(latest, textOf(answered.value, "label"));
  };

  const labelHistory = async (history: readonly Exchange[]): Promise<void> => {
    const done = store.setting(historySetting);
    if (done === historyDone) return;
    const after = done === undefined ? -1 : Number(done);
    const batch = history
      .filter(({ position, said }) => position > after && said.trim() !== "")
      .slice(0, exchangesPerBatch);
    const [first] = batch;
    if (!first) {
      store.setSetting(historySetting, historyDone);
      return;
    }
    const topics = store.listTopics();
    const prompt = toHistoryPrompt(batch, topics, currentAt(topics, first.position));
    const answered = await complete(prompt, historySchema, await quickChoice());
    if (isClosed.get()) return;
    if (!answered.ok) {
      info("Ito couldn't label the conversation's earlier topics yet", { error: answered.failure });
      return;
    }
    const labels = fieldOf(answered.value, "labels");
    const ordered = (Array.isArray(labels) ? (labels as readonly unknown[]) : [])
      .map((entry) => ({ exchange: batch[Number(fieldOf(entry, "exchange")) - 1], label: textOf(entry, "label") }))
      .filter((entry): entry is { readonly exchange: Exchange; readonly label: string } => entry.exchange !== undefined)
      .toSorted((left, right) => left.exchange.position - right.exchange.position);
    for (const { exchange, label } of ordered) begin(exchange, label);
    store.setSetting(historySetting, String(batch.at(-1)?.position ?? after));
    await labelHistory(history);
  };

  if (store.setting(historySetting) !== historyDone) {
    const history = store.exchanges(undefined, Number.MAX_SAFE_INTEGER);
    enqueue(() => labelHistory(history));
  }
  const unsubscribe = store.subscribe(({ event }) => {
    if (event.type === "turn.ended") enqueue(() => labelTurn(toTurnId(event.turn)));
  });

  return {
    idle: () => queue.get(),
    close: () => {
      isClosed.set(true);
      unsubscribe();
    },
  };
};
