import { randomUUID } from "node:crypto";
import { toTimestamp, type Clock } from "#clock.ts";
import { dayMs, toLocal } from "#desk/day.ts";
import type { Settings } from "#store/store.ts";
import { stringsOf, textOf } from "#tools/input.ts";
import type { Tool, ToolResult } from "#tools/mcp.ts";

// The day's one small question, when Kumo is unsure what matters or they seem to have changed: proposed by Kumo's
// work, asked at most once a day at a calm moment, and never asked again once answered or skipped.
export type Question = {
  readonly id: string;
  readonly text: string;
  readonly options: readonly string[];
  readonly about: string;
  readonly proposedAt: string;
  readonly askedAt?: string;
  readonly outcome?: "answered" | "skipped";
};

export type Questions = {
  readonly tool: Tool;
  // The question to ask next, if one is waiting and none went out today.
  readonly next: () => Question | undefined;
  readonly propose: (question: Omit<Question, "id" | "proposedAt">) => Question | string;
  readonly mark: (id: string, change: Partial<Pick<Question, "askedAt" | "outcome">>) => void;
};

export const questionsSetting = "day_questions";

const freshMs = 3 * dayMs;
const kept = 60;

const failed = (text: string): ToolResult => ({ text, isError: true });

const lineOf = (value: unknown, field: string): string => textOf(value, field).replaceAll(/\s+/gu, " ").trim();

const keyOf = (text: string): string =>
  text
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, " ")
    .trim();

export const createQuestions = (settings: Settings, clock: Clock, timeZone: string): Questions => {
  const all = (): readonly Question[] => {
    const saved = settings.setting(questionsSetting);
    return saved === undefined ? [] : (JSON.parse(saved) as readonly Question[]);
  };

  const save = (questions: readonly Question[]): void => {
    settings.setSetting(questionsSetting, JSON.stringify(questions.slice(-kept)));
  };

  const today = (): string => toLocal(clock.now(), timeZone).day;

  const propose: Questions["propose"] = (given) => {
    const text = given.text.trim();
    const about = given.about.trim();
    if (text === "" || about === "") return "Give the question and what it's about.";
    const options = [...new Set(given.options.map((option) => option.trim()).filter(Boolean))].slice(0, 3);
    if (options.length < 2) return "Give two or three short options; they can also skip it.";
    const same = all().find((asked) => keyOf(asked.about) === keyOf(about) || keyOf(asked.text) === keyOf(text));
    if (same?.outcome === "skipped") return "They skipped that question before, so it isn't asked again.";
    if (same?.outcome === "answered") return "They've answered that already: read what they said in memory.";
    if (same) return "That question is already waiting to be asked.";
    const question: Question = { id: `q_${randomUUID()}`, text, options, about, proposedAt: toTimestamp(clock.now()) };
    save([...all(), question]);
    return question;
  };

  return {
    tool: {
      name: "ask_today",
      title: "Ask today's question",
      audience: "work",
      description:
        "When you're unsure what matters to them, or they seem to have changed, propose one small question, such " +
        "as whether Thursday climbing is something to guard. It goes out at most once a day, at a calm moment, as " +
        "your line at the top of their Desk with its options and Skip; a skipped question is never asked again. " +
        "Their answer comes back to you to keep in memory.",
      inputSchema: {
        type: "object",
        properties: {
          text: { type: "string", description: "The question, in one short sentence." },
          options: { type: "array", items: { type: "string" }, description: "Two or three short answers." },
          about: { type: "string", description: "What it's about in a few words, so it's never asked twice." },
        },
        required: ["text", "options", "about"],
        additionalProperties: false,
      },
      call: (input) => {
        const proposed = propose({
          text: lineOf(input, "text"),
          options: stringsOf(input, "options"),
          about: lineOf(input, "about"),
        });
        return Promise.resolve(
          typeof proposed === "string" ? failed(proposed) : { text: "It's waiting for a calm moment today." },
        );
      },
    },
    next: () => {
      const questions = all();
      const day = today();
      return questions.some(
        ({ askedAt }) => askedAt !== undefined && toLocal(Date.parse(askedAt), timeZone).day === day,
      )
        ? undefined
        : questions.find(
            ({ askedAt, proposedAt }) => askedAt === undefined && Date.parse(proposedAt) > clock.now() - freshMs,
          );
    },
    propose,
    mark: (id, change) => {
      save(all().map((question) => (question.id === id ? { ...question, ...change } : question)));
    },
  };
};
