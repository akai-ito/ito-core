import { Ajv2020 } from "ajv/dist/2020.js";
import formats from "ajv-formats";
import type { FastifySchemaCompiler } from "fastify";
import { withReferencesResolved, type JsonSchema, type OpenApiParameter, type Schemas } from "#protocol/schemas.ts";

export type RouteSchema = {
  readonly body?: JsonSchema;
  readonly querystring?: JsonSchema;
  readonly params?: JsonSchema;
};

const toObjectSchema = (parameters: readonly OpenApiParameter[], eventsId: string): JsonSchema | undefined =>
  parameters.length === 0
    ? undefined
    : {
        type: "object",
        required: parameters.filter((parameter) => parameter.required).map((parameter) => parameter.name),
        properties: Object.fromEntries(
          parameters.map((parameter) => [parameter.name, withReferencesResolved(parameter.schema, eventsId)]),
        ),
      };

export const toRouteSchemas = ({ document, events }: Schemas): ReadonlyMap<string, RouteSchema> => {
  const resolve = (parameter: OpenApiParameter): OpenApiParameter =>
    parameter.$ref ? (document.components.parameters[parameter.$ref.split("/").at(-1) ?? ""] ?? parameter) : parameter;
  const operations = Object.values(document.paths).flatMap((item) => Object.values(item));
  return new Map(
    operations.flatMap((operation) => {
      if (!operation.operationId) return [];
      const parameters = (operation.parameters ?? []).map((parameter) => resolve(parameter));
      const body = operation.requestBody?.content?.["application/json"]?.schema;
      const querystring = toObjectSchema(
        parameters.filter((parameter) => parameter.in === "query"),
        events.$id,
      );
      const pathParameters = toObjectSchema(
        parameters.filter((parameter) => parameter.in === "path"),
        events.$id,
      );
      const schema: RouteSchema = {
        ...(body && { body: withReferencesResolved(body, events.$id) as JsonSchema }),
        ...(querystring && { querystring }),
        ...(pathParameters && { params: pathParameters }),
      };
      return [[operation.operationId, schema] as const];
    }),
  );
};

const createValidator = (schemas: Schemas, coerceTypes: false | "array"): Ajv2020 => {
  const ajv = new Ajv2020({ strict: true, coerceTypes, useDefaults: true, keywords: ["example"] });
  formats.default(ajv);
  ajv.addSchema(schemas.events);
  ajv.addSchema(schemas.openapi);
  return ajv;
};

export const createValidatorCompiler = (schemas: Schemas): FastifySchemaCompiler<JsonSchema> => {
  const forBodies = createValidator(schemas, false);
  const forUrls = createValidator(schemas, "array");
  return ({ schema, httpPart }) => (httpPart === "body" ? forBodies : forUrls).compile(schema);
};
