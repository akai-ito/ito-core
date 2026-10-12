import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import formats from "ajv-formats";
import { parse as parseYaml } from "yaml";

export type Line = Record<string, unknown>;

export interface Event {
  id?: string;
  type: string;
  at: string;
  [field: string]: unknown;
}

export const protocolDir = join(dirname(fileURLToPath(import.meta.url)), "..");

interface Operation {
  requestBody?: { content?: Record<string, { schema?: unknown }> };
  responses?: Record<string, { $ref?: string; content?: Record<string, { schema?: unknown }> }>;
}

interface OpenApi {
  paths: Record<string, Record<string, Operation>>;
  components: {
    schemas: Record<string, unknown>;
    responses: Record<string, { content?: Record<string, { schema?: unknown }> }>;
  };
}

// The published schemas tolerate unknown properties, because apps and servers must ignore what
// they don't recognise. Here every object schema is closed, so a typo in a transcript can't pass.
function closed(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(closed);
  if (!schema || typeof schema !== "object") return schema;
  const copy: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) copy[key] = closed(value);
  if (copy.type === "object" && "properties" in copy && !("unevaluatedProperties" in copy)) {
    copy.unevaluatedProperties = false;
  }
  return copy;
}

function withRefsTo(schema: unknown, eventsId: string): unknown {
  if (Array.isArray(schema)) return schema.map((item) => withRefsTo(item, eventsId));
  if (!schema || typeof schema !== "object") return schema;
  const copy: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    copy[key] =
      key === "$ref" && typeof value === "string"
        ? value
            .replace(/^events\.schema\.json#/, `${eventsId}#`)
            .replace(/^#\/components\/schemas\//, "openapi#/$defs/")
        : withRefsTo(value, eventsId);
  }
  return copy;
}

export interface Spec {
  checkEvent(event: Event): string | undefined;
  checkLines(name: string, lines: Line[]): void;
}

export function loadSpec(dir = protocolDir): Spec {
  const events = JSON.parse(readFileSync(join(dir, "events.schema.json"), "utf8")) as {
    $id: string;
    $defs: Record<string, { properties?: { type?: { const?: unknown } } }>;
  };
  const openapi = parseYaml(readFileSync(join(dir, "openapi.yaml"), "utf8")) as OpenApi;
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  formats.default(ajv);
  ajv.addKeyword("example");
  ajv.addSchema(closed(events) as object);
  ajv.addSchema({ $id: "openapi", $defs: closed(withRefsTo(openapi.components.schemas, events.$id)) as object });

  const anyEvent = ajv.getSchema(events.$id);
  if (!anyEvent) throw new Error("events.schema.json did not load");
  const byType = new Map<string, ValidateFunction>();
  for (const [name, definition] of Object.entries(events.$defs)) {
    const type = definition.properties?.type?.const;
    const validate = ajv.getSchema(`${events.$id}#/$defs/${name}`);
    if (typeof type === "string" && validate) byType.set(type, validate);
  }

  const passes = (validate: ValidateFunction, value: unknown): boolean => validate(value) === true;
  const checkEvent = (event: Event): string | undefined => {
    if (passes(anyEvent, event)) return undefined;
    const specific = byType.get(event.type);
    if (!specific) return `unknown event type ${JSON.stringify(event.type)}`;
    return passes(specific, event)
      ? ajv.errorsText(anyEvent.errors)
      : `${event.type}: ${ajv.errorsText(specific.errors)}`;
  };

  const operations = Object.entries(openapi.paths).flatMap(([path, item]) =>
    Object.entries(item).map(([method, operation]) => ({
      method: method.toUpperCase(),
      pattern: new RegExp(`^${path.replace(/\{[^}]+\}/g, "[^/]+")}$`),
      operation,
    })),
  );
  const compiled = new Map<unknown, ValidateFunction>();
  const check = (schema: unknown, value: unknown): string | undefined => {
    let validate = compiled.get(schema);
    if (!validate) {
      validate = ajv.compile(withRefsTo(closed(schema), events.$id) as object);
      compiled.set(schema, validate);
    }
    return validate(value) ? undefined : ajv.errorsText(validate.errors);
  };

  const checkLines = (name: string, lines: Line[]): void => {
    let pending: Operation | undefined;
    for (const line of lines) {
      const where = `${name} at ${typeof line.at === "number" ? `${line.at} ms` : "given"}`;
      const event = (line.event ?? line.given) as Event | undefined;
      if (event) {
        const problem = checkEvent(event);
        if (problem) throw new Error(`${where}: ${problem}`);
      }
      const app = line.app as { method: string; path: string; body?: unknown } | undefined;
      if (app) {
        const path = app.path.split("?")[0] ?? app.path;
        const match = operations.find((candidate) => candidate.method === app.method && candidate.pattern.test(path));
        if (!match) throw new Error(`${where}: no operation for ${app.method} ${path}`);
        const schema = match.operation.requestBody?.content?.["application/json"]?.schema;
        const problem = schema && app.body !== undefined ? check(schema, app.body) : undefined;
        if (problem) throw new Error(`${where}: request ${problem}`);
        pending = match.operation;
      }
      const server = line.server as { status: number; body?: unknown } | undefined;
      if (server) {
        if (!pending) throw new Error(`${where}: a response without a request`);
        let response = pending.responses?.[String(server.status)];
        if (response?.$ref) response = openapi.components.responses[response.$ref.split("/").at(-1) ?? ""];
        if (!response) throw new Error(`${where}: status ${server.status} is not in the spec`);
        const schema = response.content?.["application/json"]?.schema;
        const problem = schema ? check(schema, server.body) : undefined;
        if (problem) throw new Error(`${where}: response ${problem}`);
        pending = undefined;
      }
    }
  };

  return { checkEvent, checkLines };
}
