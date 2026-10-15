export const toolServerName = "ito";

export type ToolResult = {
  readonly text: string;
  readonly isError?: boolean;
  readonly structured?: Readonly<Record<string, unknown>>;
};

export type Tool = {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly call: (input: unknown) => Promise<ToolResult>;
};

export type McpMessage = { readonly id?: unknown; readonly method?: unknown; readonly params?: unknown };

export type McpAnswer =
  { readonly result: unknown } | { readonly error: { readonly code: number; readonly message: string } };

const latestProtocol = "2025-06-18";

const parameterOf = (parameters: unknown, name: string): unknown =>
  parameters && typeof parameters === "object" ? Reflect.get(parameters, name) : undefined;

const textOf = (value: unknown): string => (typeof value === "string" ? value : JSON.stringify(value));

export const createMcpAnswerer =
  (tools: readonly Tool[], version: string) =>
  async ({ method, params: parameters }: McpMessage): Promise<McpAnswer> => {
    switch (method) {
      case "initialize": {
        const requested = parameterOf(parameters, "protocolVersion");
        return {
          result: {
            protocolVersion: typeof requested === "string" ? requested : latestProtocol,
            capabilities: { tools: {} },
            serverInfo: { name: toolServerName, title: "Ito", version },
          },
        };
      }
      case "ping": {
        return { result: {} };
      }
      case "tools/list": {
        return {
          result: {
            tools: tools.map(({ name, title, description, inputSchema }) => ({
              name,
              title,
              description,
              inputSchema,
            })),
          },
        };
      }
      case "tools/call": {
        const name = parameterOf(parameters, "name");
        const tool = tools.find((candidate) => candidate.name === name);
        if (!tool) return { error: { code: -32_602, message: `Ito has no tool ${textOf(name)}.` } };
        const { text, isError = false, structured } = await tool.call(parameterOf(parameters, "arguments"));
        return {
          result: { content: [{ type: "text", text }], isError, ...(structured && { structuredContent: structured }) },
        };
      }
      default: {
        return { error: { code: -32_601, message: `Ito doesn't handle ${textOf(method)}.` } };
      }
    }
  };
