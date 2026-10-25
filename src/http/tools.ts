import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { bearerToken, hashToken, isMatching } from "#http/auth.ts";
import type { Result } from "#result.ts";
import { createMcpAnswerer, type McpMessage, type Tool } from "#tools/mcp.ts";

export type Command = (capability: string, rest: readonly string[]) => Promise<Result<string, string>>;

export type ToolsOptions = {
  readonly token: string;
  readonly tools: () => readonly Tool[];
  readonly command: Command;
  readonly version: string;
};

export type CommandBody = { readonly capability: string; readonly arguments: readonly string[] };

export const toolsPath = "/mcp";

export const commandsPath = "/commands";

const isCommandBody = (body: unknown): body is CommandBody =>
  typeof body === "object" &&
  body !== null &&
  typeof Reflect.get(body, "capability") === "string" &&
  Array.isArray(Reflect.get(body, "arguments")) &&
  (Reflect.get(body, "arguments") as readonly unknown[]).every((word) => typeof word === "string");

const refuse = (reply: FastifyReply): FastifyReply => reply.code(401).send();

export const registerTools = (app: FastifyInstance, { token, tools, command, version }: ToolsOptions): void => {
  const expectedHash = hashToken(token);
  const answer = createMcpAnswerer(tools, version);
  const isAllowed = (request: FastifyRequest): boolean => {
    const given = bearerToken(request.headers.authorization);
    return given !== undefined && isMatching(given, expectedHash);
  };

  app.post<{ Body: McpMessage }>(toolsPath, async (request, reply) => {
    if (!isAllowed(request)) return refuse(reply);
    const message = request.body;
    return message.id === undefined || message.id === null
      ? reply.code(202).send()
      : { jsonrpc: "2.0", id: message.id, ...(await answer(message)) };
  });

  app.get(toolsPath, (_request, reply) => reply.code(405).header("allow", "POST").send());

  app.post(commandsPath, async (request, reply) => {
    if (!isAllowed(request)) return refuse(reply);
    if (!isCommandBody(request.body)) return reply.code(400).send({ text: "Send a capability and its arguments." });
    const ran = await command(request.body.capability, request.body.arguments);
    return ran.ok ? { text: ran.value } : reply.code(422).send({ text: ran.failure });
  });
};
