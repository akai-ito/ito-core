import type { Manifest, Operation } from "#capabilities/manifest.ts";
import type { JsonSchema } from "#protocol/schemas.ts";
import { fail, ok, type Result } from "#result.ts";

type Property = {
  readonly type?: string | readonly string[];
  readonly description?: string;
  readonly items?: Property;
};

type Input = Readonly<Record<string, unknown>>;

const propertiesOf = (schema: JsonSchema): Readonly<Record<string, Property>> =>
  (schema.properties as Readonly<Record<string, Property>> | undefined) ?? {};

const requiredOf = (schema: JsonSchema): readonly string[] => (schema.required as readonly string[] | undefined) ?? [];

const typeOf = (property: Property): string => (Array.isArray(property.type) ? "" : String(property.type ?? ""));

export const toFlag = (name: string): string => name.replaceAll("_", "-");

const toValue = (property: Property, text: string, flag: string): Result<unknown, string> => {
  switch (typeOf(property)) {
    case "string": {
      return ok(text);
    }
    case "number":
    case "integer": {
      const number = Number(text);
      return text.trim() !== "" && Number.isFinite(number) ? ok(number) : fail(`--${flag} takes a number.`);
    }
    case "boolean": {
      return text === "true" || text === "false" ? ok(text === "true") : fail(`--${flag} takes true or false.`);
    }
    default: {
      try {
        return ok(JSON.parse(text));
      } catch {
        return fail(`--${flag} takes JSON.`);
      }
    }
  }
};

type Parsed = { readonly input: Input; readonly rest: readonly string[] };

const takeFlag = (schema: JsonSchema, { input, rest }: Parsed): Result<Parsed, string> => {
  const [argument = "", ...after] = rest;
  const match = /^--(?<negated>no-)?(?<flag>[a-z][\w-]*)(?:=(?<inline>.*))?$/su.exec(argument)?.groups;
  if (!match) return fail(`${argument} isn't a flag: give each value as --name value.`);
  const { negated, flag = "", inline } = match;
  const entry = Object.entries(propertiesOf(schema)).find(([name]) => toFlag(name) === flag);
  if (!entry) return fail(`There's no --${flag} here.`);
  const [name, property] = entry;
  const isBoolean = typeOf(property) === "boolean";
  if (isBoolean && inline === undefined) return ok({ input: { ...input, [name]: negated === undefined }, rest: after });
  if (negated !== undefined) return fail(`--no-${flag} only works for true-or-false flags.`);
  const [next, ...remaining] = after;
  const text = inline ?? next;
  if (text === undefined) return fail(`--${flag} needs a value.`);
  const isArray = typeOf(property) === "array";
  const value = toValue(isArray ? (property.items ?? {}) : property, text, flag);
  if (!value.ok) return value;
  const earlier = input[name];
  const combined = isArray
    ? [...(Array.isArray(earlier) ? (earlier as readonly unknown[]) : []), value.value]
    : value.value;
  return ok({ input: { ...input, [name]: combined }, rest: inline === undefined ? remaining : after });
};

const parseAll = (schema: JsonSchema, parsed: Parsed): Result<Input, string> => {
  if (parsed.rest.length === 0) return ok(parsed.input);
  const next = takeFlag(schema, parsed);
  return next.ok ? parseAll(schema, next.value) : next;
};

export const toInput = (schema: JsonSchema, rest: readonly string[]): Result<Input, string> => {
  const parsed = parseAll(schema, { input: {}, rest });
  if (!parsed.ok) return parsed;
  const missing = requiredOf(schema).filter((name) => parsed.value[name] === undefined);
  return missing.length > 0
    ? fail(`It needs ${missing.map((name) => `--${toFlag(name)}`).join(", ")}.`)
    : ok(parsed.value);
};

const flagLine = (schema: JsonSchema, [name, property]: readonly [string, Property]): string => {
  const kind = typeOf(property);
  const value = kind === "boolean" ? "" : kind === "array" ? " <value>…" : ` <${kind || "json"}>`;
  const required = requiredOf(schema).includes(name) ? " (required)" : "";
  return `  --${toFlag(name)}${value}${required}${property.description ? `: ${property.description}` : ""}`;
};

export const toOperationUsage = (command: string, id: string, operation: Operation): string =>
  [
    `${command} ${id} ${operation.name}: ${operation.description}`,
    ...Object.entries(propertiesOf(operation.input)).map((entry) => flagLine(operation.input, entry)),
  ].join("\n");

export const toUsage = (command: string, manifest: Manifest): string =>
  [
    `${manifest.title}: ${manifest.summary}`,
    "",
    ...manifest.operations.map((operation) => toOperationUsage(command, manifest.id, operation)),
  ].join("\n");

const quoted = /"(?:[^"\\]|\\.)*"|'[^']*'/gu;
const unsafe = /[|&;<>()$`\n"'\\]/u;
const word = /(?:[^\s"'\\]+|\\.|"(?:[^"\\]|\\.)*"|'[^']*')+/gu;
const segment = /\\(?<escaped>.)|"(?<double>(?:[^"\\]|\\.)*)"|'(?<single>[^']*)'|[^\s"'\\]+/gu;

const unquote = (text: string): string =>
  text
    .matchAll(segment)
    .map(
      ({ 0: whole, groups = {} }) =>
        groups.escaped ?? groups.single ?? groups.double?.replaceAll(/\\(?<escaped>.)/gu, "$<escaped>") ?? whole,
    )
    .toArray()
    .join("");

export const splitCommand = (command: string): readonly string[] | undefined =>
  unsafe.test(command.replaceAll(quoted, ""))
    ? undefined
    : command
        .matchAll(word)
        .map(([text]) => unquote(text))
        .toArray();
