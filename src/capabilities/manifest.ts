import { readFileSync } from "node:fs";
import path from "node:path";
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import { protocolDirectory, type JsonSchema } from "#protocol/schemas.ts";
import { fail, ok, type Result } from "#result.ts";

export const capabilityProtocol = "0.1";

export type FieldKind = "text" | "secret" | "toggle" | "choice";

export type Field = {
  readonly name: string;
  readonly kind: FieldKind;
  readonly title: string;
  readonly description?: string;
  readonly optional?: boolean;
  readonly options?: readonly { readonly value: string; readonly label: string }[];
};

export type Operation = {
  readonly name: string;
  readonly title: string;
  readonly running: string;
  readonly done: string;
  readonly description: string;
  readonly input: JsonSchema;
  readonly tool?: string;
  readonly publishes?: boolean;
};

export type Manifest = {
  readonly id: string;
  readonly version: string;
  readonly kind: "domain" | "hand";
  readonly title: string;
  readonly symbol?: string;
  readonly summary: string;
  readonly setup: readonly Field[];
  readonly operations: readonly Operation[];
  readonly skill: string;
  readonly uses: { readonly hosts: readonly string[]; readonly folders: readonly string[] };
};

export type Values = Readonly<Record<string, string | boolean>>;

export type CallResult = { readonly text: string; readonly data?: Readonly<Record<string, unknown>> };

export type Status = { readonly state: "ok" | "needs_you"; readonly detail?: string };

type Messages = {
  readonly InitializeResult: { readonly protocol: string; readonly manifest: Manifest };
  readonly CheckResult: { readonly problem?: string };
  readonly CallResult: CallResult;
  readonly StatusParams: Status;
};

const schema = JSON.parse(
  readFileSync(path.join(protocolDirectory, "capability.schema.json"), "utf8"),
) as JsonSchema & {
  readonly $id: string;
};

const ajv = new Ajv2020({ strict: true, allErrors: true });
ajv.addSchema(schema);

const compile = (name: keyof Messages): ValidateFunction => ajv.compile({ $ref: `${schema.$id}#/$defs/${name}` });

const validators: Readonly<Record<keyof Messages, ValidateFunction>> = {
  InitializeResult: compile("InitializeResult"),
  CheckResult: compile("CheckResult"),
  CallResult: compile("CallResult"),
  StatusParams: compile("StatusParams"),
};

export const toMessage = <Name extends keyof Messages>(name: Name, value: unknown): Result<Messages[Name], string> => {
  const validate = validators[name];
  return validate(value) ? ok(value as Messages[Name]) : fail(ajv.errorsText(validate.errors, { dataVar: name }));
};

export const isComplete = (manifest: Manifest, values: Values): boolean =>
  manifest.setup.every((field) => field.optional === true || (values[field.name] ?? "") !== "");

const toValue = (field: Field, value: string | boolean): Result<string | boolean, string> => {
  if (field.kind === "toggle")
    return typeof value === "boolean" ? ok(value) : fail(`${field.name} takes true or false.`);
  if (typeof value !== "string") return fail(`${field.name} takes text.`);
  const isChoice = field.kind !== "choice" || value === "" || field.options?.some((option) => option.value === value);
  return isChoice ? ok(value) : fail(`${value} isn't one of the choices for ${field.name}.`);
};

export const toValues = (manifest: Manifest, given: Values): Result<Values, string> => {
  const unknown = Object.keys(given).filter((name) => manifest.setup.every((field) => field.name !== name));
  if (unknown.length > 0) return fail(`${manifest.title} has no setup field called ${unknown.join(", ")}.`);
  const checked = manifest.setup.flatMap((field) => {
    const value = given[field.name];
    return value === undefined ? [] : [[field.name, toValue(field, value)] as const];
  });
  const failure = checked.find(([, value]) => !value.ok)?.[1];
  return failure && !failure.ok
    ? fail(failure.failure)
    : ok(Object.fromEntries(checked.flatMap(([name, value]) => (value.ok ? [[name, value.value]] : []))));
};
