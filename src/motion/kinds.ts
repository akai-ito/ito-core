import { readFileSync } from "node:fs";
import path from "node:path";
import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import formats from "ajv-formats";
import { protocolDirectory, type Schemas } from "#protocol/schemas.ts";
import { fail, ok, type Result } from "#result.ts";

export const kindNames = ["trip", "training", "pursuit", "occasion", "case"] as const;

export type Kind = (typeof kindNames)[number];

export type Kinds = {
  readonly isKind: (kind: string) => kind is Kind;
  readonly checkContent: (kind: Kind, content: unknown) => Result<undefined, string>;
  readonly checkState: (kind: Kind, state: unknown) => Result<undefined, string>;
  readonly checkChanges: (changes: unknown) => Result<undefined, string>;
};

const shown = 3;

const definitions: Readonly<Record<Kind, { readonly content: string; readonly state: string }>> = {
  trip: { content: "Trip", state: "TripState" },
  training: { content: "Training", state: "TrainingState" },
  pursuit: { content: "Pursuit", state: "PursuitState" },
  occasion: { content: "Occasion", state: "OccasionState" },
  case: { content: "Case", state: "CaseState" },
};

const toProblem = ({ instancePath, message = "isn't right", params }: ErrorObject): string => {
  const where = instancePath === "" ? "It" : instancePath.slice(1).replaceAll("/", ".");
  const extra = "additionalProperty" in params ? ` (${String(params.additionalProperty)})` : "";
  return `${where} ${message}${extra}.`;
};

const toResult = (validate: ValidateFunction, value: unknown): Result<undefined, string> => {
  if (validate(value)) return ok(undefined);
  const problems = (validate.errors ?? [])
    .filter((error) => error.keyword !== "oneOf")
    .map((error) => toProblem(error));
  const unique = [...new Set(problems)];
  const more = unique.length > shown ? ` And ${String(unique.length - shown)} more.` : "";
  return fail(`${unique.slice(0, shown).join(" ")}${more}`);
};

export const createKinds = (schemas: Schemas, directory = protocolDirectory): Kinds => {
  const motion = JSON.parse(readFileSync(path.join(directory, "motion.schema.json"), "utf8")) as {
    readonly $id: string;
  };
  const ajv = new Ajv2020({ strict: true, allErrors: true, keywords: ["example"] });
  formats.default(ajv);
  ajv.addSchema(schemas.events);
  ajv.addSchema(motion);
  const compiled = (definition: string): ValidateFunction => {
    const validate = ajv.getSchema(`${motion.$id}#/$defs/${definition}`);
    if (!validate) throw new Error(`motion.schema.json has no ${definition}.`);
    return validate;
  };
  const validators = Object.fromEntries(
    kindNames.map((kind) => [
      kind,
      { content: compiled(definitions[kind].content), state: compiled(definitions[kind].state) },
    ]),
  ) as Readonly<Record<Kind, { readonly content: ValidateFunction; readonly state: ValidateFunction }>>;
  const changes = compiled("Changes");
  return {
    isKind: (kind): kind is Kind => (kindNames as readonly string[]).includes(kind),
    checkContent: (kind, content) => toResult(validators[kind].content, content),
    checkState: (kind, state) => toResult(validators[kind].state, state),
    checkChanges: (given) => toResult(changes, given),
  };
};
