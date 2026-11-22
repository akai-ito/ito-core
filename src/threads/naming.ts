import { createCell } from "#cell.ts";
import { toMessageId, toTurnId, type ThreadId, type TurnId } from "#conversation/ids.ts";
import type { Complete, JsonSchema } from "#engine/engine.ts";
import { createQuickChoice } from "#engine/quick-model.ts";
import type { ModelOption } from "#protocol/types.ts";
import { withoutBlocks } from "#replies/blocks.ts";
import type { Result } from "#result.ts";
import type { Exchange, Store } from "#store/store.ts";
import { textOf } from "#tools/input.ts";
import type { Info } from "#turns/turns.ts";

// Kumo names a thread you started (by replying to a message, or from Threads) once it has answered there, on the
// quick model, as topics were labelled before threads replaced them.
export type Naming = {
  readonly idle: () => Promise<void>;
  readonly close: () => void;
};

export type NamingOptions = {
  readonly store: Pick<Store, "subscribe" | "exchanges" | "findTurn" | "findThread" | "findMessage" | "changeThread">;
  readonly complete: Complete;
  readonly models: () => Promise<Result<readonly ModelOption[], string>>;
  readonly info: Info;
};

const mostWords = 5;

const nameSchema: JsonSchema = {
  type: "object",
  properties: { title: { type: "string" } },
  required: ["title"],
  additionalProperties: false,
};

const toLines = ({ said, answered }: Exchange): readonly string[] => [
  `They said: ${said}`,
  `Kumo answered: ${withoutBlocks(answered) || "(nothing)"}`,
];

export const toNamingPrompt = (exchanges: readonly Exchange[], replyingTo: string | undefined): string =>
  [
    "You name the side threads of a conversation between a person and Kumo, their assistant, so they can find them",
    "again later in a list of threads by day.",
    '- Name what the thread is about in one to five plain words, such as "Kiln menu", "V&A guide" or "Flat insurance".',
    "- Name the thing, not the request: no verbs like asking or planning, no quotes, no full stop.",
    ...(replyingTo === undefined ? [] : ["", `They started it by replying to this message: ${replyingTo}`]),
    "",
    "The thread so far:",
    ...exchanges.flatMap((exchange) => toLines(exchange)),
    "",
    "Answer with its title.",
  ].join("\n");

export const toTitle = (given: string): string | undefined => {
  const title = given
    .replaceAll(/\s+/gu, " ")
    .trim()
    .replaceAll(/^["“'‘]+|["”'’.]+$/gu, "");
  const words = title === "" ? 0 : title.split(" ").length;
  return words === 0 || words > mostWords ? undefined : title;
};

export const createNaming = ({ store, complete, models, info }: NamingOptions): Naming => {
  const queue = createCell<Promise<void>>(Promise.resolve());
  const isClosed = createCell(false);
  const quickChoice = createQuickChoice(models);

  const enqueue = (work: () => Promise<void>): void => {
    void queue.update(async (previous) => {
      await previous;
      if (isClosed.get()) return;
      try {
        await work();
      } catch (error) {
        info("Kumo couldn't name a thread", { error: String(error) });
      }
    });
  };

  const name = async (turn: TurnId, thread: ThreadId): Promise<void> => {
    const current = store.findThread(thread);
    if (!current || current.title !== undefined) return;
    const exchanges = store.exchanges(turn, 3, thread);
    if (exchanges.length === 0) return;
    const anchor = current.anchor === undefined ? undefined : store.findMessage(toMessageId(current.anchor));
    const replyingTo = anchor === undefined ? undefined : withoutBlocks(anchor.text).slice(0, 600) || undefined;
    const answered = await complete(toNamingPrompt(exchanges, replyingTo), nameSchema, await quickChoice());
    if (isClosed.get()) return;
    if (!answered.ok) {
      info("Kumo couldn't name a thread", { thread, error: answered.failure });
      return;
    }
    const title = toTitle(textOf(answered.value, "title"));
    if (title !== undefined && store.findThread(thread)?.title === undefined) {
      store.changeThread(thread, { by: "kumo", title });
    }
  };

  const unsubscribe = store.subscribe(({ event }) => {
    if (event.type !== "turn.ended" || event.outcome !== "completed") return;
    const turn = toTurnId(event.turn);
    const thread = store.findTurn(turn)?.thread;
    if (thread !== undefined && store.findThread(thread)?.title === undefined) enqueue(() => name(turn, thread));
  });

  return {
    idle: () => queue.get(),
    close: () => {
      isClosed.set(true);
      unsubscribe();
    },
  };
};
