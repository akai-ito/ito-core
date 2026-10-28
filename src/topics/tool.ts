import type { Store } from "#store/store.ts";
import type { Tool, ToolResult } from "#tools/mcp.ts";

export const topicToolName = "mark_topic";

const mostWords = 4;

const failed = (text: string): ToolResult => ({ text, isError: true });

const labelOf = (input: unknown): string => {
  const label: unknown = input && typeof input === "object" ? Reflect.get(input, "label") : undefined;
  return typeof label === "string" ? label.replaceAll(/\s+/gu, " ").trim() : "";
};

export const createTopicTool = (store: Pick<Store, "markTopic">): Tool => ({
  name: topicToolName,
  title: "Mark the topic",
  description:
    "When the person changes the subject, mark the new topic before you reply, with a label of one to four " +
    "words such as “Florence trip” or “QRT panel”. It shows as a quiet label on their message, and they can " +
    "jump between topics. When they come back to an earlier subject, use its label exactly as before. Mark at " +
    "most one topic a turn, and none for small talk or more on the same subject.",
  inputSchema: {
    type: "object",
    properties: { label: { type: "string", description: "One to four words, such as Florence trip." } },
    required: ["label"],
    additionalProperties: false,
  },
  call: (input) => {
    const label = labelOf(input);
    const words = label === "" ? 0 : label.split(" ").length;
    if (words === 0 || words > mostWords) {
      return Promise.resolve(failed("A topic's label is one to four words, such as Florence trip."));
    }
    const marked = store.markTopic(label);
    if (marked.ok) return Promise.resolve({ text: `Marked the topic ${label}.` });
    return Promise.resolve(
      failed(
        marked.failure.code === "marked"
          ? `This turn's topic is already ${marked.failure.topic.label}.`
          : "Topics are marked while you answer a message.",
      ),
    );
  },
});
