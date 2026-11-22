import { readFileSync } from "node:fs";
import path from "node:path";
import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import formats from "ajv-formats";
import { toTimestamp, type Clock } from "#clock.ts";
import { toLocal } from "#desk/day.ts";
import type { AskFields } from "#engine/engine.ts";
import { mergePatch } from "#motion/changes.ts";
import { protocolDirectory, type JsonSchema, type Schemas } from "#protocol/schemas.ts";
import type { Made, MadeChange, MadeState, Picture } from "#protocol/types.ts";
import { blocksIn } from "#replies/blocks.ts";
import { fail, ok, type Result } from "#result.ts";
import type { Store } from "#store/store.ts";
import { contextThread } from "#tools/context.ts";
import { fieldOf, textOf } from "#tools/input.ts";
import type { Tool, ToolResult } from "#tools/mcp.ts";

// A page Kumo made: a rich, lasting answer it shows as a card in the chat and keeps current. Pages live in the server's
// own store, not in memory: they're things Kumo made for them, not what it knows about them, and their ticks change
// by the minute.

export type Fields = Readonly<Record<string, unknown>>;

export type MadeDetail = {
  readonly made: Made;
  readonly content: Fields;
  readonly state: MadeState;
  readonly changes: readonly MadeChange[];
};

export type MadeFailure = { readonly code: "not_found" | "invalid"; readonly detail: string };

export type MadePages = {
  readonly tools: readonly Tool[];
  readonly list: () => readonly Made[];
  readonly detail: (id: string) => Result<MadeDetail, MadeFailure>;
  readonly patchState: (id: string, patch: unknown) => Result<MadeState, MadeFailure>;
  readonly inMindText: () => string;
};

export type MadeOptions = {
  readonly store: Store;
  readonly schemas: Schemas;
  readonly clock: Clock;
  readonly timeZone: () => string;
  readonly approve: (fields: AskFields) => Promise<boolean>;
  readonly directory?: string;
};

export const madeToolNames = ["make_made_page", "change_made_page", "read_made_page", "forget_made_page"] as const;

type Section = {
  readonly id: string;
  readonly title: string;
  readonly text?: string;
  readonly image?: Picture;
  readonly items?: readonly Item[];
};

type Item = { readonly id: string; readonly title: string; readonly image?: Picture };

type Content = { readonly intro?: string; readonly check?: string; readonly sections: readonly Section[] };

const idPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

const dayPattern = /^\d{4}-\d{2}-\d{2}$/u;

const longestTitle = 60;

const changesShown = 20;

const mostInMind = 8;

// A page that isn't for a day stays in mind this long after its last change.
const freshMs = 7 * 24 * 60 * 60 * 1000;

const shownProblems = 3;

const failed = (text: string): ToolResult => ({ text, isError: true });

const lineOf = (value: unknown, field: string): string => textOf(value, field).replaceAll(/\s+/gu, " ").trim();

const isObject = (value: unknown): value is Fields =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readJson = (directory: string, file: string): JsonSchema & { readonly $id: string } =>
  JSON.parse(readFileSync(path.join(directory, file), "utf8")) as JsonSchema & { readonly $id: string };

const toProblem = ({ instancePath, message = "isn't right", params }: ErrorObject): string => {
  const where = instancePath === "" ? "It" : instancePath.slice(1).replaceAll("/", ".");
  const extra = "additionalProperty" in params ? ` (${String(params.additionalProperty)})` : "";
  return `${where} ${message}${extra}.`;
};

const check = (validate: ValidateFunction, value: unknown): Result<undefined, string> => {
  if (validate(value)) return ok(undefined);
  const problems = [...new Set((validate.errors ?? []).map((error) => toProblem(error)))];
  const more = problems.length > shownProblems ? ` And ${String(problems.length - shownProblems)} more.` : "";
  return fail(`${problems.slice(0, shownProblems).join(" ")}${more}`);
};

// A schema with its references written out, so the model sees the whole shape in a tool's input.
const inlined = (schema: unknown, definitions: ReadonlyMap<string, unknown>): unknown => {
  if (Array.isArray(schema)) return schema.map((item) => inlined(item, definitions));
  if (!isObject(schema)) return schema;
  const reference = schema.$ref;
  if (typeof reference === "string") {
    const found = definitions.get(reference);
    if (found === undefined) throw new Error(`No definition for ${reference}.`);
    const rest = Object.fromEntries(Object.entries(schema).filter(([key]) => key !== "$ref"));
    return { ...(inlined(found, definitions) as Fields), ...rest };
  }
  return Object.fromEntries(
    Object.entries(schema)
      .filter(([key, value]) => typeof value !== "string" || !["title", "$schema", "$id"].includes(key))
      .map(([key, value]) => [key, inlined(value, definitions)]),
  );
};

const sectionsOf = (content: Fields): readonly Section[] => (content as Content).sections;

const itemsOf = (content: Fields): readonly Item[] => sectionsOf(content).flatMap((section) => section.items ?? []);

const picturesIn = (cover: Picture | undefined, content: Fields): readonly string[] =>
  [
    cover,
    ...sectionsOf(content).flatMap((section) => [section.image, ...(section.items ?? []).map(({ image }) => image)]),
  ]
    .filter((picture) => picture !== undefined)
    .map(({ attachment }) => attachment);

const parsedJson = (text: string): Result<unknown, undefined> => {
  try {
    return ok(JSON.parse(text) as unknown);
  } catch {
    return fail(undefined);
  }
};

const dayProblemOf = (day: unknown): string | undefined =>
  day === undefined || (typeof day === "string" && dayPattern.test(day) && !Number.isNaN(Date.parse(day)))
    ? undefined
    : "for_day is a day, such as 2026-11-22.";

const duplicateIn = (content: Fields): string | undefined => {
  const ids = sectionsOf(content).flatMap((section) => [section.id, ...(section.items ?? []).map(({ id }) => id)]);
  return ids.find((id, index) => ids.indexOf(id) !== index);
};

const checkWord = (content: Fields): string | undefined => (content as Content).check;

const tickedCount = (content: Fields, state: MadeState): number =>
  itemsOf(content).filter(({ id }) => state.ticks?.[id] !== undefined).length;

const pruned = (state: MadeState, content: Fields): MadeState => {
  if (checkWord(content) === undefined) return {};
  const ids = new Set(itemsOf(content).map(({ id }) => id));
  const ticks = Object.fromEntries(Object.entries(state.ticks ?? {}).filter(([id]) => ids.has(id)));
  return Object.keys(ticks).length === 0 ? {} : { ticks };
};

const describeDay = (day: string): string =>
  new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "short", timeZone: "UTC" }).format(
    Date.parse(`${day}T12:00:00.000Z`),
  );

export const createMadePages = ({
  store,
  schemas,
  clock,
  timeZone,
  approve,
  directory = protocolDirectory,
}: MadeOptions): MadePages => {
  const blocks = readJson(directory, "blocks.schema.json");
  const made = readJson(directory, "made.schema.json");
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  formats.default(ajv);
  ajv.addSchema(schemas.events);
  ajv.addSchema(blocks);
  ajv.addSchema(made);
  const compiled = (id: string): ValidateFunction => {
    const validate = ajv.getSchema(id);
    if (!validate) throw new Error(`No schema ${id}.`);
    return validate;
  };
  const checkContent = compiled(`${made.$id}#/$defs/MadeContent`);
  const checkPicture = compiled(`${schemas.events.$id}#/$defs/Picture`);
  const blockDefinitions = Object.entries((blocks.$defs ?? {}) as Readonly<Record<string, Fields>>).flatMap(
    ([name, definition]) =>
      typeof definition.title === "string" && definition.title.startsWith("ari:")
        ? [[definition.title.slice(4), compiled(`${blocks.$id}#/$defs/${name}`)] as const]
        : [],
  );
  const checkBlock = new Map(blockDefinitions);

  // Inside the events schema its own references are local, as the made schema's are; neither names one the other has.
  const eventDefinitions = Object.entries(schemas.events.$defs);
  const definitions = new Map<string, unknown>([
    ...eventDefinitions.map(([name, schema]) => [`#/$defs/${name}`, schema] as const),
    ...eventDefinitions.map(([name, schema]) => [`events.schema.json#/$defs/${name}`, schema] as const),
    ...Object.entries((made.$defs ?? {}) as Fields).map(([name, schema]) => [`#/$defs/${name}`, schema] as const),
  ]);
  const contentSchema = inlined((made.$defs as Fields).MadeContent, definitions) as Fields;
  const pictureSchema = inlined(schemas.events.$defs.Picture, definitions) as Fields;

  const blockProblem = (kind: string, body: string, where: string): string | undefined => {
    const validate = checkBlock.get(kind);
    if (!validate) return `${where} has an ari:${kind} block, which the phone doesn't draw.`;
    const parsed = parsedJson(body);
    if (!parsed.ok) return `${where}'s ari:${kind} block isn't one JSON object.`;
    const checked = check(validate, parsed.value);
    return checked.ok ? undefined : `${where}'s ari:${kind} block: ${checked.failure}`;
  };

  const blocksProblem = (text: string | undefined, where: string): string | undefined =>
    blocksIn(text ?? "")
      .map(({ kind, body }) => blockProblem(kind, body, where))
      .find((problem) => problem !== undefined);

  const checkAll = (cover: unknown, content: unknown): Result<undefined, string> => {
    if (cover !== undefined) {
      const checked = check(checkPicture, cover);
      if (!checked.ok) return fail(`The cover: ${checked.failure}`);
    }
    const checked = check(checkContent, content);
    if (!checked.ok) return fail(`The content: ${checked.failure}`);
    const fields = content as Fields;
    const duplicate = duplicateIn(fields);
    if (duplicate !== undefined)
      return fail(`The id ${duplicate} is used twice; every section and item needs its own.`);
    const problem =
      blocksProblem((fields as Content).intro, "The intro") ??
      sectionsOf(fields)
        .map((section) => blocksProblem(section.text, `Section ${section.id}`))
        .find((found) => found !== undefined);
    if (problem !== undefined) return fail(problem);
    const missing = picturesIn(cover as Picture | undefined, fields).find((id) => !store.findAttachment(id));
    return missing === undefined
      ? ok(undefined)
      : fail(`There's no picture ${missing} on the server: keep it with keep_image first, and use the id it gives.`);
  };

  const make = (input: unknown): Result<Made, string> => {
    const id = lineOf(input, "id");
    if (!idPattern.test(id) || id.length > 64)
      return fail("Give an id of lowercase words and dashes, such as va-guide.");
    if (store.findMade(id))
      return fail(`There's already a page ${id}: change it with change_made_page, or pick another id.`);
    const title = lineOf(input, "title");
    if (title === "" || title.length > longestTitle)
      return fail(`Give a title of ${String(longestTitle)} characters or fewer.`);
    const cover = fieldOf(input, "cover");
    const content = fieldOf(input, "content");
    const dayProblem = dayProblemOf(fieldOf(input, "for_day"));
    if (dayProblem !== undefined) return fail(dayProblem);
    const checked = checkAll(cover, content);
    if (!checked.ok) return checked;
    const at = toTimestamp(clock.now());
    const forDay = textOf(input, "for_day");
    // Made in a side thread's own conversation: "From your thread" opens it.
    const thread = contextThread();
    const { made: saved } = store.recordMade(
      "made.created",
      {
        id,
        title,
        summary: lineOf(input, "summary"),
        ...(cover !== undefined && { cover: cover as Picture }),
        ...(forDay !== "" && { for_day: forDay }),
        version: 1,
        made_at: at,
        changed_at: at,
        ...(thread !== undefined && { thread }),
      },
      lineOf(input, "note") || "Made it",
      content as Fields,
    );
    return ok(saved);
  };

  const change = (input: unknown): Result<Made, string> => {
    const id = lineOf(input, "id");
    const current = store.findMade(id);
    if (!current) return fail(`There's no page ${id}. read_made_page lists them.`);
    if (fieldOf(input, "version") !== current.version) {
      return fail(`${current.title} is at version ${String(current.version)} now: read it again before you change it.`);
    }
    const note = lineOf(input, "note");
    if (note === "") return fail("Give a note saying what changed, as you'd tell them.");
    const given = (field: string): boolean => fieldOf(input, field) !== undefined;
    if (!["title", "summary", "cover", "for_day", "content"].some(given)) {
      return fail("Give what changes: the content, title, summary, cover or for_day.");
    }
    const title = given("title") ? lineOf(input, "title") : current.title;
    if (title === "" || title.length > longestTitle)
      return fail(`Give a title of ${String(longestTitle)} characters or fewer.`);
    const content = (fieldOf(input, "content") ?? store.madeContent(id, current.version) ?? {}) as Fields;
    const dayProblem = dayProblemOf(fieldOf(input, "for_day"));
    if (dayProblem !== undefined) return fail(dayProblem);
    const cover = (fieldOf(input, "cover") as Picture | undefined) ?? current.cover;
    const checked = checkAll(cover, content);
    if (!checked.ok) return checked;
    const forDay = given("for_day") ? textOf(input, "for_day") : current.for_day;
    const { made: saved } = store.recordMade(
      "made.changed",
      {
        id,
        title,
        summary: given("summary") ? lineOf(input, "summary") : current.summary,
        ...(cover !== undefined && { cover }),
        ...(forDay !== undefined && { for_day: forDay }),
        version: current.version + 1,
        made_at: current.made_at,
        changed_at: toTimestamp(clock.now()),
        position: current.position,
        ...(current.thread !== undefined && { thread: current.thread }),
      },
      note,
      content,
    );
    const state = store.madeState(id);
    const after = pruned(state, content);
    if (JSON.stringify(after) !== JSON.stringify(state)) store.setMadeState(id, after);
    return ok(saved);
  };

  const at = (timestamp: string): string =>
    new Intl.DateTimeFormat("en-GB", {
      timeZone: timeZone(),
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(Date.parse(timestamp));

  const read = (input: unknown): Result<string, string> => {
    const id = lineOf(input, "id");
    if (id === "") {
      const all = store.listMade();
      return ok(
        all.length === 0
          ? "You haven't made any pages yet."
          : all
              .map((page) => `- ${page.title} (${page.id}, version ${String(page.version)}): ${page.summary}`)
              .join("\n"),
      );
    }
    const page = store.findMade(id);
    if (!page) return fail(`There's no page ${id}. read_made_page without an id lists them.`);
    const content = store.madeContent(id, page.version) ?? {};
    const state = store.madeState(id);
    const ticks = Object.entries(state.ticks ?? {});
    const word = checkWord(content);
    const changes = store.madeChanges(id, 5);
    return ok(
      [
        `${page.title} (${page.id}), version ${String(page.version)}: ${page.summary}`,
        ...(page.for_day === undefined ? [] : [`For ${describeDay(page.for_day)}.`]),
        ...(page.cover ? [`Cover: ${JSON.stringify(page.cover)}`] : []),
        `Content: ${JSON.stringify(content)}`,
        word === undefined
          ? "Nothing on it ticks."
          : ticks.length === 0
            ? `They haven't ticked anything (${word.toLowerCase()}) yet.`
            : `${word}: ${ticks.map(([item, when]) => `${item} at ${at(when)}`).join(", ")}.`,
        `What changed lately: ${changes.map(({ version, note }) => `${String(version)}. ${note}`).join(" ")}`,
      ].join("\n"),
    );
  };

  const forget = async (input: unknown): Promise<Result<string, string>> => {
    const id = lineOf(input, "id");
    const page = store.findMade(id);
    if (!page) return fail(`There's no page ${id}.`);
    const reason = lineOf(input, "reason");
    const isAllowed = await approve({
      kind: "approval",
      question: `Forget ${page.title}?`,
      options: [{ label: "Forget it", acts: true }, { label: "Keep it" }],
      allows_text: true,
      preview: `${page.title}: ${reason}`,
    });
    if (!isAllowed) return ok(`They kept ${page.title}, so nothing was forgotten.`);
    if (!store.findMade(id)) return ok(`${page.title} is already forgotten.`);
    store.removeMade(id);
    return ok(`Forgot ${page.title}: it's off the Made shelf and its cards.`);
  };

  const pageFields = {
    title: {
      type: "string",
      description: `What it is, ${String(longestTitle)} characters at most, such as “Your guide to the V&A”.`,
    },
    summary: { type: "string", description: "What's in it, in one line, such as “4 rooms · 9 things to spot”." },
    for_day: {
      type: "string",
      description: "The day it's for, such as the visit, as 2026-11-22. You keep it current until then.",
    },
    cover: { ...pictureSchema, description: "A picture for its top and its card, kept with keep_image." },
    content: contentSchema,
  };

  const tools: readonly Tool[] = [
    {
      name: "make_made_page",
      title: "Make a page",
      description:
        "Make a page for a rich, lasting answer they'll come back to, such as a gallery guide, a menu pick, a day's " +
        "plan or a comparison of roles: sections that fold, things to tick, pictures, places with Directions. Then " +
        "reply in a few sentences with an ari:made block holding its id, which shows it as a card that opens it. It " +
        "sits on their Made shelf, and you keep it current. Pictures are kept with keep_image first.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "Lowercase words and dashes, such as va-guide." },
          ...pageFields,
          note: { type: "string", description: "What you made, in a few words; “Made it” when absent." },
        },
        required: ["id", "title", "summary", "content"],
        additionalProperties: false,
      },
      call: (input) => {
        const saved = make(input);
        return Promise.resolve(
          saved.ok
            ? {
                text:
                  `Made ${saved.value.title} as ${saved.value.id}, at version 1. Show it in your reply with ` +
                  `\`\`\`ari:made\n${JSON.stringify({ made: saved.value.id })}\n\`\`\``,
                structured: { made: saved.value.id, version: 1 },
              }
            : failed(saved.failure),
        );
      },
    },
    {
      name: "change_made_page",
      title: "Change a page you made",
      description:
        "Keep a page you made current: when something on it changes in the world (hours, a closure, a sold-out " +
        "dish), when their plans change, or when they ask. Read it first and give the version you read. Give only " +
        "what changes; content replaces the whole content, keeping the ids of what stays so their ticks stay. The " +
        "note shows on the page as what changed (“The Raphael Cartoons reopened this morning, so they're back in.”). " +
        "It never notifies them: when they need to know, message them too.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string" },
          version: { type: "integer", description: "The version you read." },
          ...pageFields,
          note: { type: "string", description: "What changed, said to them, in a sentence." },
        },
        required: ["id", "version", "note"],
        additionalProperties: false,
      },
      call: (input) => {
        const saved = change(input);
        return Promise.resolve(
          saved.ok
            ? {
                text: `Saved ${saved.value.title}, now at version ${String(saved.value.version)}.`,
                structured: { made: saved.value.id, version: saved.value.version },
              }
            : failed(saved.failure),
        );
      },
    },
    {
      name: "read_made_page",
      title: "Read a page you made",
      description:
        "Read a page you made: its content with every id, its version, what they've ticked and when, and what " +
        "changed lately. Read it before you change it. Without an id, it lists every page you've made.",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string" } },
        additionalProperties: false,
      },
      call: (input) => {
        const result = read(input);
        return Promise.resolve(result.ok ? { text: result.value } : failed(result.failure));
      },
    },
    {
      name: "forget_made_page",
      title: "Forget a page you made",
      description:
        "Take a page off their Made shelf for good, after asking them: this asks for approval and waits for their " +
        "answer. Only when they ask.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string" },
          reason: { type: "string", description: "Why it should go, in a few words, said to them." },
        },
        required: ["id", "reason"],
        additionalProperties: false,
      },
      call: async (input) => {
        const result = await forget(input);
        return result.ok ? { text: result.value } : failed(result.failure);
      },
    },
  ];

  const detail = (id: string): Result<MadeDetail, MadeFailure> => {
    const page = store.findMade(id);
    if (!page) return fail({ code: "not_found", detail: `No page ${id}.` });
    return ok({
      made: page,
      content: store.madeContent(id, page.version) ?? {},
      state: store.madeState(id),
      changes: store.madeChanges(id, changesShown),
    });
  };

  const patchState = (id: string, patch: unknown): Result<MadeState, MadeFailure> => {
    const page = store.findMade(id);
    if (!page) return fail({ code: "not_found", detail: `No page ${id}.` });
    const invalid = (detail: string): Result<MadeState, MadeFailure> => fail({ code: "invalid", detail });
    if (!isObject(patch)) return invalid('Send a JSON Merge Patch on the state, such as {"ticks": {…}}.');
    const unknown = Object.keys(patch).find((key) => key !== "ticks");
    if (unknown !== undefined) return invalid(`The state has no ${unknown}.`);
    const content = store.madeContent(id, page.version) ?? {};
    const ticks = patch.ticks;
    if (ticks !== undefined && ticks !== null) {
      if (!isObject(ticks)) return invalid("ticks maps item ids to when you ticked them.");
      if (checkWord(content) === undefined) return invalid(`Nothing on ${page.title} ticks.`);
      const items = new Set(itemsOf(content).map((item) => item.id));
      for (const [item, when] of Object.entries(ticks)) {
        if (!items.has(item)) return invalid(`${page.title} has no item ${item}.`);
        if (
          when !== null &&
          (typeof when !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(when))
        ) {
          return invalid(`A tick is when you ticked it, such as 2026-11-22T14:32:00.000Z, or null.`);
        }
      }
    }
    const before = store.madeState(id);
    const merged = mergePatch(before, patch) as MadeState;
    const after: MadeState =
      merged.ticks === undefined || Object.keys(merged.ticks).length === 0 ? {} : { ticks: merged.ticks };
    if (JSON.stringify(after) !== JSON.stringify(before)) store.setMadeState(id, after);
    return ok(after);
  };

  const inMindText = (): string => {
    const today = toLocal(clock.now(), timeZone()).day;
    const live = store
      .listMade()
      .filter(({ for_day: day, changed_at: changedAt }) =>
        day === undefined ? clock.now() - Date.parse(changedAt) < freshMs : day >= today,
      )
      .slice(0, mostInMind);
    if (live.length === 0) return "";
    return [
      "<made_pages>",
      "Pages you made them and keep current: read one with read_made_page, then change it with change_made_page.",
      ...live.map((page) => {
        const content = store.madeContent(page.id, page.version) ?? {};
        const word = checkWord(content);
        const ticked =
          word === undefined
            ? ""
            : `; ${String(tickedCount(content, store.madeState(page.id)))} of ${String(itemsOf(content).length)} ${word.toLowerCase()}`;
        const day = page.for_day === undefined ? "" : `, for ${describeDay(page.for_day)}`;
        return `- ${page.title} (${page.id}${day}): ${page.summary}${ticked}`;
      }),
      "</made_pages>",
    ].join("\n");
  };

  return { tools, list: () => store.listMade(), detail, patchState, inMindText };
};
