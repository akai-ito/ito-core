import type { JsonValue } from "#engine/codex/bindings/serde_json/JsonValue.ts";
import type { McpServerElicitationRequestParams } from "#engine/codex/bindings/v2/McpServerElicitationRequestParams.ts";
import type { McpServerElicitationRequestResponse } from "#engine/codex/bindings/v2/McpServerElicitationRequestResponse.ts";
import type { AskFields } from "#engine/engine.ts";

type Field = Readonly<Record<string, unknown>>;

const maxPreviewLength = 600;

const isRecord = (value: unknown): value is Field =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const shown = (value: unknown): string => (typeof value === "string" ? value : JSON.stringify(value));

const toPreview = (display: unknown): string | undefined => {
  if (display === undefined || display === null) return undefined;
  const lines = Array.isArray(display)
    ? display.map((item) =>
        isRecord(item) && "name" in item ? `${shown(item.name)}: ${shown(item.value ?? item.display)}` : shown(item),
      )
    : isRecord(display)
      ? Object.entries(display).map(([name, value]) => `${name}: ${shown(value)}`)
      : [shown(display)];
  const text = lines.join("\n").trim();
  return text === "" ? undefined : text.slice(0, maxPreviewLength);
};

const metaOf = (parameters: McpServerElicitationRequestParams): Field =>
  isRecord(parameters._meta) ? parameters._meta : {};

export const toApprovalFields = (parameters: McpServerElicitationRequestParams): AskFields | undefined => {
  if (parameters.mode === "url") return undefined;
  const preview = toPreview(metaOf(parameters).tool_params_display);
  return {
    kind: "approval",
    question: parameters.message.trim() || `Allow ${parameters.serverName} to go ahead?`,
    options: [{ label: "Allow", acts: true }, { label: "Don't" }],
    allows_text: true,
    ...(preview && { preview }),
    secret: false,
  };
};

const answerFor = (property: unknown): JsonValue | undefined => {
  if (!isRecord(property)) return undefined;
  const choices = property.enum ?? property.oneOf;
  if (Array.isArray(choices) && choices.length > 0) {
    const [first] = choices as readonly unknown[];
    return (isRecord(first) && "const" in first ? first.const : first) as JsonValue;
  }
  return property.type === "boolean" ? true : undefined;
};

const contentFor = (parameters: McpServerElicitationRequestParams): JsonValue => {
  const schema = parameters.mode === "url" ? undefined : parameters.requestedSchema;
  if (!isRecord(schema) || !isRecord(schema.properties)) return {};
  const properties = schema.properties;
  const required = Array.isArray(schema.required) ? (schema.required as readonly string[]) : [];
  return Object.fromEntries(
    required.flatMap((name) => {
      const answer = answerFor(properties[name]);
      return answer === undefined ? [] : [[name, answer]];
    }),
  );
};

export const declined: McpServerElicitationRequestResponse = { action: "decline", content: null, _meta: null };

export const toElicitationResponse = (
  parameters: McpServerElicitationRequestParams,
  isAllowed: boolean,
): McpServerElicitationRequestResponse =>
  isAllowed ? { action: "accept", content: contentFor(parameters), _meta: null } : declined;
