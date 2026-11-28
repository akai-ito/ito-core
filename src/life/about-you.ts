import type { JsonSchema } from "#engine/engine.ts";
import type { Lines } from "#life/lines.ts";
import type { Memory } from "#memory/memory.ts";
import type { AboutYou } from "#protocol/types.ts";
import { fieldOf, textOf } from "#tools/input.ts";
import type { Questions } from "#work/questions.ts";
import type { Tracks } from "#work/tracks.ts";

// What Kumo knows about them, behind Kumo on the Desk: the Portrait and How to help you, short; their tastes, from
// the topic pages; what Kumo learnt lately; and the Getting to know you tracks with how many questions wait. The
// short versions are written on the quick model and kept until the pages they come from change.
export type AboutYouReader = { readonly read: () => Promise<AboutYou> };

export type AboutYouOptions = {
  readonly memory: Pick<Memory, "sync" | "page" | "pages" | "learnt">;
  readonly tracks: Pick<Tracks, "list">;
  readonly questions: Pick<Questions, "open">;
  readonly lines: Lines;
};

export const portraitAddress = "memory:portrait";
export const helpingAddress = "memory:helping-you";

const mostHelping = 5;
const mostTastes = 8;
// How much of a topic page Kumo reads for tastes.
const topicChars = 800;

const shortSchema: JsonSchema = {
  type: "object",
  properties: {
    portrait: { type: "string" },
    helping: { type: "array", items: { type: "string" } },
    tastes: {
      type: "array",
      items: {
        type: "object",
        properties: { taste: { type: "string" }, page: { type: "string" } },
        required: ["taste", "page"],
        additionalProperties: false,
      },
    },
  },
  required: ["portrait", "helping", "tastes"],
  additionalProperties: false,
};

type Short = {
  readonly portrait?: string;
  readonly helping: string[];
  readonly tastes: AboutYou["tastes"];
};

type Topic = { readonly address: string; readonly title: string; readonly text: string };

const oneLine = (text: string): string => text.replaceAll(/\s+/gu, " ").trim();

export const toShortPrompt = (portrait: string, helping: string, topics: readonly Topic[]): string =>
  [
    'You are Kumo, their assistant. In Ito they open "What I know about you": what you know of them, to them as',
    '"you", warm and plain, British spelling. Write it short, from your pages below, with nothing they don\'t say:',
    `- portrait: their Portrait in two or three sentences, at most 45 words, such as "You plan in bursts, then want it`,
    "  all to just happen. You run to think, cook to unwind.\" Empty when there's no Portrait.",
    `- helping: How to help you in at most ${String(mostHelping)} lines of at most 8 words each, such as "Drafts only.`,
    "  You press send.\" None when there's no such page.",
    `- tastes: at most ${String(mostTastes)} of their tastes from the topic pages, one to three words each, likes and`,
    '  dislikes alike, such as "Figs", "Window seats", "Spicy, not hot" or "No musicals", each with the address of the',
    "  topic page it comes from. None when the topics name none.",
    "",
    "Portrait:",
    portrait.trim() === "" ? "(none)" : portrait.trim(),
    "",
    "How to help you:",
    helping.trim() === "" ? "(none)" : helping.trim(),
    "",
    "Topic pages:",
    ...(topics.length === 0 ? ["(none)"] : topics.map(({ address, title, text }) => `${address} (${title}): ${text}`)),
  ].join("\n");

const toShort =
  (topics: readonly Topic[]) =>
  (answer: unknown): Short | undefined => {
    const portrait = oneLine(textOf(answer, "portrait"));
    const listedHelping = fieldOf(answer, "helping");
    const helping = (Array.isArray(listedHelping) ? listedHelping : [])
      .filter((line): line is string => typeof line === "string")
      .map((line) => oneLine(line))
      .filter((line) => line !== "")
      .slice(0, mostHelping);
    const known = new Set(topics.map(({ address }) => address));
    const listedTastes = fieldOf(answer, "tastes");
    const tastes = (Array.isArray(listedTastes) ? listedTastes : [])
      .map((taste: unknown) => ({ text: oneLine(textOf(taste, "taste")), address: textOf(taste, "page").trim() }))
      .filter(({ text, address }) => text !== "" && known.has(address))
      .slice(0, mostTastes);
    return { ...(portrait !== "" && { portrait }), helping, tastes };
  };

export const createAboutYou = ({ memory, tracks, questions, lines }: AboutYouOptions): AboutYouReader => {
  const markdownOf = (address: string): string => {
    const page = memory.page(address);
    return page.ok ? page.value.markdown : "";
  };

  return {
    read: async () => {
      await memory.sync();
      const portrait = markdownOf(portraitAddress);
      const helping = markdownOf(helpingAddress);
      const topics = memory.pages("topics").map(({ address, title, gist = "" }) => ({
        address,
        title,
        text: oneLine(`${gist} ${markdownOf(address)}`).slice(0, topicChars),
      }));
      const prompt = toShortPrompt(portrait, helping, topics);
      const short =
        portrait.trim() === "" && helping.trim() === "" && topics.length === 0
          ? undefined
          : await lines.write({
              key: "about-you",
              basis: prompt,
              prompt,
              schema: shortSchema,
              toValue: toShort(topics),
            });
      return {
        ...(short?.portrait !== undefined && { portrait: { text: short.portrait, address: portraitAddress } }),
        ...(short && short.helping.length > 0 && { helping: { lines: short.helping, address: helpingAddress } }),
        tastes: short?.tastes ?? [],
        learnt: [...memory.learnt()],
        tracks: [...tracks.list()],
        to_ask: questions.open().length,
      };
    },
  };
};
