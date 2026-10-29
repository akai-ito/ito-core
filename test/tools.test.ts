import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCell } from "#cell.ts";
import { systemClock } from "#clock.ts";
import type { ToolServer } from "#engine/engine.ts";
import { demoScripts } from "#engine/scripted/demo.ts";
import { createScriptEngine } from "#engine/scripted/script-engine.ts";
import { wordEmbedder } from "#memory/embedder.ts";
import { createServer, type Server } from "#server.ts";

const home = mkdtempSync(path.join(os.tmpdir(), "ito-tools-"));

const statusOf = async (response: Promise<Response>): Promise<number> => {
  const { status } = await response;
  return status;
};

describe("Ito's tools over MCP", () => {
  const server = createCell<Server | undefined>(undefined);
  const tools = createCell<(() => ToolServer | undefined) | undefined>(undefined);

  const toolServer = (): ToolServer => {
    const current = tools.get()?.();
    if (!current) throw new Error("The tool server isn't listening.");
    return current;
  };

  const post = async (body: unknown, token = toolServer().token): Promise<Response> =>
    fetch(toolServer().url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });

  const rpc = async (method: string, parameters?: unknown): Promise<unknown> => {
    const response = await post({ jsonrpc: "2.0", id: 1, method, params: parameters });
    return response.json();
  };

  beforeAll(async () => {
    const started = createServer({
      embedder: wordEmbedder,
      dataDirectory: path.join(home, "server"),
      name: "test",
      createEngine: (context) => {
        tools.set(context.tools);
        return createScriptEngine(systemClock, demoScripts);
      },
    });
    await started.app.listen({ host: "127.0.0.1", port: 0 });
    server.set(started);
  });

  afterAll(async () => {
    await server.get()?.close();
    rmSync(home, { recursive: true, force: true });
  });

  it("answers only the session's token, and lists Ito's tools", async () => {
    expect(await statusOf(post({ jsonrpc: "2.0", id: 1, method: "tools/list" }, "ito_wrong"))).toBe(401);
    expect(await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {} })).toMatchObject({
      id: 1,
      result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "ito" } },
    });
    expect(await statusOf(post({ jsonrpc: "2.0", method: "notifications/initialized" }))).toBe(202);
    expect(await rpc("tools/list")).toMatchObject({
      result: {
        tools: [
          { name: "ask" },
          { name: "mark_topic" },
          { name: "keep_image" },
          { name: "recall" },
          { name: "read_page" },
          { name: "edit_page" },
          { name: "write_page" },
          { name: "forget_page" },
          { name: "page_history" },
          { name: "restore_page" },
          { name: "journal" },
          { name: "start_motion" },
          { name: "change_motion" },
          { name: "read_motion" },
          { name: "finish_motion" },
          { name: "restore_motion" },
          { name: "forget_motion" },
        ],
      },
    });
    const { url } = toolServer();
    expect(await statusOf(fetch(url))).toBe(405);
    expect(await rpc("resources/list")).toMatchObject({ error: { code: -32_601 } });
  });
});
