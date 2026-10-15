import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCell } from "#cell.ts";
import { toMessageId, toTurnId, type TurnId } from "#conversation/ids.ts";
import { createCodexEngine, threadSetting } from "#engine/codex/codex-engine.ts";
import type { Engine, EngineEvent, Input } from "#engine/engine.ts";
import { createGitHub } from "#reports/github.ts";
import { createReporter, reportsTokenSetting } from "#reports/reporter.ts";
import { createReportTool } from "#reports/tool.ts";
import type { Settings } from "#store/store.ts";
import { startFakeGitHub, type FakeGitHub } from "./support/fake-github.ts";
import { startMockModel, type MockModel } from "./support/mock-model.ts";
import { startToolServer, type RunningToolServer } from "./support/tool-server.ts";
import { createVirtualClock } from "./support/virtual-clock.ts";

const home = mkdtempSync(path.join(os.tmpdir(), "ito-codex-"));
const codexHome = path.join(home, "codex");
const workspace = path.join(home, "workspace");
const hasManagedConfig = existsSync("/etc/codex/managed_config.toml");
const instructions = "You are Ari, in a test.";

const createMemorySettings = (initial: ReadonlyMap<string, string> = new Map()): Settings => {
  const values = createCell(initial);
  return {
    setting: (key) => values.get().get(key),
    setSetting: (key, value) => {
      values.set(new Map([...values.get(), [key, value]]));
    },
  };
};

const settings = createMemorySettings();
const logged = createCell<readonly string[]>([]);
const progressCount = createCell(0);

const collectLog = (message: string, error: unknown): void => {
  logged.set([...logged.get(), `${message}: ${String(error)}`]);
};
const noted = createCell<readonly (readonly [string, Readonly<Record<string, unknown>>])[]>([]);
const collectInfo = (message: string, details: Readonly<Record<string, unknown>>): void => {
  noted.set([...noted.get(), [message, details]]);
};
const turnCount = createCell(0);
const model = createCell<MockModel | undefined>(undefined);
const engine = createCell<Engine | undefined>(undefined);
const github = createCell<FakeGitHub | undefined>(undefined);
const toolServer = createCell<RunningToolServer | undefined>(undefined);

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

const openEngine = (baseUrl: string, given = instructions): Engine =>
  createCodexEngine({
    codexHome,
    workspace,
    instructions: given,
    settings,
    log: collectLog,
    info: collectInfo,
    tools: () => toolServer.get()?.server,
    modelProvider: "mock",
    config: {
      model_providers: {
        mock: { name: "Mock", base_url: baseUrl, wire_api: "responses", request_max_retries: 0, stream_max_retries: 0 },
      },
    },
  });

const currentEngine = (): Engine => {
  const current = engine.get();
  if (!current) throw new Error("No engine is running.");
  return current;
};

const currentModel = (): MockModel => {
  const current = model.get();
  if (!current) throw new Error("No mock model is running.");
  return current;
};

const currentTurn = (): TurnId => toTurnId(`t_test_${String(turnCount.get())}`);

const toInput = (text: string): Input => ({ messageId: toMessageId(randomUUID()), text });

const runTurn = async (
  text: string,
  onEvent?: (event: EngineEvent) => Promise<void> | void,
): Promise<readonly EngineEvent[]> => {
  turnCount.update((count) => count + 1);
  const seen = createCell<readonly EngineEvent[]>([]);
  const events = currentEngine().start(currentTurn(), [toInput(text)]);
  for await (const event of events) {
    if (event.type === "progress") {
      progressCount.update((count) => count + 1);
      continue;
    }
    seen.set([...seen.get(), event]);
    await onEvent?.(event);
  }
  return seen.get();
};

const textOf = (events: readonly EngineEvent[]): string =>
  events.map((event) => (event.type === "text" ? event.text : "")).join("");

const typesOf = (events: readonly EngineEvent[]): readonly string[] =>
  events.map((event) => event.type).filter((type, index, types) => type !== types[index - 1]);

describe("the Codex engine against the pinned codex app-server", () => {
  beforeAll(async () => {
    const fake = await startFakeGitHub();
    github.set(fake);
    const reporter = createReporter({
      settings: createMemorySettings(new Map([[reportsTokenSetting, fake.token]])),
      clock: createVirtualClock(Date.parse("2026-10-15T12:00:00.000Z")),
      info: collectInfo,
      versions: { ito: "0.2.0", codex: "0.162.1" },
      connect: (token) =>
        createGitHub({ apiUrl: fake.apiUrl, repository: fake.repository, token, userAgent: "ito/test" }),
      dailyLimit: 20,
    });
    toolServer.set(await startToolServer([createReportTool(reporter, () => currentTurn())]));
    const started = await startMockModel();
    model.set(started);
    writeCodexConfig(started.baseUrl);
    engine.set(openEngine(started.baseUrl));
  });

  afterAll(async () => {
    await engine.get()?.close();
    await model.get()?.close();
    await toolServer.get()?.close();
    await github.get()?.close();
    rmSync(home, { recursive: true, force: true });
  });

  it("streams thinking, a note and a reply, then ends the turn", async () => {
    const events = await runTurn("[[reply]] Plan my Saturday");
    expect(typesOf(events)).toEqual([
      "step.started",
      "step.updated",
      "step.ended",
      "text.started",
      "text",
      "text.ended",
      "text.started",
      "text",
      "text.ended",
      "ended",
    ]);
    expect(events[0]).toMatchObject({ type: "step.started", kind: "thinking" });
    expect(events.findLast((event) => event.type === "step.updated")).toMatchObject({
      facts: { heading: "Planning the answer", summary: "**Planning the answer** Thinking it through. " },
    });
    expect(events.find((event) => event.type === "step.ended")).toMatchObject({ outcome: "completed" });
    expect(events.filter((event) => event.type === "text.started")).toEqual([
      { type: "text.started", kind: "note" },
      { type: "text.started", kind: "reply" },
    ]);
    expect(textOf(events)).toBe("Let me think about that.Here is the answer.");
    expect(progressCount.get()).toBeGreaterThan(0);
    expect(settings.setting(threadSetting)).toBeDefined();
    expect(currentModel().developerTexts()).toContain(instructions);
    expect(
      currentModel()
        .developerTexts()
        .filter((text) => text.includes("<multi_agent_role>") || text.includes("<skills_instructions>")),
    ).toEqual([]);
    expect(noted.get().map(([message]) => message)).toEqual(["Codex started a session for the conversation"]);
    expect(typeof noted.get()[0]?.[1].model).toBe("string");
  });

  it("takes a steer mid-message and reads it", async () => {
    const steer = toInput("STEER: keep it short");
    const outcome = createCell<string | undefined>(undefined);
    const events = await runTurn("[[slow]] Plan my Sunday", async (event) => {
      if (event.type !== "text" || outcome.get() !== undefined) return;
      outcome.set("pending");
      outcome.set(await currentEngine().steer(currentTurn(), steer));
    });
    expect(outcome.get()).toBe("taken");
    const read = events.findIndex((event) => event.type === "input.read");
    expect(events[read]).toEqual({ type: "input.read", messageId: steer.messageId });
    expect(events[read - 1]).toEqual({ type: "text.ended" });
    expect(textOf(events.slice(read))).toBe("Got it, wrapping up.");
    expect(events.at(-1)).toEqual({ type: "ended" });
  });

  it("stops when interrupted", async () => {
    const isInterrupted = createCell(false);
    const events = await runTurn("[[slow]] Write something long", async (event) => {
      if (event.type !== "text" || isInterrupted.get()) return;
      isInterrupted.set(true);
      await currentEngine().interrupt(currentTurn());
    });
    expect(events.at(-1)).toEqual({ type: "stopped" });
  });

  it("stops a turn interrupted before Codex has started it", async () => {
    turnCount.update((count) => count + 1);
    const events = currentEngine().start(currentTurn(), [toInput("[[slow]] Never mind")]);
    await currentEngine().interrupt(currentTurn());
    const seen = createCell<readonly EngineEvent[]>([]);
    for await (const event of events) seen.set([...seen.get(), event]);
    expect(seen.get().at(-1)).toEqual({ type: "stopped" });
  });

  it("reports a web search with its query", async () => {
    const events = await runTurn("[[search]] Find breakfast");
    expect(events).toContainEqual(expect.objectContaining({ type: "step.started", kind: "web_search" }));
    expect(events).toContainEqual(
      expect.objectContaining({ type: "step.ended", outcome: "completed", facts: { query: "breakfast by the river" } }),
    );
    expect(events.at(-1)).toEqual({ type: "ended" });
  });

  it("files a gap report through Ito's tool server, as a tool step with the issue's link", async () => {
    const events = await runTurn("[[report]] What time does the Battersea parkrun start?");
    const reportStarted = events.find((event) => event.type === "step.started" && event.kind === "tool");
    expect(reportStarted).toMatchObject({ facts: { capability: "ito", operation: "report_gap" } });
    const reportEnded = events.find(
      (event) =>
        event.type === "step.ended" && reportStarted?.type === "step.started" && event.key === reportStarted.key,
    );
    const issue = `https://github.com/akai-ito/ito-core/issues/1`;
    expect(reportEnded).toMatchObject({ outcome: "completed", facts: { url: issue } });
    expect(textOf(events)).toBe("Most parkruns start at 9:00, and I've reported that.");
    expect(
      github
        .get()
        ?.issues()
        .map(({ title }) => title),
    ).toEqual(["Gap: web search · open a page"]);
  });

  it("maps a usage limit to usage_limit", async () => {
    const events = await runTurn("[[usage]] Again");
    expect(events.at(-1)).toMatchObject({ type: "failed", code: "usage_limit" });
  });

  it("maps a rejected sign-in to engine_signed_out", async () => {
    const events = await runTurn("[[signedout]] Are you there?");
    expect(events.at(-1)).toMatchObject({ type: "failed", code: "engine_signed_out" });
  });

  it("maps a model failure to model_unavailable", async () => {
    const events = await runTurn("[[failure]] Once more");
    expect(events.at(-1)).toMatchObject({ type: "failed", code: "model_unavailable" });
  });

  it.skipIf(hasManagedConfig)(
    "fails a turn as signed out before calling the model when no one is signed in",
    async () => {
      const signedOutHome = path.join(home, "signed-out");
      const signedOutEngine = createCodexEngine({
        codexHome: signedOutHome,
        workspace,
        instructions,
        settings: createMemorySettings(),
        log: collectLog,
        info: collectInfo,
      });
      const events = signedOutEngine.start(toTurnId("t_signed_out"), [toInput("Hello?")]);
      const seen = createCell<readonly EngineEvent[]>([]);
      for await (const event of events) seen.set([...seen.get(), event]);
      await signedOutEngine.close();
      expect(seen.get()).toEqual([
        { type: "failed", code: "engine_signed_out", detail: "Codex has no account signed in." },
      ]);
    },
  );

  it("resumes the same thread after a restart", async () => {
    const thread = settings.setting(threadSetting);
    await currentEngine().restart();
    const events = await runTurn("[[reply]] Still there?");
    expect(events.at(-1)).toEqual({ type: "ended" });
    expect(settings.setting(threadSetting)).toBe(thread);
    const [message, details] = noted.get().at(-1) ?? [];
    expect(message).toBe("Codex resumed the conversation's session");
    expect(typeof details?.model).toBe("string");
    expect(logged.get()).toEqual([]);
  });

  it("resumes the same thread with new instructions", async () => {
    const thread = settings.setting(threadSetting);
    const changed = "You are Ari, with new instructions.";
    await currentEngine().close();
    engine.set(openEngine(currentModel().baseUrl, changed));
    const events = await runTurn("[[reply]] Anything new?");
    expect(events.at(-1)).toEqual({ type: "ended" });
    expect(settings.setting(threadSetting)).toBe(thread);
    expect(currentModel().developerTexts()).toContain(changed);
    expect(currentModel().developerTexts()).not.toContain(instructions);
    expect(logged.get()).toEqual([]);
  });
});
