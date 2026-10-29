import type { JsonSchema } from "#engine/engine.ts";

export type CirclePage = {
  readonly address: string;
  readonly title: string;
  readonly gist?: string;
  readonly markdown: string;
};

export type Sorted = { readonly circle: string; readonly isGroup: boolean };

export const circlesPerRequest = 20;

const excerptLength = 400;

export const circleSchema: JsonSchema = {
  type: "object",
  properties: {
    people: {
      type: "array",
      items: {
        type: "object",
        properties: {
          address: { type: "string" },
          circle: { type: "string" },
          is_group: { type: "boolean" },
        },
        required: ["address", "circle", "is_group"],
        additionalProperties: false,
      },
    },
  },
  required: ["people"],
  additionalProperties: false,
};

export const toCirclePrompt = (pages: readonly CirclePage[], circles: readonly string[]): string =>
  [
    "These pages on your people shelf have no circle yet. Give each, with its address, a circle: who they are " +
      "to the person, in a few words, such as family, friends, work or running club.",
    circles.length > 0
      ? `Reuse the circles you already have where they fit: ${circles.join(", ")}.`
      : "Use few circles, each shared by several people where it fits.",
    "If a page is about a group of people rather than one person, such as a club or a team, set is_group: it " +
      "moves to your groups shelf.",
    ...pages.map(
      ({ address, title, gist, markdown }) =>
        `\n## ${title} (${address})${gist === undefined ? "" : `\n\n${gist}`}\n\n${markdown.trim().slice(0, excerptLength)}`,
    ),
  ].join("\n");

const fieldOf = (value: unknown, field: string): unknown =>
  value && typeof value === "object" ? Reflect.get(value, field) : undefined;

export const toSorted = (answer: unknown, pages: readonly CirclePage[]): ReadonlyMap<string, Sorted> => {
  const asked = new Set(pages.map(({ address }) => address));
  const people = fieldOf(answer, "people");
  return new Map(
    (Array.isArray(people) ? (people as readonly unknown[]) : []).flatMap((item) => {
      const address = fieldOf(item, "address");
      const circle = fieldOf(item, "circle");
      if (typeof address !== "string" || typeof circle !== "string" || !asked.has(address)) return [];
      const label = circle.replaceAll(/\s+/gu, " ").trim();
      const isGroup = fieldOf(item, "is_group") === true;
      return label === "" && !isGroup ? [] : [[address, { circle: label, isGroup }] as const];
    }),
  );
};

export const toGroupAddress = (address: string): string => address.replace(/^memory:people\//u, "memory:groups/");
