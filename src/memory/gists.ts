import type { JsonSchema } from "#engine/engine.ts";

export type GistPage = { readonly address: string; readonly title: string; readonly markdown: string };

export const gistsPerRequest = 10;

export const gistGuide =
  "What the page is now, in one line: a journal day's headline, such as “Home from Ljubljana; Bora's first " +
  "sub-two”; who someone is to the person, such as “Recruiter on the QRT process”; where a project or goal " +
  "stands; or what anything else is now.";

export const gistSchema: JsonSchema = {
  type: "object",
  properties: {
    gists: {
      type: "array",
      items: {
        type: "object",
        properties: { address: { type: "string" }, gist: { type: "string" } },
        required: ["address", "gist"],
        additionalProperties: false,
      },
    },
  },
  required: ["gists"],
  additionalProperties: false,
};

export const toOneLine = (text: string): string => text.replaceAll(/\s+/gu, " ").trim();

export const toGistPrompt = (pages: readonly GistPage[]): string =>
  [
    "These pages from your memory have no gist yet. Write one for each, with its address.",
    `A gist is ${gistGuide.charAt(0).toLowerCase()}${gistGuide.slice(1)}`,
    ...pages.map(({ address, title, markdown }) => `\n## ${title} (${address})\n\n${markdown.trim()}`),
  ].join("\n");

const fieldOf = (value: unknown, field: string): unknown =>
  value && typeof value === "object" ? Reflect.get(value, field) : undefined;

const textOf = (value: unknown, field: string): string => {
  const text = fieldOf(value, field);
  return typeof text === "string" ? toOneLine(text) : "";
};

export const toGists = (answer: unknown, pages: readonly GistPage[]): ReadonlyMap<string, string> => {
  const asked = new Set(pages.map(({ address }) => address));
  const gists = fieldOf(answer, "gists");
  return new Map(
    (Array.isArray(gists) ? (gists as readonly unknown[]) : [])
      .map((item) => [textOf(item, "address"), textOf(item, "gist")] as const)
      .filter(([address, gist]) => asked.has(address) && gist !== ""),
  );
};
