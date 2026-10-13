import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCell } from "#cell.ts";
import { toMessageId, toTurnId, type TurnId } from "#conversation/ids.ts";
import { createCodexEngine, threadSetting } from "#engine/codex/codex-engine.ts";
import type { Engine, EngineEvent, Input } from "#engine/engine.ts";
import type { Settings } from "#store/store.ts";
import { startMockModel, type MockModel } from "./support/mock-model.ts";

const home = mkdtempSync(path.join(os.tmpdir(), "ito-codex-"));
const codexHome = path.join(home, "codex");
const workspace = path.join(home, "workspace");
const hasManagedConfig = existsSync("/etc/codex/managed_config.toml");

const createMemorySettings = (): Settings => {
  const values = createCell<ReadonlyMap<string, string>>(new Map());
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
const turnCount = createCell(0);
const model = createCell<MockModel | undefined>(undefined);
const engine = createCell<Engine | undefined>(undefined);

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

const openEngine = (baseUrl: string): Engine =>
  createCodexEngine({
    codexHome,
    workspace,
    settings,
    log: collectLog,
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
  events.map((event) => event.type).filter((type, index, types) => type !== "text" || types[index - 1] !== "text");

describe("the Codex engine against the pinned codex app-server", () => {
  beforeAll(async () => {
    const started = await startMockModel();
    model.set(started);
    writeCodexConfig(started.baseUrl);
    engine.set(openEngine(started.baseUrl));
  });

  afterAll(async () => {
    await engine.get()?.close();
    await model.get()?.close();
    rmSync(home, { recursive: true, force: true });
  });

  it("streams thinking, a note and a reply, then ends the turn", async () => {
    const events = await runTurn("[[reply]] Plan my Saturday");
    expect(typesOf(events)).toEqual([
      "activity",
      "activity",
      "text.started",
      "text",
      "text.ended",
      "text.started",
      "text",
      "text.ended",
      "ended",
    ]);
    expect(events.slice(0, 2)).toEqual([
      { type: "activity", activity: { kind: "thinking" } },
      { type: "activity", activity: { kind: "thinking", heading: "Planning the answer" } },
    ]);
    expect(events.filter((event) => event.type === "text.started")).toEqual([
      { type: "text.started", kind: "note" },
      { type: "text.started", kind: "reply" },
    ]);
    expect(textOf(events)).toBe("Let me think about that.Here is the answer.");
    expect(progressCount.get()).toBeGreaterThan(0);
    expect(settings.setting(threadSetting)).toBeDefined();
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
    expect(events).toContainEqual({
      type: "activity",
      activity: { kind: "web_search", query: "breakfast by the river" },
    });
    expect(events.at(-1)).toEqual({ type: "ended" });
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
        settings: createMemorySettings(),
        log: collectLog,
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
    expect(logged.get()).toEqual([]);
  });
});
