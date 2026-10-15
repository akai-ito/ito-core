import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

export const protocolDirectory = path.dirname(fileURLToPath(import.meta.url));

export type JsonSchema = Readonly<Record<string, unknown>>;

export type Schemas = {
  readonly events: JsonSchema & { readonly $id: string; readonly $defs: Readonly<Record<string, JsonSchema>> };
  readonly push: JsonSchema & { readonly $id: string; readonly $defs: Readonly<Record<string, JsonSchema>> };
  readonly openapi: JsonSchema & { readonly $id: string };
  readonly document: OpenApiDocument;
};

export type OpenApiParameter = {
  readonly $ref?: string;
  readonly name?: string;
  readonly in?: "query" | "path" | "header" | "cookie";
  readonly required?: boolean;
  readonly schema?: JsonSchema;
};

export type OpenApiOperation = {
  readonly operationId?: string;
  readonly parameters?: readonly OpenApiParameter[];
  readonly requestBody?: { readonly content?: Readonly<Record<string, { readonly schema?: JsonSchema }>> };
  readonly responses?: Readonly<
    Record<
      string,
      { readonly $ref?: string; readonly content?: Readonly<Record<string, { readonly schema?: JsonSchema }>> }
    >
  >;
};

export type OpenApiDocument = {
  readonly info: { readonly version: string };
  readonly paths: Readonly<Record<string, Readonly<Record<string, OpenApiOperation>>>>;
  readonly components: {
    readonly schemas: Readonly<Record<string, JsonSchema>>;
    readonly parameters: Readonly<Record<string, OpenApiParameter>>;
    readonly responses: Readonly<
      Record<string, { readonly content?: Readonly<Record<string, { readonly schema?: JsonSchema }>> }>
    >;
  };
};

export const openapiSchemaId = "openapi";

export const withReferencesResolved = (schema: unknown, eventsId: string): unknown => {
  if (Array.isArray(schema)) return schema.map((item) => withReferencesResolved(item, eventsId));
  if (!schema || typeof schema !== "object") return schema;
  return Object.fromEntries(
    Object.entries(schema).map(([key, value]) => [
      key,
      key === "$ref" && typeof value === "string"
        ? value
            .replace(/^events\.schema\.json#/, () => `${eventsId}#`)
            .replace(/^push\.schema\.json#/, () => `${eventsId.replace(/events\.schema\.json$/, "push.schema.json")}#`)
            .replace(/^#\/components\/schemas\//, () => `${openapiSchemaId}#/$defs/`)
        : withReferencesResolved(value, eventsId),
    ]),
  );
};

export const loadSchemas = (directory = protocolDirectory): Schemas => {
  const events = JSON.parse(readFileSync(path.join(directory, "events.schema.json"), "utf8")) as Schemas["events"];
  const push = JSON.parse(readFileSync(path.join(directory, "push.schema.json"), "utf8")) as Schemas["push"];
  const document = parseYaml(readFileSync(path.join(directory, "openapi.yaml"), "utf8")) as OpenApiDocument;
  const openapi = {
    $id: openapiSchemaId,
    $defs: withReferencesResolved(document.components.schemas, events.$id),
  } as Schemas["openapi"];
  return { events, push, openapi, document };
};

export const protocolVersion = (document: OpenApiDocument): string => document.info.version;
