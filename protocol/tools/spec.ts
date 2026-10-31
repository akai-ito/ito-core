import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import formats from "ajv-formats";
import { createCell } from "#cell.ts";
import {
  loadSchemas,
  protocolDirectory,
  withReferencesResolved,
  type JsonSchema,
  type OpenApiOperation,
} from "#protocol/schemas.ts";

export type Line = Readonly<Record<string, unknown>>;

export type Event = {
  readonly id?: string;
  readonly type: string;
  readonly at: string;
  readonly [field: string]: unknown;
};

export type Spec = {
  readonly checkEvent: (event: Event) => string | undefined;
  readonly checkLines: (name: string, lines: readonly Line[]) => void;
};

type AppRequest = { readonly method: string; readonly path: string; readonly body?: unknown };

type ServerResponse = { readonly status: number; readonly body?: unknown };

type Push = { readonly device: string; readonly level: string; readonly notification: unknown };

type Socket = {
  readonly from?: unknown;
  readonly frame?: unknown;
  readonly audio?: unknown;
  readonly audio_ms?: unknown;
  readonly closed?: unknown;
};

const pushLevels: ReadonlySet<string> = new Set(["passive", "active", "time-sensitive"]);

type EventDefinition = { readonly properties?: { readonly type?: { readonly const?: unknown } } };

// The published schemas tolerate unknown properties, because apps and servers must ignore what
// they don't recognise. Here every object schema is closed, so a typo in a transcript can't pass.
const toClosed = (schema: unknown): unknown => {
  if (Array.isArray(schema)) return schema.map(toClosed);
  if (!schema || typeof schema !== "object") return schema;
  const copy = Object.fromEntries(Object.entries(schema).map(([key, value]) => [key, toClosed(value)]));
  return copy.type === "object" && "properties" in copy && !("unevaluatedProperties" in copy)
    ? { ...copy, unevaluatedProperties: false }
    : copy;
};

export const loadSpec = (directory = protocolDirectory): Spec => {
  const { events, push, stream, openapi, document } = loadSchemas(directory);
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  formats.default(ajv);
  ajv.addKeyword("example");
  ajv.addSchema(toClosed(events) as object);
  ajv.addSchema(toClosed(push) as object);
  ajv.addSchema(toClosed(stream) as object);
  ajv.addSchema(toClosed(openapi) as object);

  const anyEvent = ajv.getSchema(events.$id);
  if (!anyEvent) throw new Error("events.schema.json did not load");
  const anyNotification = ajv.getSchema(`${push.$id}#/$defs/Notification`);
  if (!anyNotification) throw new Error("push.schema.json did not load");
  const fromApp = ajv.getSchema(`${stream.$id}#/$defs/FromApp`);
  const fromServer = ajv.getSchema(`${stream.$id}#/$defs/FromServer`);
  if (!fromApp || !fromServer) throw new Error("stream.schema.json did not load");
  const byType = new Map(
    Object.entries(events.$defs as Readonly<Record<string, EventDefinition>>).flatMap(([name, definition]) => {
      const type = definition.properties?.type?.const;
      const validate = ajv.getSchema(`${events.$id}#/$defs/${name}`);
      return typeof type === "string" && validate ? [[type, validate] as const] : [];
    }),
  );

  const checkEvent = (event: Event): string | undefined => {
    if (anyEvent(event)) return undefined;
    const specific = byType.get(event.type);
    if (!specific) return `unknown event type ${JSON.stringify(event.type)}`;
    return specific(event) ? ajv.errorsText(anyEvent.errors) : `${event.type}: ${ajv.errorsText(specific.errors)}`;
  };

  const operations = Object.entries(document.paths).flatMap(([path, item]) =>
    Object.entries(item).map(([method, operation]) => ({
      method: method.toUpperCase(),
      pattern: new RegExp(`^${path.replaceAll(/\{[^}]+\}/g, "[^/]+")}$`),
      operation,
    })),
  );

  const validators = createCell<ReadonlyMap<JsonSchema, ValidateFunction>>(new Map());
  const validatorFor = (schema: JsonSchema): ValidateFunction => {
    const cached = validators.get().get(schema);
    if (cached) return cached;
    const isValid = ajv.compile(withReferencesResolved(toClosed(schema), events.$id) as object);
    validators.update((current) => new Map([...current, [schema, isValid]]));
    return isValid;
  };
  const problemWith = (schema: JsonSchema, value: unknown): string | undefined => {
    const isValid = validatorFor(schema);
    return isValid(value) ? undefined : ajv.errorsText(isValid.errors);
  };

  const checkRequest = (where: string, app: AppRequest): OpenApiOperation => {
    const path = app.path.split("?", 1)[0] ?? app.path;
    const match = operations.find((candidate) => candidate.method === app.method && candidate.pattern.test(path));
    if (!match) throw new Error(`${where}: no operation for ${app.method} ${path}`);
    const schema = match.operation.requestBody?.content?.["application/json"]?.schema;
    const problem = schema && app.body !== undefined ? problemWith(schema, app.body) : undefined;
    if (problem) throw new Error(`${where}: request ${problem}`);
    return match.operation;
  };

  const checkResponse = (where: string, pending: OpenApiOperation | undefined, server: ServerResponse): void => {
    if (!pending) throw new Error(`${where}: a response without a request`);
    const declared = pending.responses?.[String(server.status)];
    const response = declared?.$ref ? document.components.responses[declared.$ref.split("/").at(-1) ?? ""] : declared;
    if (!response) throw new Error(`${where}: status ${server.status} is not in the spec`);
    const schema = response.content?.["application/json"]?.schema;
    const problem = schema ? problemWith(schema, server.body) : undefined;
    if (problem) throw new Error(`${where}: response ${problem}`);
  };

  const checkPush = (where: string, pushed: Push): void => {
    if (!pushLevels.has(pushed.level)) throw new Error(`${where}: push level ${pushed.level} is not in the spec`);
    if (!anyNotification(pushed.notification)) {
      throw new Error(`${where}: push ${ajv.errorsText(anyNotification.errors)}`);
    }
  };

  const checkSocket = (where: string, socket: Socket): void => {
    const kinds = ["frame", "audio", "audio_ms", "closed"].filter((kind) => Object.hasOwn(socket, kind));
    if (kinds.length !== 1)
      throw new Error(`${where}: a socket line holds exactly one of frame, audio, audio_ms, closed`);
    if (socket.from !== "app" && socket.from !== "server")
      throw new Error(`${where}: a socket line is from app or server`);
    if (socket.from === "app" && (socket.audio_ms !== undefined || socket.closed !== undefined)) {
      throw new Error(`${where}: the app sends frames and audio files`);
    }
    if (socket.from === "server" && socket.audio !== undefined)
      throw new Error(`${where}: the server's audio is audio_ms`);
    if (socket.frame === undefined) return;
    const validate = socket.from === "app" ? fromApp : fromServer;
    if (!validate(socket.frame)) throw new Error(`${where}: socket frame ${ajv.errorsText(validate.errors)}`);
  };

  const checkLine = (name: string, pending: OpenApiOperation | undefined, line: Line): OpenApiOperation | undefined => {
    const where = `${name} at ${typeof line.at === "number" ? `${line.at} ms` : "given"}`;
    if (line.socket) checkSocket(where, line.socket);
    const event = (line.event ?? line.given) as Event | undefined;
    const problem = event ? checkEvent(event) : undefined;
    if (problem) throw new Error(`${where}: ${problem}`);
    if (line.push) checkPush(where, line.push as Push);
    const app = line.app as AppRequest | undefined;
    const requested = app ? checkRequest(where, app) : pending;
    const server = line.server as ServerResponse | undefined;
    if (server) checkResponse(where, requested, server);
    return server ? undefined : requested;
  };

  const checkLines = (name: string, lines: readonly Line[]): void => {
    lines.reduce<OpenApiOperation | undefined>((pending, line) => checkLine(name, pending, line), undefined);
  };

  return { checkEvent, checkLines };
};
