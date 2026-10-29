import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import type { Tool } from "#tools/mcp.ts";

type Schema = Readonly<Record<string, unknown>>;

const ajv = new Ajv2020({ strict: false, allErrors: true });

const compiled = new WeakMap<Schema, ValidateFunction>();

export const fieldOf = (value: unknown, field: string): unknown =>
  value && typeof value === "object" ? Reflect.get(value, field) : undefined;

export const textOf = (value: unknown, field: string): string => {
  const text = fieldOf(value, field);
  return typeof text === "string" ? text : "";
};

export const stringsOf = (value: unknown, field: string): readonly string[] => {
  const list = fieldOf(value, field);
  return Array.isArray(list) ? list.filter((item): item is string => typeof item === "string") : [];
};

const validatorFor = (schema: Schema): ValidateFunction => {
  const known = compiled.get(schema);
  if (known) return known;
  const validate = ajv.compile(schema);
  compiled.set(schema, validate);
  return validate;
};

const toProblem = ({ keyword, instancePath, message = "isn't right", params }: ErrorObject): string => {
  if (keyword === "required") return `Give ${String(params.missingProperty)}.`;
  if (keyword === "additionalProperties") return `There's no ${String(params.additionalProperty)} here.`;
  return `${instancePath === "" ? "The input" : instancePath.slice(1).replaceAll("/", ".")} ${message}.`;
};

export const checkInput = (schema: Schema, input: unknown): string | undefined => {
  const validate = validatorFor(schema);
  return validate(input) ? undefined : [...new Set((validate.errors ?? []).map((error) => toProblem(error)))].join(" ");
};

export const withCheckedInput = (tool: Tool): Tool => ({
  ...tool,
  call: async (input) => {
    const problem = checkInput(tool.inputSchema, input ?? {});
    return problem === undefined ? tool.call(input) : { text: problem, isError: true };
  },
});
