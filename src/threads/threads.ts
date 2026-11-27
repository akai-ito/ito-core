import { toMessageId, toThreadId, type MessageId, type ThreadId } from "#conversation/ids.ts";
import type { Message, Thread } from "#protocol/types.ts";
import { withoutBlocks } from "#replies/blocks.ts";
import { lineOf } from "#notifications/text.ts";
import type { Store } from "#store/store.ts";
import { contextRun, contextThread } from "#tools/context.ts";
import { fieldOf, textOf } from "#tools/input.ts";
import type { Tool, ToolResult } from "#tools/mcp.ts";

// What each conversation knows of the others, and Kumo's tools for side threads. A side thread is a conversation of
// its own: it sees the in-mind pages, where it hangs from and the open threads, written here from the store as it
// is, so it never goes stale and costs no model call; what was said elsewhere today comes with today so far. The
// main chat sees the open threads.

export type ThreadsOptions = {
  readonly store: Store;
  // When something happened, in their time zone and plain words, such as "Saturday 21 November, 12:41".
  readonly spoken: (at: string) => string;
  // Kumo moved messages out of the main chat's running turn into a thread of their own; true when that was all the
  // turn had, so it ends here.
  readonly branched: (thread: ThreadId, moved: readonly MessageId[], brief: string) => boolean;
};

export type ThreadsContext = {
  // For a turn in the main chat (no thread) or in a side thread.
  readonly inMindText: (thread: ThreadId | undefined) => string;
  // For background work, which doesn't see the chat.
  readonly backgroundText: () => string;
  readonly tools: readonly Tool[];
};

const readMessages = 20;
const readLength = 600;
const postLength = 1500;
const mostTitleWords = 5;
const mostResultLength = 90;

const failed = (text: string): ToolResult => ({ text, isError: true });

// A message's words on one line, without its blocks, cut to fit.
export const squeeze = (text: string, most: number): string => {
  const plain = withoutBlocks(text).replaceAll(/\s+/gu, " ").trim();
  return plain.length > most ? `${plain.slice(0, most)}…` : plain;
};

const nameOf = (thread: Thread): string =>
  thread.title === undefined ? "a thread not yet named" : `“${thread.title}”`;

const whoSaid = (message: Message): string => (message.role === "user" ? "they" : "you");

const isTitle = (title: string): boolean => title.split(/\s+/u).filter(Boolean).length <= mostTitleWords;

export const createThreads = ({ store, spoken, branched }: ThreadsOptions): ThreadsContext => {
  const toLine = (message: Message, most: number): string =>
    `- ${spoken(message.at)}, ${whoSaid(message)}: ${squeeze(message.text, most) || lineOf("", message.attachments)}`;

  const openLines = (except: ThreadId | undefined): readonly string[] =>
    store
      .openThreads()
      .filter(({ id }) => id !== except)
      .map(
        (thread) =>
          `- ${thread.id}, ${nameOf(thread)}, last ${spoken(thread.last_at)}` +
          (thread.result === undefined ? "" : `: ${thread.result}`),
      );

  const mainText = (): string => {
    const open = openLines(undefined);
    return open.length === 0
      ? ""
      : [
          "<threads>",
          "Their open side threads, each a conversation of its own. Read one with read_thread; mark one done, or say",
          "where it stands, with update_thread; your background work comes back to one by posting there.",
          ...open,
          "</threads>",
        ].join("\n");
  };

  const sideText = (id: ThreadId): string => {
    const thread = store.findThread(id);
    if (!thread) return "";
    const anchor = thread.anchor === undefined ? undefined : store.findMessage(toMessageId(thread.anchor));
    const open = openLines(id);
    return [
      "<thread>",
      `You're in a side thread with them, ${nameOf(thread)} (${thread.id}), ${thread.state === "done" ? "marked done" : "open"}.`,
      "It's a conversation of its own: answer here. The main chat and their other threads go on without it, and",
      "you don't need to repeat here what's said there. Its line shows under its name in their list of threads: keep",
      'it to where it stands now, in a few words such as "3 of 9 spotted" or "Waiting for a restock in your size",',
      "with update_thread's result whenever that changes. When its question is answered or its task is finished,",
      "mark it done with a line on how it ended.",
      thread.result === undefined
        ? "It has no line yet: give it one once you've answered."
        : `Its line now: “${thread.result}”.`,
      ...(anchor
        ? ["", `They started it by replying to this message in the main chat:`, toLine(anchor, readLength)]
        : []),
      ...(open.length > 0 ? ["", "Their other open threads:", ...open] : []),
      "</thread>",
    ].join("\n");
  };

  const backgroundText = (): string => {
    const open = openLines(undefined);
    return open.length === 0
      ? ""
      : [
          "<threads>",
          "Their open side threads. What you have to say about one belongs in it: post with its thread id. Read one",
          "with read_thread first.",
          ...open,
          "</threads>",
        ].join("\n");
  };

  const startThread: Tool = {
    name: "start_thread",
    title: "Start a side thread",
    description:
      "Move a subject out of the main chat into a side thread of its own, which answers it in its own conversation, " +
      "while the main chat stays their life with you. Branch for a clear one-off (a menu photo, a quick lookup), a " +
      "new subject that starts mid-flow (the old one stays open where it was), or long work (a document, a " +
      "comparison). Call it before you say anything: their message moves into the thread and the main chat keeps a " +
      "line for it. When it was all you were answering, your turn ends there and writes nothing more. Only from the " +
      "main chat; threads don't nest.",
    inputSchema: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: 'One to five plain words for what it\'s about, such as "Kiln menu" or "V&A guide".',
        },
        move: {
          enum: ["all", "latest"],
          description:
            "`all` (the default) moves everything you're answering; `latest` moves only the newest message they " +
            "sent, such as a new subject that arrived while you were working on something else.",
        },
        brief: {
          type: "string",
          description: "Anything the thread should know that their message doesn't say, from the main chat.",
        },
      },
      required: ["title"],
      additionalProperties: false,
    },
    call: (input) => {
      if (contextRun() !== undefined) return Promise.resolve(failed("Background work posts in a thread instead."));
      if (contextThread() !== undefined) return Promise.resolve(failed("Threads don't nest: answer here."));
      const title = textOf(input, "title").replaceAll(/\s+/gu, " ").trim();
      if (title === "" || !isTitle(title)) return Promise.resolve(failed("Give a title of one to five words."));
      const turn = store.runningTurn();
      if (!turn) return Promise.resolve(failed("You can only start a thread while answering them."));
      const answering = [...turn.inputs, ...turn.read].filter(
        (message) => store.findMessage(message)?.thread === undefined,
      );
      const moving = fieldOf(input, "move") === "latest" ? answering.slice(-1) : answering;
      const started = store.branchThread(title, moving);
      if (!started.ok) return Promise.resolve(failed("There's nothing in the main chat to move."));
      const isAll = branched(toThreadId(started.value.id), moving, textOf(input, "brief").trim());
      return Promise.resolve({
        text: isAll
          ? `Started the thread “${title}” (${started.value.id}); its own conversation answers there now. This turn ` +
            "ends here: write nothing more."
          : `Moved their latest message into the thread “${title}” (${started.value.id}), which answers it in its ` +
            "own conversation. Carry on here with what you were doing.",
        structured: { thread: started.value.id },
      });
    },
  };

  const updateThread: Tool = {
    name: "update_thread",
    title: "Keep a thread up to date",
    description:
      "Mark a side thread done once its question is answered or its task is finished, or open again; say where it " +
      "stands in one line, which shows beside it in their list of threads; or rename it. Marking it done is quiet: " +
      "they see a small line, and replying opens it again. Leave out the thread for the one you're in.",
    inputSchema: {
      type: "object",
      properties: {
        thread: { type: "string", description: "The thread's id, such as from <threads>." },
        state: { enum: ["open", "done"] },
        result: {
          type: "string",
          description:
            'Where it stands or how it ended, in a short line, such as "Noodles, laab, skewers · £47 for two".',
        },
        title: { type: "string", description: "A better name, of one to five words." },
      },
      additionalProperties: false,
    },
    call: (input) => {
      const given = textOf(input, "thread").trim();
      const thread = given === "" ? contextThread() : toThreadId(given);
      if (thread === undefined) return Promise.resolve(failed("Say which thread: you're in the main chat."));
      const title = textOf(input, "title").replaceAll(/\s+/gu, " ").trim();
      if (title !== "" && !isTitle(title)) return Promise.resolve(failed("A title is one to five words."));
      const result = textOf(input, "result").replaceAll(/\s+/gu, " ").trim();
      if (result.length > mostResultLength) {
        return Promise.resolve(
          failed(`Keep the result to one short line, under ${String(mostResultLength)} characters.`),
        );
      }
      const state = fieldOf(input, "state");
      const changed = store.changeThread(thread, {
        by: "kumo",
        ...(title !== "" && { title }),
        ...(result !== "" && { result }),
        ...((state === "open" || state === "done") && { state }),
      });
      if (!changed) return Promise.resolve(failed(`There's no thread ${thread}.`));
      return Promise.resolve({
        text: `The thread ${nameOf(changed)} is ${changed.state}${changed.result === undefined ? "" : `: ${changed.result}`}.`,
      });
    },
  };

  const readThread: Tool = {
    name: "read_thread",
    title: "Read a thread",
    description:
      "Read a side thread's latest messages, such as before your background work comes back to it, or when they " +
      "mention something you talked about there.",
    inputSchema: {
      type: "object",
      properties: { thread: { type: "string", description: "The thread's id, such as from <threads>." } },
      required: ["thread"],
      additionalProperties: false,
    },
    call: (input) => {
      const id = toThreadId(textOf(input, "thread").trim());
      const thread = store.findThread(id);
      if (!thread) return Promise.resolve(failed(`There's no thread ${id}.`));
      const messages = store.threadMessages(id, readMessages);
      return Promise.resolve({
        text: [
          `${nameOf(thread)} (${thread.id}), ${thread.state}, started ${spoken(thread.started_at)}` +
            (thread.result === undefined ? "." : `: ${thread.result}`),
          ...messages.map((message) => toLine(message, message.kind === "post" ? postLength : readLength)),
        ].join("\n"),
      });
    },
  };

  return {
    inMindText: (thread) => (thread === undefined ? mainText() : sideText(thread)),
    backgroundText,
    tools: [startThread, updateThread, readThread],
  };
};
