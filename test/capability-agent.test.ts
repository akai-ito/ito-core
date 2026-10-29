import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createCell } from "#cell.ts";
import { toMessageId } from "#conversation/ids.ts";
import { onSetting, valuesSetting } from "#capabilities/host.ts";
import { findInstalled } from "#capabilities/installed.ts";
import { systemClock } from "#clock.ts";
import { createCodexEngine } from "#engine/codex/codex-engine.ts";
import { hashToken, tokenSetting } from "#http/auth.ts";
import { randomIdentifiers } from "#identifiers.ts";
import type { Step } from "#protocol/types.ts";
import { createServer, databaseFile, type Server } from "#server.ts";
import { openDatabase } from "#store/database.ts";
import { createStore } from "#store/store.ts";
import { startMockModel, type MockModel } from "./support/mock-model.ts";
import { wordEmbedder } from "#memory/embedder.ts";

const home = mkdtempSync(path.join(os.tmpdir(), "ito-capability-agent-"));
const codexHome = path.join(home, "codex");
const token = "ito_capability_agent_test_token_0000000000000000000";
const launcher = path.join(home, "bin", "ito");
const model = createCell<MockModel | undefined>(undefined);
const server = createCell<Server | undefined>(undefined);

const currentServer = (): Server => {
  const current = server.get();
  if (!current) throw new Error("No server is running.");
  return current;
};

const currentModel = (): MockModel => {
  const current = model.get();
  if (!current) throw new Error("No mock model is running.");
  return current;
};

const seed = (): void => {
  const store = createStore(openDatabase(databaseFile(home)), systemClock, randomIdentifiers);
  store.setSetting(tokenSetting, hashToken(token));
  store.setSetting(onSetting("echo"), "true");
  store.setSetting(valuesSetting("echo"), JSON.stringify({ token: "secret-1" }));
  store.close();
};

const writeCodexConfig = (baseUrl: string): void => {
  mkdirSync(codexHome, { recursive: true });
  writeFileSync(
    path.join(codexHome, "config.toml"),
    [
      'model_provider = "mock"',
      `openai_base_url = "${baseUrl}"`,
      "",
      "[model_providers.mock]",
      'name = "Mock"',
      `base_url = "${baseUrl}"`,
      'wire_api = "responses"',
      "request_max_retries = 0",
      "stream_max_retries = 0",
      "",
    ].join("\n"),
  );
};

const send = async (text: string): Promise<readonly Step[]> => {
  const { app, store } = currentServer();
  const before = new Set(store.snapshot("no_cursor").event.steps.map((step) => step.id));
  const response = await app.inject({
    method: "POST",
    url: "/v0/messages",
    headers: { authorization: `Bearer ${token}` },
    payload: { id: randomUUID(), text },
  });
  expect(response.statusCode).toBe(201);
  await vi.waitFor(
    () => {
      expect(store.runningTurn()).toBeUndefined();
      expect(store.pendingWork()).toEqual([]);
    },
    { timeout: 20_000, interval: 100 },
  );
  return store.snapshot("no_cursor").event.steps.filter((step) => !before.has(step.id));
};

describe("capabilities, through the pinned Codex", () => {
  beforeAll(async () => {
    seed();
    const started = await startMockModel();
    model.set(started);
    writeCodexConfig(started.baseUrl);
    const created = createServer({
      embedder: wordEmbedder,
      dataDirectory: home,
      name: "test",
      capabilities: findInstalled(path.join(import.meta.dirname, "support", "capabilities")).filter(
        ({ id }) => id === "echo",
      ),
      createEngine: ({ settings, log, info, tools, skills, inMind }) =>
        createCodexEngine({
          codexHome,
          workspace: path.join(home, "workspace"),
          instructions: () => `You are Ari, in a test.${skills()}`,
          context: inMind,
          settings,
          log,
          info,
          tools,
          modelProvider: "mock",
          config: {
            model_providers: {
              mock: {
                name: "Mock",
                base_url: started.baseUrl,
                wire_api: "responses",
                request_max_retries: 0,
                stream_max_retries: 0,
              },
            },
          },
        }),
    });
    server.set(created);
    await created.app.listen({ host: "127.0.0.1", port: 0 });
    await created.host.ready;
  });

  afterAll(async () => {
    await server.get()?.close();
    await model.get()?.close();
    rmSync(home, { recursive: true, force: true });
  });

  it("gives the agent a capability's tool, its commands and its skill, and shows both doors as its operation", async () => {
    const steps = await send(
      `[[code]] text(JSON.stringify(await tools.mcp__ito__echo_say({ text: "hi" })));\n` +
        `text((await tools.exec_command({ cmd: "${launcher} echo say --text 'from the shell'" })).output);`,
    );

    expect(
      steps.map(({ kind, capability, operation, title, outcome }) => ({ kind, capability, operation, title, outcome })),
    ).toEqual([
      { kind: "tool", capability: "echo", operation: "say", title: "Echoed", outcome: "completed" },
      { kind: "tool", capability: "echo", operation: "say", title: "Echoed", outcome: "completed" },
    ]);
    expect(currentModel().toolOutputs().join("\n")).toContain("hi");
    expect(currentModel().toolOutputs().join("\n")).toContain("from the shell");
    const skill = path.join(home, "skills", "echo", "SKILL.md");
    expect(currentModel().developerTexts().join("\n")).toContain(`- echo: Says back what it's given. (file: ${skill})`);
    expect(readFileSync(skill, "utf8")).toContain(`${launcher} echo say: Says the text back.`);
  });

  it("takes a capability away from the agent once it's switched off", async () => {
    await currentServer().host.switchTo("echo", false);

    await send(`[[code]] text(String(typeof tools.mcp__ito__echo_say));`);

    const developerText = currentModel().developerTexts().join("\n");
    const latestInstructions = developerText.slice(developerText.lastIndexOf("<model_instructions>"));
    expect(currentModel().toolOutputs().join("\n")).toContain("undefined");
    expect(latestInstructions).toContain("You are Ari, in a test.");
    expect(latestInstructions).not.toContain("- echo:");
    expect(existsSync(launcher)).toBe(true);
  });

  it("tells the agent a call is on, and when it has ended", async () => {
    const call = randomUUID();
    currentServer().store.startCall(call);
    await send("[[reply]] Can you hear me?");
    const during = currentModel().developerTexts().join("\n");
    currentServer().store.endCall(call);
    await send("[[reply]] Back at my desk.");
    const after = currentModel().developerTexts().join("\n");

    expect(during).toContain("You're on a call.");
    expect(after.slice(after.lastIndexOf("<call>"))).toContain("The call has ended, so they're reading the chat.");
  });

  it("shows the agent which words were corrected in a spoken message", async () => {
    const { store, turns } = currentServer();
    const call = randomUUID();
    store.startCall(call);
    const text = "[[reply]] What did Bora say about the QRT panel?";
    const message = toMessageId(randomUUID());

    const accepted = store.acceptMessage(message, text, undefined, [], {
      call,
      corrections: [
        { offset: text.indexOf("Bora"), length: 4, heard: "Bara" },
        { offset: text.indexOf("QRT"), length: 3, heard: "cutie" },
      ],
    });
    turns.route(message, text);
    await vi.waitFor(
      () => {
        expect(store.runningTurn()).toBeUndefined();
        expect(currentModel().userTexts().at(-1)).toContain("Bora");
      },
      { timeout: 20_000, interval: 100 },
    );
    store.endCall(call);

    expect(accepted.ok).toBe(true);
    expect(currentModel().userTexts().at(-1)).toBe(
      `${text}\n\n(Spoken. Words corrected from what was heard: heard “Bara”, wrote Bora; heard “cutie”, wrote QRT. ` +
        "Either could be right.)",
    );
  });
});
