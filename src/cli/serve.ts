import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { demoInstalled, installed } from "#capabilities/installed.ts";
import type { Io } from "#cli/io.ts";
import { toPaths, type Paths } from "#cli/paths.ts";
import { tokenMessage } from "#cli/token.ts";
import { systemClock } from "#clock.ts";
import { createCodexEngine } from "#engine/codex/codex-engine.ts";
import { modelSetting } from "#engine/engine.ts";
import { demoAnswers, demoScripts, demoWork, withDemoPictures } from "#engine/scripted/demo.ts";
import { createScriptEngine } from "#engine/scripted/script-engine.ts";
import { createToken, hashToken, tokenSetting } from "#http/auth.ts";
import { onboardingSetting } from "#store/store.ts";
import { fail, ok, type Result } from "#result.ts";
import { createServer, type EngineContext, type ServerOptions } from "#server.ts";
import { createLocalEmbedder, wordEmbedder } from "#memory/embedder.ts";
import { createSidecarVoice, voiceDirectory, voiceModels } from "#voice/sidecar.ts";

export const defaultPort = 8787;

export const tailnetPort = 8443;

type EngineName = "codex" | "demo";

type ServeOptions = {
  readonly engine: EngineName;
  readonly port: number;
  readonly name: string;
  readonly onboarding: boolean;
};

const isEngineName = (name: string): name is EngineName => name === "codex" || name === "demo";

const toPort = (text: string): number | undefined => {
  const port = Number(text);
  return Number.isSafeInteger(port) && port >= 0 && port <= 65_535 ? port : undefined;
};

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const parseServeOptions = (flags: readonly string[]): Result<ServeOptions, string> => {
  try {
    const { values } = parseArgs({
      args: [...flags],
      options: {
        engine: { type: "string", default: "codex" },
        port: { type: "string", default: String(defaultPort) },
        name: { type: "string", default: os.hostname() },
        onboarding: { type: "boolean", default: false },
      },
    });
    const port = toPort(values.port);
    if (!isEngineName(values.engine)) return fail(`Unknown engine ${values.engine}: use codex or demo.`);
    return port === undefined
      ? fail(`${values.port} isn't a port number.`)
      : ok({ engine: values.engine, port, name: values.name, onboarding: values.onboarding });
  } catch (error) {
    return fail(describe(error));
  }
};

const toEngineFactory = (engine: EngineName, paths: Paths): ServerOptions["createEngine"] =>
  engine === "demo"
    ? ({ settings, callTool }: EngineContext) => {
        settings.setSetting(modelSetting, "demo");
        return createScriptEngine(systemClock, demoScripts, callTool, undefined, demoAnswers, demoWork(callTool));
      }
    : ({ settings, log, info, tools, instructions, inMind }: EngineContext) =>
        createCodexEngine({
          codexHome: paths.codexHome,
          workspace: paths.workspace,
          instructions,
          context: inMind,
          settings,
          log,
          info,
          tools,
        });

const firstRunMessage = (token: string, port: number): string =>
  [
    tokenMessage("Your token, shown once. Keep it like a password:", token),
    `Ito listens on http://127.0.0.1:${port}, on this machine only. To reach it from your phone over your tailnet:`,
    "",
    `  tailscale serve --bg --https=${tailnetPort} ${port}`,
    "",
    "Then add the server in Ari with the address Tailscale prints and this token, or run ito pair and scan its code.",
  ].join("\n");

export const serve = async (flags: readonly string[], io: Io): Promise<number> => {
  const parsed = parseServeOptions(flags);
  if (!parsed.ok) {
    io.printError(parsed.failure);
    return 1;
  }
  const { engine, port, name, onboarding } = parsed.value;
  const paths = toPaths(io.environment);
  const server = createServer({
    embedder: engine === "demo" ? wordEmbedder : createLocalEmbedder(path.join(paths.home, "models")),
    createVoice: (context) =>
      createSidecarVoice({ ...context, directory: voiceDirectory, models: voiceModels(paths.home) }),
    dataDirectory: paths.home,
    createEngine: toEngineFactory(engine, paths),
    name,
    capabilities: engine === "demo" ? demoInstalled : installed,
    ...(engine === "demo" && { fetch: withDemoPictures(fetch) }),
    logger: { level: "info", redact: ["req.headers.authorization"] },
  });
  if (engine === "demo" && !onboarding && server.store.setting(onboardingSetting) === undefined) {
    server.store.setSetting(onboardingSetting, JSON.stringify({ state: "done" }));
  }
  await server.app.listen({
    host: "127.0.0.1",
    port,
    listenTextResolver: (address) => `Ito is listening on ${address} with the ${engine} engine`,
  });
  if (server.store.setting(tokenSetting) === undefined) {
    if (io.isTerminal) {
      const token = createToken();
      server.store.setSetting(tokenSetting, hashToken(token));
      io.print(firstRunMessage(token, port));
    } else {
      io.print("No token yet: run ito token new in a terminal to make one.");
    }
  }
  if (!io.shutdown.aborted) await once(io.shutdown, "abort");
  await server.close();
  return 0;
};
