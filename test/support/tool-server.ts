import Fastify from "fastify";
import type { ToolServer } from "#engine/engine.ts";
import { registerTools, toolsPath } from "#http/tools.ts";
import type { Tool } from "#tools/mcp.ts";

export type RunningToolServer = { readonly server: ToolServer; readonly close: () => Promise<void> };

export const startToolServer = async (tools: readonly Tool[]): Promise<RunningToolServer> => {
  const token = "ito_tools_test";
  const app = Fastify();
  registerTools(app, { token, tools, version: "0.0.0" });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  if (!address || typeof address === "string") throw new Error("The tool server has no port.");
  return {
    server: { url: `http://127.0.0.1:${String(address.port)}${toolsPath}`, token },
    close: async () => {
      await app.close();
    },
  };
};
