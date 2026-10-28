import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { LightMyRequestResponse } from "fastify";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { createCell } from "#cell.ts";
import { systemClock } from "#clock.ts";
import { demoScripts } from "#engine/scripted/demo.ts";
import { createScriptEngine } from "#engine/scripted/script-engine.ts";
import { hashToken, tokenSetting } from "#http/auth.ts";
import { wordEmbedder } from "#memory/embedder.ts";
import { createServer, type Server } from "#server.ts";
import { toWav } from "#voice/loop.ts";
import { createSidecarVoice, vocabularyFile, voicePython } from "#voice/sidecar.ts";

const home = mkdtempSync(path.join(os.tmpdir(), "ito-voice-"));
const token = "ito_voice_test_token_000000000000000000000000000000";
const sidecar = path.join(import.meta.dirname, "support", "voice", "sidecar.ts");
const servers = createCell<readonly Server[]>([]);

type Started = {
  readonly server: Server;
  readonly voice: string;
  readonly data: string;
  readonly statuses: () => readonly unknown[];
};

const installVoice = (behaviour: string): string => {
  const directory = mkdtempSync(path.join(home, "voice-"));
  const python = voicePython(directory);
  mkdirSync(path.dirname(python), { recursive: true });
  writeFileSync(python, `#!/bin/sh\nexec "${process.execPath}" "${sidecar}" "$@"\n`);
  chmodSync(python, 0o755);
  writeFileSync(path.join(directory, "behaviour"), behaviour);
  return directory;
};

const start = (voice: string): Started => {
  const data = mkdtempSync(path.join(home, "data-"));
  const server = createServer({
    embedder: wordEmbedder,
    dataDirectory: data,
    name: "test",
    createEngine: () => createScriptEngine(systemClock, demoScripts),
    createVoice: (context) => createSidecarVoice({ ...context, directory: voice, models: path.join(data, "models") }),
  });
  server.store.setSetting(tokenSetting, hashToken(token));
  servers.update((current) => [...current, server]);
  const seen = createCell<readonly unknown[]>([]);
  server.store.subscribe(({ event }) => {
    if (event.type !== "voice.status") return;
    const { state, reason } = event;
    seen.update((current) => [...current, reason === undefined ? { state } : { state, reason }]);
  });
  return { server, voice, data, statuses: () => seen.get() };
};

const listVoices = async (server: Server): Promise<{ readonly status: number; readonly body: unknown }> => {
  const response = await server.app.inject({
    method: "GET",
    url: "/v0/voices",
    headers: { authorization: `Bearer ${token}` },
  });
  return { status: response.statusCode, body: response.json() };
};

const readJson = (file: string): unknown => JSON.parse(readFileSync(file, "utf8"));

const speak = async (server: Server, payload: Readonly<Record<string, string>>): Promise<LightMyRequestResponse> =>
  server.app.inject({ method: "POST", url: "/v0/speech", headers: { authorization: `Bearer ${token}` }, payload });

const readLines = (file: string): readonly unknown[] =>
  readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as unknown);

afterEach(async () => {
  await Promise.all(servers.get().map((server) => server.close()));
  servers.set([]);
});

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("Ari's voice, from its sidecar", () => {
  it("wraps the sidecar's 16-bit PCM in a mono WAV header at its rate", () => {
    const wav = toWav(Uint8Array.from([1, 0, 255, 127]), 24_000);
    const view = new DataView(wav.buffer);

    expect(new TextDecoder().decode(wav.slice(0, 4))).toBe("RIFF");
    expect(new TextDecoder().decode(wav.slice(8, 16))).toBe("WAVEfmt ");
    expect([view.getUint16(20, true), view.getUint16(22, true), view.getUint32(24, true)]).toEqual([1, 1, 24_000]);
    expect([view.getUint32(28, true), view.getUint16(32, true), view.getUint16(34, true)]).toEqual([48_000, 2, 16]);
    expect([view.getUint32(4, true), view.getUint32(40, true)]).toEqual([40, 4]);
    expect([...wav.slice(44)]).toEqual([1, 0, 255, 127]);
  });

  it("is ready once the sidecar has memory's vocabulary, and says so once on the event stream", async () => {
    const { server, voice, data, statuses } = start(installVoice("ready"));

    await vi.waitFor(() => {
      expect(server.voice.readiness()).toEqual({ state: "ready" });
    });

    expect(statuses()).toEqual([{ state: "ready" }]);
    expect(readLines(path.join(voice, "vocabulary.log"))).toEqual([[]]);
    const environment = readJson(path.join(voice, "environment"));
    expect(readJson(vocabularyFile(data))).toEqual({ terms: [] });
    expect(environment).toContain("HF_HOME");
    expect(environment).not.toContain("ITO_HOME");
    await expect(listVoices(server)).resolves.toMatchObject({
      status: 200,
      body: { chosen: "af_heart", state: "ready" },
    });
  });

  it("says a preview in the chosen voice as a 24 kHz WAV", async () => {
    const { server, voice } = start(installVoice("ready"));
    await vi.waitFor(() => {
      expect(server.voice.readiness().state).toBe("ready");
    });
    const chosen = await server.app.inject({
      method: "PUT",
      url: "/v0/voice",
      headers: { authorization: `Bearer ${token}` },
      payload: { voice: "bm_george" },
    });

    const response = await speak(server, { text: "Hi, I'm Ari." });

    expect(chosen.json()).toEqual({ voice: "bm_george" });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("audio/wav");
    expect(new Uint8Array(response.rawPayload)).toEqual(toWav(Uint8Array.from([1, 0, 255, 127]), 24_000));
    expect(readLines(path.join(voice, "spoken.log"))).toEqual([{ text: "Hi, I'm Ari.", voice: "bm_george" }]);
  });

  it("gives the sidecar memory's vocabulary again when a call starts", async () => {
    const { server, voice } = start(installVoice("ready"));
    await vi.waitFor(() => {
      expect(server.voice.readiness().state).toBe("ready");
    });

    await server.app.inject({
      method: "PUT",
      url: "/v0/calls/9b2c6f0e-8d4a-4e8b-a7a1-2f1c3d5e6a7b",
      headers: { authorization: `Bearer ${token}` },
    });

    await vi.waitFor(() => {
      expect(readLines(path.join(voice, "vocabulary.log"))).toHaveLength(2);
    });
  });

  it("stays failed with the sidecar's reason, and refuses a preview with it", async () => {
    const { server, statuses } = start(installVoice("no-gpu"));
    const reason = "There's no NVIDIA GPU this box's PyTorch can use: no driver.";

    await vi.waitFor(() => {
      expect(server.voice.readiness()).toEqual({ state: "failed", reason });
    });
    const response = await speak(server, { text: "Hello." });

    expect(statuses()).toEqual([{ state: "failed", reason }]);
    expect(response.statusCode).toBe(503);
    expect(response.headers["retry-after"]).toBeUndefined();
    expect(response.json()).toEqual({
      error: { code: "unavailable", message: "Ari's voice isn't ready.", detail: reason },
    });
  });

  it("starts a sidecar that stopped again, and is ready after it", async () => {
    const { server, statuses } = start(installVoice("crash-once"));

    await vi.waitFor(
      () => {
        expect(server.voice.readiness()).toEqual({ state: "ready" });
      },
      { timeout: 10_000 },
    );

    expect(statuses()).toEqual([{ state: "ready" }]);
  });

  it("says how to install the voice when it isn't there", async () => {
    const { server } = start(mkdtempSync(path.join(home, "empty-")));

    await expect(listVoices(server)).resolves.toMatchObject({
      body: { state: "failed", reason: "The voice isn't installed on this box: run ito voice check." },
    });
  });

  it("refuses a sidecar that speaks another protocol", async () => {
    const { server } = start(installVoice("old"));

    await vi.waitFor(() => {
      expect(server.voice.readiness()).toEqual({
        state: "failed",
        reason: "The voice speaks protocol 0.0, and ito-core speaks 0.2: run ito voice check.",
      });
    });
  });

  it("stops the sidecar with the server", async () => {
    const { server, voice } = start(installVoice("ready"));
    await vi.waitFor(() => {
      expect(server.voice.readiness().state).toBe("ready");
    });
    const pid = Number(readFileSync(path.join(voice, "pid"), "utf8"));

    await server.close();

    expect(() => process.kill(pid, 0)).toThrow();
  });
});
