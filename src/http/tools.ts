import type { FastifyInstance } from "fastify";
import { bearerToken, hashToken, isMatching } from "#http/auth.ts";
import { createMcpAnswerer, type McpMessage, type Tool } from "#tools/mcp.ts";

export type ToolsOptions = { readonly token: string; readonly tools: readonly Tool[]; readonly version: string };

export const toolsPath = "/mcp";

export const registerTools = (app: FastifyInstance, { token, tools, version }: ToolsOptions): void => {
  const expectedHash = hashToken(token);
  const answer = createMcpAnswerer(tools, version);

  app.post<{ Body: McpMessage }>(toolsPath, async (request, reply) => {
    const given = bearerToken(request.headers.authorization);
    if (!given || !isMatching(given, expectedHash)) return reply.code(401).send();
    const message = request.body;
    return message.id === undefined || message.id === null
      ? reply.code(202).send()
      : { jsonrpc: "2.0", id: message.id, ...(await answer(message)) };
  });

  app.get(toolsPath, (_request, reply) => reply.code(405).header("allow", "POST").send());
};
