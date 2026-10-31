import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { systemClock } from "#clock.ts";
import { toMessageId } from "#conversation/ids.ts";
import { demoAnswers, demoScripts, demoWork } from "#engine/scripted/demo.ts";
import { createScriptEngine } from "#engine/scripted/script-engine.ts";
import { hashToken, tokenSetting } from "#http/auth.ts";
import { wordEmbedder } from "#memory/embedder.ts";
import type { Onboarding } from "#protocol/types.ts";
import { createServer } from "#server.ts";

const home = mkdtempSync(path.join(os.tmpdir(), "ito-onboarding-"));
const token = "ito_onboarding_test_not_a_real_token_0000000000000000000";

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("getting started", () => {
  it("starts on a fresh box, shows what the demo found, takes a belief and finishes", async () => {
    const server = createServer({
      dataDirectory: home,
      name: "onboarding",
      embedder: wordEmbedder,
      timeZone: "UTC",
      createEngine: ({ callTool }) =>
        createScriptEngine(systemClock, demoScripts, callTool, undefined, demoAnswers, demoWork(callTool)),
    });
    server.store.setSetting(tokenSetting, hashToken(token));
    const call = (method: "GET" | "POST", url: string, payload?: Readonly<Record<string, unknown>>) =>
      server.app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, ...(payload && { payload }) });
    const onboarding = async (): Promise<Onboarding> => {
      const response = await call("GET", "/v0/onboarding");
      return response.json<Onboarding>();
    };
    await server.app.listen({ host: "127.0.0.1", port: 0 });
    try {
      const fresh = await onboarding();
      const freshSnapshot = server.store.snapshot("no_cursor").event.onboarding;
      const accepted = server.store.acceptMessage(toMessageId(randomUUID()), "Let's start");
      if (!accepted.ok) throw new Error(accepted.failure);
      server.turns.route(toMessageId(accepted.value.message.id), "Let's start");
      await vi.waitFor(
        async () => {
          const current = await onboarding();
          expect(current.state).toBe("ready");
        },
        { timeout: 15_000, interval: 100 },
      );
      const ready = await onboarding();
      const belief = ready.proposal?.beliefs[0]?.id ?? "none";
      const unknown = await call("POST", "/v0/onboarding/beliefs/n_nothing", { answer: "true" });
      const confirmed = await call("POST", `/v0/onboarding/beliefs/${belief}`, { answer: "true" });
      const finished = await call("POST", "/v0/onboarding/done");

      expect(fresh).toEqual({ state: "reading" });
      expect(freshSnapshot).toEqual({ state: "reading" });
      expect(ready.proposal).toMatchObject({
        beliefs: [{ text: "You're training for a sub-20 5K, with parkrun on Saturdays.", page: "memory:now" }],
        added: [{ title: "Flights to Valencia", calendar: { kumo: false } }],
        motions: [],
      });
      expect(unknown.statusCode).toBe(404);
      expect(confirmed.statusCode).toBe(202);
      expect(finished.json()).toEqual({ state: "done" });
      expect(server.store.snapshot("no_cursor").event.onboarding).toBeUndefined();
    } finally {
      await server.close();
    }
  });
});
